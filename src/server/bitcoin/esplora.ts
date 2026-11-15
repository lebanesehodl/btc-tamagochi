import type { BlockMetadata, BlockSource } from "../../shared/bitcoin.js";
import {
  BitcoinDataError, boundedInteger, isBlockHash, isBlockHeight, parseBlockMetadata, requireBlockHash,
} from "./validation.js";

export interface EsploraOptions {
  /** Server configuration only. Never accept this URL from a visitor. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Provider-reported mainnet metadata over ordinary certificate-validated HTTPS. */
export class EsploraBlockSource implements BlockSource {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: EsploraOptions = {}) {
    let url: URL;
    try {
      url = new URL(options.baseUrl ?? "https://blockstream.info/api");
    } catch {
      throw new BitcoinDataError("invalid-input", "Invalid Esplora endpoint.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new BitcoinDataError("invalid-input", "Esplora requires an HTTPS endpoint without credentials or query parameters.");
    }
    this.baseUrl = url.href.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, 60_000, "request timeout");
    this.maxResponseBytes = boundedInteger(options.maxResponseBytes ?? 16_384, 65_536, "response size");
  }

  async getTipHash(): Promise<string> {
    return requireBlockHash((await this.request("/blocks/tip/hash")).trim());
  }

  async getHashByHeight(height: number): Promise<string> {
    if (!isBlockHeight(height)) {
      throw new BitcoinDataError("invalid-input", "Invalid requested block height.");
    }
    return requireBlockHash((await this.request(`/block-height/${height}`)).trim());
  }

  async getBlockByHash(hash: string): Promise<BlockMetadata> {
    if (!isBlockHash(hash)) {
      throw new BitcoinDataError("invalid-input", "Invalid requested block hash.");
    }
    const text = await this.request(`/block/${hash}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BitcoinDataError("invalid-response", "Invalid block JSON.");
    }
    const block = parseBlockMetadata(json);
    if (block.id !== hash) {
      throw new BitcoinDataError("invalid-response", "Block response does not match the requested hash.");
    }
    return block;
  }

  private async request(path: string): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new BitcoinDataError("timeout", "Block source request timed out."));
      }, this.timeoutMs);
    });
    // The deadline covers body consumption too, including a peer that stops mid-response.
    try {
      return await Promise.race([this.readResponse(path, controller.signal), deadline]);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new BitcoinDataError("timeout", "Block source request timed out.");
      }
      if (error instanceof BitcoinDataError) throw error;
      throw new BitcoinDataError("transport-error", "Block source request failed.");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async readResponse(path: string, signal: AbortSignal): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "GET", redirect: "error", credentials: "omit", cache: "no-store", signal,
      headers: { accept: "application/json, text/plain" },
    });
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new BitcoinDataError("timeout", "Block source request timed out.");
    }
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      throw new BitcoinDataError("http-error", "Block source returned an unsuccessful response.", response.status);
    }
    const length = response.headers.get("content-length");
    if (length !== null && /^\d+$/.test(length) && Number(length) > this.maxResponseBytes) {
      void response.body?.cancel().catch(() => {});
      throw new BitcoinDataError("invalid-response", "Block source response is too large.");
    }
    if (!response.body) throw new BitcoinDataError("invalid-response", "Empty block source response.");
    const reader = response.body.getReader();
    const cancel = (): void => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (signal.aborted) throw new BitcoinDataError("timeout", "Block source request timed out.");
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > this.maxResponseBytes) {
          throw new BitcoinDataError("invalid-response", "Block source response is too large.");
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new BitcoinDataError("invalid-response", "Invalid block source text encoding.");
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
      reader.releaseLock();
    }
  }
}
