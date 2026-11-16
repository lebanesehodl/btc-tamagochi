import { CoinGeckoPriceSource, priceZone, PriceDataError } from "../src/server/story/coingecko.ts";

const now = new Date();
try {
  const observation = await new CoinGeckoPriceSource().observe(now);
  console.log(JSON.stringify({
    ok: true,
    source: "CoinGecko",
    pair: "BTC/USD",
    change: observation.change,
    zone: priceZone(observation.change),
    sourceUpdatedAt: observation.sourceUpdatedAt,
    receivedAt: observation.receivedAt,
    checkedAt: now.toISOString(),
    ageSeconds: (now.getTime() - Date.parse(observation.sourceUpdatedAt)) / 1000,
    scope: "read-only provider check; no world state changed; quota headroom not claimed",
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    checkedAt: now.toISOString(),
    code: error instanceof PriceDataError ? error.code : "unexpected",
    message: error instanceof Error ? error.message : String(error),
    scope: "production price feed cannot arm a story until this check passes",
  }, null, 2));
  process.exitCode = 1;
}
