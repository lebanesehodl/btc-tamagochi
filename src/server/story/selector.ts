import crypto from "node:crypto";
import { STORY_RULE_VERSION } from "../../shared/story.ts";

/** Domain-separated, displayed-hex-byte-order selector; never a source of prizes or security randomness. */
export function selectsHashMischief(blockHash: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(blockHash)) return false;
  const digest = crypto.createHash("sha256")
    .update(`btc-tamagochi/${STORY_RULE_VERSION}`, "utf8")
    .update(Buffer.from([0]))
    .update(Buffer.from(blockHash, "hex"))
    .digest();
  return digest[0]! < 8;
}
