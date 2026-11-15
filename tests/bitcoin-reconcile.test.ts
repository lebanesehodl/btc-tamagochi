import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BlockMetadata, BlockSource, ChainTransition } from "../src/shared/bitcoin.js";
import { BitcoinDataError, mealForBlock, parseBlockMetadata, reconcileChain } from "../src/server/bitcoin/index.js";
import fixture from "./fixtures/blocks/backward-timestamps.json";

// Deliberately synthetic hashes: these tests validate bookkeeping, NOT consensus/PoW.
const hash = (label: string): string => createHash("sha256").update(label).digest("hex");
function extend(anchor: BlockMetadata, count: number, branch = "main"): BlockMetadata[] {
  const blocks: BlockMetadata[] = [];
  let parent = anchor;
  for (let offset = 1; offset <= count; offset++) {
    const height = anchor.height + offset;
    const block = { id: hash(`${branch}:${height}`), height, previousblockhash: parent.id, timestamp: 1_700_000_000 + height };
    blocks.push(block);
    parent = block;
  }
  return blocks;
}
const anchor: BlockMetadata = { id: hash("anchor"), height: 100, previousblockhash: hash("before-anchor"), timestamp: 1_700_000_100 };
function chain(count: number): BlockMetadata[] { return [anchor, ...extend(anchor, count)]; }

class MemorySource implements BlockSource {
  blocks = new Map<string, BlockMetadata>();
  constructor(public active: BlockMetadata[]) { this.setChain(active); }
  setChain(active: BlockMetadata[]): void {
    this.active = active;
    for (const block of active) this.blocks.set(block.id, block);
  }
  async getTipHash(): Promise<string> { return this.active.at(-1)!.id; }
  async getHashByHeight(height: number): Promise<string> {
    const block = this.active.find((candidate) => candidate.height === height);
    if (!block) throw new BitcoinDataError("http-error", "Missing height.", 404);
    return block.id;
  }
  async getBlockByHash(id: string): Promise<BlockMetadata> {
    const block = this.blocks.get(id);
    if (!block) throw new BitcoinDataError("http-error", "Missing block.", 404);
    return { ...block };
  }
}

/** Test-only model. Production exactly-once application belongs to the transactional world. */
function apply(current: BlockMetadata[], change: ChainTransition): BlockMetadata[] {
  const next = [...current];
  for (const block of change.disconnect) {
    expect(next.pop()!.id).toBe(block.id);
  }
  for (const block of change.connect) {
    expect(block.previousblockhash).toBe(next.at(-1)!.id);
    next.push(block);
  }
  return next;
}

