import type { AppConfig } from "../config.ts";
import type { WorkerLike } from "../app.ts";
import type { WorldRepository } from "../world/repository.ts";
import { CoinGeckoPriceSource } from "./coingecko.ts";

const PRICE_POLL_MS = 5 * 60 * 1000;
const STORY_TICK_MS = 60 * 1000;

export class StoryWorker implements WorkerLike {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private lastFetchMs: number | null = null;
  private needsPriceBaseline = true;

  constructor(
    private readonly repository: WorldRepository,
    _config: AppConfig,
    private readonly source: Pick<CoinGeckoPriceSource, "observe"> = new CoinGeckoPriceSource(),
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.schedule(), STORY_TICK_MS);
    this.timer.unref();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  async runOnce(forcePriceFetch = true): Promise<void> {
    const now = new Date();
    let price: Awaited<ReturnType<CoinGeckoPriceSource["observe"]>> | undefined | null;
    if (forcePriceFetch || this.lastFetchMs === null || now.getTime() - this.lastFetchMs >= PRICE_POLL_MS) {
      this.lastFetchMs = now.getTime();
      try { price = await this.source.observe(now); }
      catch { price = null; }
    }
    // A newly constructed worker must not treat persisted continuity as its own live observation history.
    const rebaselinePrice = this.needsPriceBaseline;
    // Production episode time/date comes from PostgreSQL under the world lock, not the network runner's clock.
    await this.repository.evaluateStory({ price, rebaselinePrice });
    if (price) this.needsPriceBaseline = false;
  }

  private schedule(): void {
    if (this.running || this.stopped) return;
    this.running = this.runOnce(false).catch(async () => {
      // A provider/timer failure must never change block feeding. A failed poll rebases price continuity.
      await this.repository.evaluateStory({ price: null }).catch(() => undefined);
    }).finally(() => { this.running = null; });
  }
}
