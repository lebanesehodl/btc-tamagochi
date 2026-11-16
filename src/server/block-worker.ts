import crypto from "node:crypto";
import { EsploraBlockSource, GENERIC_PANTRY, BitcoinDataError, mealForBlock, reconcileChain } from "./bitcoin/index.ts";
import type { AppConfig } from "./config.ts";
import { WorldRepository } from "./world/repository.ts";
import type { AppliedBlock } from "../shared/world.ts";
import type { BlockSource } from "../shared/bitcoin.ts";
import { acquireWorkerLease, type WorkerLease } from "./worker-lease.ts";
import type { WorkerLike } from "./app.ts";
import { HttpError } from "./world/errors.ts";

export class BlockWorker implements WorkerLike {
  private readonly owner = crypto.randomUUID();
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private lease: WorkerLease | null = null;
  private renewing = false;
  private needsStoryBoundary = true;
  private readonly source: BlockSource;

  constructor(
    private readonly repository: WorldRepository,
    private readonly config: AppConfig,
    source?: BlockSource,
  ) {
    this.source = source ?? new EsploraBlockSource({ baseUrl: config.blockApiBaseUrl });
    this.repository.beginChainObservation();
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.schedule(), this.config.pollIntervalMs);
    this.timer.unref();
    this.renewalTimer = setInterval(() => { void this.renew(); }, 5_000);
    this.renewalTimer.unref();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    this.timer = null;
    this.renewalTimer = null;
    await this.running;
  }

  private schedule(): void {
    if (this.running || this.stopped) return;
    this.running = this.tick().catch(async (error) => {
      const message = error instanceof BitcoinDataError ? `${error.code}: ${error.message}` : "Unexpected block-worker failure";
      const paused = error instanceof BitcoinDataError && ["baseline-unavailable", "source-behind"].includes(error.code);
      this.needsStoryBoundary = true;
      this.repository.beginChainObservation();
      const lease = this.lease;
      if (lease) await this.repository.markDegraded(message.slice(0, 300), paused ? "paused" : "degraded", lease).catch(() => undefined);
    }).finally(() => { this.running = null; });
  }

  private async renew(): Promise<void> {
    if (!this.lease || this.renewing || this.stopped) return;
    this.renewing = true;
    try {
      const renewed = await acquireWorkerLease(this.repository.pool, this.owner);
      this.lease = renewed;
      if (!renewed) {
        this.needsStoryBoundary = true;
        this.repository.beginChainObservation();
      }
    } catch {
      // The next polling tick will retry. No pet state is changed by this failure.
    } finally {
      this.renewing = false;
    }
  }

  async runOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    this.lease = await acquireWorkerLease(this.repository.pool, this.owner);
    if (!this.lease) {
      this.needsStoryBoundary = true;
      this.repository.beginChainObservation();
      return;
    }
    const firstReconciliation = this.needsStoryBoundary;
    const cursor = await this.repository.chainCursor();
    if (!cursor) {
      const tipHash = await this.source.getTipHash();
      const block = await this.source.getBlockByHash(tipHash);
      await this.repository.applyTransition({
        disconnect: [],
        connect: [{ ...this.applyMeal(block), active: false }],
        observedAt: new Date().toISOString(),
        syncStatus: "synced",
      }, this.currentLease());
      this.needsStoryBoundary = false;
      this.repository.completeChainObservation();
      return;
    }
    const known = await this.repository.knownActiveChain();
    const storyWasLive = !firstReconciliation && (await this.repository.snapshot()).chain.syncStatus === "synced";
    const transition = await reconcileChain(this.source, known);
    if (transition.disconnect.length === 0 && transition.connect.length === 0) {
      await this.repository.markHealthy(new Date().toISOString(), firstReconciliation, this.currentLease());
      this.needsStoryBoundary = false;
      this.repository.completeChainObservation();
      return;
    }
    const connect = transition.connect.map((block) => this.applyMeal(block));
    await this.repository.applyTransition({
      disconnect: transition.disconnect.map((block) => block.id),
      connect,
      observedAt: new Date().toISOString(),
      syncStatus: "synced",
      storyLive: storyWasLive && transition.disconnect.length === 0 && transition.connect.length === 1,
    }, this.currentLease());
    this.needsStoryBoundary = false;
    this.repository.completeChainObservation();
  }

  private currentLease(): WorkerLease {
    const lease = this.lease;
    if (!lease) throw new HttpError(409, "Block-worker lease is stale");
    return lease;
  }

  private applyMeal(block: AppliedBlock["block"]): AppliedBlock {
    const meal = mealForBlock(block);
    const item = GENERIC_PANTRY.find((candidate) => candidate.id === meal.foodId);
    if (!item) throw new Error("Pantry rotation selected an unknown item");
    return {
      block,
      meal: { foodId: meal.foodId, foodName: item.name, reaction: item.reaction, pantryVersion: meal.pantryVersion },
    };
  }
}