describe("active-chain reconciliation", () => {
  it("returns no effects for a duplicate tip and never mutates input", async () => {
    const saved = chain(3);
    const original = structuredClone(saved);
    const source = new MemorySource(saved);
    expect(await reconcileChain(source, saved)).toEqual({ disconnect: [], connect: [] });
    expect(saved).toEqual(original);
  });

  it("recovers every missed block in height/parent order rather than awarding only the newest", async () => {
    const active = chain(5);
    const saved = [anchor];
    const transition = await reconcileChain(new MemorySource(active), saved);
    expect(transition.disconnect).toEqual([]);
    expect(transition.connect).toEqual(active.slice(1));
    const next = apply(saved, transition);
    expect(next).toEqual(active);
    expect(await reconcileChain(new MemorySource(active), next)).toEqual({ disconnect: [], connect: [] });
  });

  it("bounds catch-up work even when far behind, and resumes across batches", async () => {
    const active = chain(50);
    const source = new MemorySource(active);
    const read = vi.spyOn(source, "getBlockByHash");
    let saved = [anchor];
    const seenMeals: string[] = [];
    while (saved.length < active.length) {
      read.mockClear();
      const transition = await reconcileChain(source, saved, { maxBatchBlocks: 3 });
      expect(transition.connect.length).toBeLessThanOrEqual(3);
      expect(read.mock.calls.length).toBeLessThanOrEqual(4); // tip plus at most 3 batch blocks
      seenMeals.push(...transition.connect.map((block) => mealForBlock(block).blockHash));
      saved = apply(saved, transition);
    }
    expect(saved).toEqual(active);
    expect(seenMeals).toHaveLength(50);
    expect(new Set(seenMeals).size).toBe(50);
  });

  it("bounds total source requests during combined catch-up and reorg", async () => {
    const saved = chain(5);
    const source = new MemorySource([anchor, ...extend(anchor, 10, "fork")]);
    const tips = vi.spyOn(source, "getTipHash");
    const blocks = vi.spyOn(source, "getBlockByHash");
    const heights = vi.spyOn(source, "getHashByHeight");
    const transition = await reconcileChain(source, saved, { maxBatchBlocks: 2, maxReorgDepth: 5 });
    expect(transition.disconnect).toHaveLength(5);
    expect(transition.connect).toHaveLength(2);
    expect(tips.mock.calls.length + blocks.mock.calls.length + heights.mock.calls.length).toBeLessThanOrEqual(5 + 2 + 6);
  });

  it("replaces a same-height fork: disconnect high-to-low, connect low-to-high", async () => {
    const saved = chain(5);
    const fork = [...saved.slice(0, 3), ...extend(saved[2]!, 3, "fork")];
    const transition = await reconcileChain(new MemorySource(fork), saved);
    expect(transition.disconnect).toEqual(saved.slice(3).reverse());
    expect(transition.connect).toEqual(fork.slice(3));
    expect(apply(saved, transition)).toEqual(fork);
  });

  it("can reconnect a previously disconnected hash, rather than deduplicating it forever", async () => {
    const original = chain(3);
    const fork = [...original.slice(0, 2), ...extend(original[1]!, 2, "fork")];
    const source = new MemorySource(original);
    source.setChain(fork);
    const first = await reconcileChain(source, original);
    const onFork = apply(original, first);
    source.setChain(original);
    const second = await reconcileChain(source, onFork);
    expect(second.connect).toEqual(original.slice(2));
    const restored = apply(onFork, second);
    expect(restored).toEqual(original);
    expect(await reconcileChain(source, restored)).toEqual({ disconnect: [], connect: [] });
  });

  it("supports a reorg replacement in bounded batches", async () => {
    const saved = chain(6);
    const fork = [anchor, ...extend(anchor, 8, "fork")];
    const source = new MemorySource(fork);
    const first = await reconcileChain(source, saved, { maxBatchBlocks: 2 });
    expect(first.disconnect).toHaveLength(6);
    expect(first.connect).toEqual(fork.slice(1, 3));
    let next = apply(saved, first);
    while (next.length < fork.length) {
      next = apply(next, await reconcileChain(source, next, { maxBatchBlocks: 2 }));
    }
    expect(next).toEqual(fork);
  });

  it("accepts the historical backward-timestamp child and produces exactly one new meal", async () => {
    const [parent, child] = fixture.map(parseBlockMetadata) as [BlockMetadata, BlockMetadata];
    expect(parent.height).toBe(975858);
    expect(child.height).toBe(975859);
    expect(parent.timestamp - child.timestamp).toBe(159);
    expect(child.previousblockhash).toBe(parent.id);
    const source = new MemorySource([parent, child]);
    const transition = await reconcileChain(source, [parent]);
    expect(transition.disconnect).toEqual([]);
    expect(transition.connect).toEqual([child]);
    expect(transition.connect.map((block) => mealForBlock(block))).toEqual([{
      blockHash: child.id, height: 975859, foodId: "honey-toast", pantryVersion: "generic-v1",
    }]);
    expect(await reconcileChain(source, apply([parent], transition))).toEqual({ disconnect: [], connect: [] });
  });

  it("fails closed on missing parent metadata without changing the saved chain", async () => {
    const active = chain(3);
    const source = new MemorySource(active);
    source.blocks.delete(active[2]!.id);
    const saved = [anchor];
    await expect(reconcileChain(source, saved)).rejects.toMatchObject({ code: "http-error" });
    expect(saved).toEqual([anchor]);
  });

  it("rejects disconnected metadata, even if all fields look individually well formed", async () => {
    const active = chain(1);
    const wrong = { ...active[1]!, previousblockhash: hash("not-anchor") };
    const source = new MemorySource([anchor, wrong]);
    await expect(reconcileChain(source, [anchor])).rejects.toMatchObject({ code: "source-changed" });
  });

  it("rejects a fetched block with the wrong hash or height", async () => {
    const active = chain(3);
    for (const patch of [{ id: hash("wrong-id") }, { height: 77 }]) {
      const source = new MemorySource(active);
      source.blocks.set(active[2]!.id, { ...active[2]!, ...patch });
      await expect(reconcileChain(source, [anchor])).rejects.toMatchObject({ code: "invalid-response" });
    }
  });

  it("rejects changed metadata at an identical saved hash", async () => {
    const saved = chain(1);
    const source = new MemorySource(saved);
    source.blocks.set(saved[1]!.id, { ...saved[1]!, timestamp: 0 });
    await expect(reconcileChain(source, saved)).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("retries rather than returning changes when the source tip moves mid-snapshot", async () => {
    const active = chain(2);
    const source = new MemorySource(active);
    vi.spyOn(source, "getTipHash").mockResolvedValueOnce(active[2]!.id).mockResolvedValueOnce(hash("different-tip"));
    await expect(reconcileChain(source, [anchor])).rejects.toMatchObject({ code: "source-changed" });
  });

  it("rejects a stale height index during catch-up even if the reported tip is unchanged", async () => {
    const active = chain(5);
    const source = new MemorySource(active);
    const original = source.getHashByHeight.bind(source);
    let reads = 0;
    vi.spyOn(source, "getHashByHeight").mockImplementation(async (height) => {
      if (height === 102 && ++reads === 2) return hash("stale-height-index");
      return original(height);
    });
    await expect(reconcileChain(source, [anchor], { maxBatchBlocks: 2 })).rejects.toMatchObject({ code: "source-changed" });
  });

  it("pauses on a shorter source tip instead of letting a lagging provider erase meals", async () => {
    const saved = chain(5);
    await expect(reconcileChain(new MemorySource(saved.slice(0, 3)), saved)).rejects.toMatchObject({ code: "source-behind" });
    expect(saved).toHaveLength(6);
  });

  it("pauses when the common ancestor is beyond retained history or the reorg budget", async () => {
    const saved = chain(5);
    const fork = [anchor, ...extend(anchor, 5, "deep-fork")];
    const source = new MemorySource(fork);
    const lookup = vi.spyOn(source, "getHashByHeight");
    await expect(reconcileChain(source, saved, { maxReorgDepth: 1 })).rejects.toMatchObject({ code: "baseline-unavailable" });
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(2);
    await expect(reconcileChain(source, saved.slice(2))).rejects.toMatchObject({ code: "baseline-unavailable" });
  });

  it("handles an outage without a fallback timer-generated meal", async () => {
    const source = new MemorySource(chain(3));
    vi.spyOn(source, "getTipHash").mockRejectedValue(new BitcoinDataError("timeout", "Timed out."));
    const saved = [anchor];
    await expect(reconcileChain(source, saved)).rejects.toMatchObject({ code: "timeout" });
    expect(saved).toEqual([anchor]);
  });

  it("requires an explicit baseline, not an implicit replay since genesis", async () => {
    await expect(reconcileChain(new MemorySource(chain(1)), [])).rejects.toMatchObject({ code: "missing-baseline" });
  });

  it("rejects gaps, duplicates, and reverse ordering in saved history before source I/O", async () => {
    const saved = chain(3);
    const source = new MemorySource(saved);
    const tip = vi.spyOn(source, "getTipHash");
    for (const bad of [[saved[0]!, saved[2]!], [...saved].reverse(), [saved[0]!, saved[0]!]]) {
      await expect(reconcileChain(source, bad)).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect(tip).not.toHaveBeenCalled();
  });

  it.each([{ maxBatchBlocks: 0 }, { maxBatchBlocks: 1001 }, { maxReorgDepth: -1 }, { maxReorgDepth: 0.5 }, { maxReorgDepth: 1001 }])(
    "rejects unsafe work budgets", async (options) => {
      await expect(reconcileChain(new MemorySource(chain(1)), [anchor], options)).rejects.toMatchObject({ code: "invalid-input" });
    },
  );
});
