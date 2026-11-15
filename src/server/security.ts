import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "btct_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function newSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): Buffer {
  return crypto.createHash("sha256").update(token).digest();
}

export function setSessionCookie(reply: FastifyReply, token: string, production: boolean): void {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (production) parts.push("Secure");
  reply.header("Set-Cookie", parts.join("; "));
}

export function sessionToken(request: FastifyRequest): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    if (key === SESSION_COOKIE) {
      const value = pair.slice(separator + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
    }
  }
  return null;
}

export function requireSameOrigin(request: FastifyRequest, reply: FastifyReply): boolean {
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite && !["same-origin", "none"].includes(String(fetchSite))) {
    reply.code(403).send({ error: "Cross-site actions are not allowed" });
    return false;
  }
  const origin = request.headers.origin;
  if (origin) {
    const expected = `${request.protocol}://${request.headers.host}`;
    if (origin !== expected) {
      reply.code(403).send({ error: "Cross-origin actions are not allowed" });
      return false;
    }
  }
  if (request.headers["content-type"] !== "application/json") {
    reply.code(415).send({ error: "Actions require application/json" });
    return false;
  }
  return true;
}

export function validModeratorToken(request: FastifyRequest, configured: string | null): boolean {
  if (!configured) return false;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(configured);
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}
