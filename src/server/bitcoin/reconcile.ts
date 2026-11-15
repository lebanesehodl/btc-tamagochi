import type { BlockMetadata, BlockSource, ChainTransition } from "../../shared/bitcoin.js";
import { BitcoinDataError, boundedInteger, parseBlockMetadata, requireBlockHash } from "./validation.js";

export interface ReconcileOptions {
  /** Maximum replacement/forward blocks in one atomic world update (default 24). */
  maxBatchBlocks?: number;
  /** Safety/work budget, NOT a Bitcoin finality rule (default 144). */
  maxReorgDepth?: number;
}

async function blockByHash(source: BlockSource, hash: string): Promise<BlockMetadata> {
  const block = parseBlockMetadata(await source.getBlockByHash(hash));
  if (block.id !== hash) {
    throw new BitcoinDataError("invalid-response", "Block response does not match its requested hash.");
  }
  return block;
}

/**
 * Plan a transition from a retained, ascending, contiguous active-chain suffix.
 * The oldest retained block is an anchor, never silently discarded. No state is mutated.
 * Callers must fence the worker and compare the original cursor inside the DB transaction.
 * An empty history must first be initialized to an observed tip (without back-awarding meals).
 */
export async function reconcileChain(
  source: BlockSource,
  retainedBlocksAscending: readonly BlockMetadata[],
  options: ReconcileOptions = {},
): Promise<ChainTransition> {
  const maxBatchBlocks = boundedInteger(options.maxBatchBlocks ?? 24, 1000, "catch-up batch");
  const maxReorgDepth = options.maxReorgDepth ?? 144;
  if (!Number.isSafeInteger(maxReorgDepth) || maxReorgDepth < 0 || maxReorgDepth > 1000) {
    throw new BitcoinDataError("invalid-input", "Invalid reorg depth limit.");
  }
  if (retainedBlocksAscending.length === 0) {
    throw new BitcoinDataError("missing-baseline", "Initialize a chain baseline before reconciling.");
  }
  const retained = retainedBlocksAscending.map(parseBlockMetadata);
  const seen = new Set<string>();
  for (let i = 0; i < retained.length; i++) {
    const block = retained[i]!;
    const previous = retained[i - 1];
    if (seen.has(block.id) || (previous !== undefined
      && (block.height !== previous.height + 1 || block.previousblockhash !== previous.id))) {
      throw new BitcoinDataError("invalid-input", "Retained blocks are not a contiguous ascending chain.");
    }
    seen.add(block.id);
  }
  const current = retained.at(-1)!;
  const tipHash = requireBlockHash(await source.getTipHash());
  const tip = await blockByHash(source, tipHash);
  // A stale explorer can report a shorter chain. Without chainwork validation, don't erase progress.
  // This also pauses an unusual legitimate shorter, higher-work fork for explicit recovery.
  if (tip.height < current.height) {
    throw new BitcoinDataError("source-behind", "Source tip is below the saved cursor; recovery is required.");
  }
  if (tipHash === current.id) {
    if (tip.height !== current.height || tip.previousblockhash !== current.previousblockhash
      || tip.timestamp !== current.timestamp) {
      throw new BitcoinDataError("invalid-response", "Source changed metadata for an existing block hash.");
    }
    return { disconnect: [], connect: [] };
  }

  let ancestorIndex = -1;
  const firstAllowedIndex = Math.max(0, retained.length - 1 - maxReorgDepth);
  for (let i = retained.length - 1; i >= firstAllowedIndex; i--) {
    const candidate = retained[i]!;
    const canonical = candidate.height === tip.height
      ? tipHash : requireBlockHash(await source.getHashByHeight(candidate.height));
    if (canonical === candidate.id) {
      ancestorIndex = i;
      break;
    }
  }
  if (ancestorIndex < 0) {
    throw new BitcoinDataError("baseline-unavailable", "No common ancestor within retained history and the reorg budget.");
  }
  const ancestor = retained[ancestorIndex]!;
  const endHeight = Math.min(tip.height, ancestor.height + maxBatchBlocks);
  const endHash = endHeight === tip.height
    ? tipHash : requireBlockHash(await source.getHashByHeight(endHeight));
  let cursor = endHeight === tip.height ? tip : await blockByHash(source, endHash);
  const descending: BlockMetadata[] = [];
  for (let height = endHeight; height > ancestor.height; height--) {
    if (cursor.height !== height || cursor.previousblockhash === null) {
      throw new BitcoinDataError("invalid-response", "Source blocks are missing or have inconsistent heights.");
    }
    descending.push(cursor);
    if (height === ancestor.height + 1) {
      if (cursor.previousblockhash !== ancestor.id) {
        throw new BitcoinDataError("source-changed", "Source branch no longer connects to the selected ancestor.");
      }
    } else {
      cursor = await blockByHash(source, cursor.previousblockhash);
    }
  }

  // Catch height-index races and changes of tip during the multi-request snapshot.
  // A later reorg remains possible; the next reconciliation must handle it normally.
  const finalEndHash = requireBlockHash(await source.getHashByHeight(endHeight));
  const finalTipHash = requireBlockHash(await source.getTipHash());
  if (finalEndHash !== endHash || finalTipHash !== tipHash) {
    throw new BitcoinDataError("source-changed", "Source chain changed during reconciliation; retry without applying effects.");
  }
  return {
    disconnect: retained.slice(ancestorIndex + 1).reverse(),
    connect: descending.reverse(),
  };
}
