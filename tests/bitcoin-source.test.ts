import { describe, expect, it, vi } from "vitest";
import { EsploraBlockSource, parseBlockMetadata } from "../src/server/bitcoin/index.js";
import fixture from "./fixtures/blocks/backward-timestamps.json";

const block = fixture[1]!;
const hash = block.id;
function adapter(body: string | Uint8Array<ArrayBuffer>, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { status }));
  return { source: new EsploraBlockSource({ fetchImpl }), fetchImpl };
}

describe("Esplora HTTP boundary", () => {
  it("uses verified HTTPS defaults, no credentials, redirects, or cache", async () => {
    const { source, fetchImpl } = adapter(`${hash}\n`);
    expect(await source.getTipHash()).toBe(hash);
    expect(fetchImpl).toHaveBeenCalledWith("https://blockstream.info/api/blocks/tip/hash", expect.objectContaining({
      redirect: "error", credentials: "omit", cache: "no-store", method: "GET", signal: expect.any(AbortSignal),
    }));
    expect(await source.getHashByHeight(block.height)).toBe(hash);
    expect(fetchImpl.mock.calls[1]![0]).toBe(`https://blockstream.info/api/block-height/${block.height}`);
  });

  it("parses and copies only consumed metadata fields", async () => {
    const { source, fetchImpl } = adapter(JSON.stringify(block));
    expect(await source.getBlockByHash(hash)).toEqual({
      id: hash, height: block.height, timestamp: block.timestamp, previousblockhash: block.previousblockhash,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(`https://blockstream.info/api/block/${hash}`);
  });

  it.each(["http://blockstream.info/api", "https://user:secret@example.org/api", "https://example.org/api?key=x", "https://example.org/api#x", "not a url"])(
    "rejects insecure/credential-bearing/ambiguous endpoints: %s", (baseUrl) => {
      expect(() => new EsploraBlockSource({ baseUrl })).toThrow();
    },
  );

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 0x80000000])("rejects invalid height %s before fetching", async (height) => {
    const { source, fetchImpl } = adapter(hash);
    await expect(source.getHashByHeight(height)).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["../secrets", "a".repeat(63), "A".repeat(64), "g".repeat(64)])("rejects invalid requested hash %s before fetching", async (badHash) => {
    const { source, fetchImpl } = adapter(hash);
    await expect(source.getBlockByHash(badHash)).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["<html>error</html>", "a".repeat(65), "a".repeat(63), "Z".repeat(64)])("rejects hostile hash responses", async (body) => {
    await expect(adapter(body).source.getTipHash()).rejects.toMatchObject({ code: "invalid-response" });
  });

  it.each([302, 404, 429, 500])("surfaces HTTP %s without copying hostile response text", async (status) => {
    await expect(adapter("secret hostile body", status).source.getTipHash()).rejects.toMatchObject({
      code: "http-error", status, message: "Block source returned an unsuccessful response.",
    });
  });

  it("sanitizes transport failures and never retries by disabling TLS", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("certificate failure with secret payload"); });
    await expect(new EsploraBlockSource({ fetchImpl }).getTipHash()).rejects.toMatchObject({
      code: "transport-error", message: "Block source request failed.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["null", "[]", "{}", "not-json", JSON.stringify({ ...block, id: fixture[0]!.id }), JSON.stringify({ ...block, height: "975859" })])(
    "rejects malformed JSON/metadata and mismatched response identity", async (body) => {
      await expect(adapter(body).source.getBlockByHash(hash)).rejects.toMatchObject({ code: "invalid-response" });
    },
  );

  it("caps declared response size before reading", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(hash, { headers: { "content-length": "999999999" } }));
    await expect(new EsploraBlockSource({ fetchImpl }).getTipHash()).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("caps actual streamed bytes even without Content-Length and cancels the body", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(80));
        controller.enqueue(new Uint8Array(80));
      }, cancel,
    })));
    await expect(new EsploraBlockSource({ fetchImpl, maxResponseBytes: 128 }).getTipHash()).rejects.toMatchObject({ code: "invalid-response" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid UTF-8 rather than replacing bytes", async () => {
    await expect(adapter(new Uint8Array([0xc3, 0x28])).source.getTipHash()).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("bounds a fetch that never returns", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    await expect(new EsploraBlockSource({ fetchImpl, timeoutMs: 20 }).getTipHash()).rejects.toMatchObject({ code: "timeout" });
    expect(fetchImpl.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it("bounds a peer that stalls during the body, not just before headers", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("a")); }, cancel,
    })));
    await expect(new EsploraBlockSource({ fetchImpl, timeoutMs: 20 }).getTipHash()).rejects.toMatchObject({ code: "timeout" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([{ timeoutMs: 0 }, { timeoutMs: 60_001 }, { maxResponseBytes: 0 }, { maxResponseBytes: 65_537 }])("rejects unsafe request limits", (options) => {
    expect(() => new EsploraBlockSource(options)).toThrow();
  });
});

describe("block metadata validation", () => {
  it.each([
    { timestamp: -1 }, { timestamp: 1.5 }, { timestamp: 0x100000000 }, { timestamp: "123" },
    { height: -1 }, { height: 1.5 }, { height: 0x80000000 }, { previousblockhash: null },
    { previousblockhash: "bad" }, { previousblockhash: hash },
  ])("rejects invalid metadata field %j", (patch) => {
    expect(() => parseBlockMetadata({ ...block, ...patch })).toThrow();
  });

  it("normalizes genesis's absent/null/zero parent without relaxing other blocks", () => {
    const genesis = { id: "1".repeat(64), height: 0, timestamp: 1231006505 };
    for (const previousblockhash of [undefined, null, "0".repeat(64)]) {
      expect(parseBlockMetadata({ ...genesis, previousblockhash }).previousblockhash).toBeNull();
    }
    expect(() => parseBlockMetadata({ ...genesis, previousblockhash: "2".repeat(64) })).toThrow();
  });
});
