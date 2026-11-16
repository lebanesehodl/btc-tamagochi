import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { DEN_SLOTS, type ActionRequest, type DenSlot } from "../shared/world.ts";
import { TRIGGER_FAMILIES, type TriggerFamily } from "../shared/story.ts";
import type { AppConfig } from "./config.ts";
import { ActionRateLimiter } from "./rate-limit.ts";
import { hashSessionToken, newSessionToken, requireSameOrigin, sessionToken, setSessionCookie, validModeratorToken } from "./security.ts";
import { WorldRepository, assertDenSlots, type WorldEvent } from "./world/repository.ts";
import { HttpError } from "./world/errors.ts";

declare module "fastify" {
  interface FastifyRequest {
    badgerSessionId?: string;
  }
}

export interface WorkerLike {
  start(): void | Promise<void>;
  stop(): Promise<void>;
}

export interface BuildAppOptions {
  serveClient?: boolean;
  worker?: WorkerLike;
  rateLimiter?: ActionRateLimiter;
  /** Must be the same instance used by workers so their commits reach live SSE subscribers. */
  repository?: WorldRepository;
}

async function ensureSession(request: FastifyRequest, reply: FastifyReply, repository: WorldRepository, production: boolean): Promise<string> {
  let token = sessionToken(request);
  if (!token) {
    token = newSessionToken();
    setSessionCookie(reply, token, production);
  }
  const id = await repository.ensureSession(hashSessionToken(token));
  request.badgerSessionId = id;
  return id;
}

function parseAction(body: unknown): ActionRequest {
  if (!body || typeof body !== "object" || !("kind" in body)) throw new HttpError(400, "Action body is invalid");
  if (body.kind === "play" && Object.keys(body).length === 1) return { kind: "play" };
  if ((body.kind === "story-care" || body.kind === "story-dismiss") && Object.keys(body).length === 2) {
    const { episodeId } = body as Record<string, unknown>;
    if (typeof episodeId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(episodeId)) {
      throw new HttpError(400, "Story episode is invalid");
    }
    return { kind: body.kind, episodeId: episodeId.toLowerCase() };
  }
  if (body.kind === "story-demo" && Object.keys(body).length === 2) {
    const { family } = body as Record<string, unknown>;
    if (typeof family !== "string" || !TRIGGER_FAMILIES.includes(family as TriggerFamily)) throw new HttpError(400, "Demo story is invalid");
    return { kind: "story-demo", family: family as TriggerFamily };
  }
  if (body.kind === "decorate") {
    const { slot, itemId, expectedVersion } = body as Record<string, unknown>;
    if (typeof slot !== "string" || !DEN_SLOTS.includes(slot as DenSlot) || typeof itemId !== "string" || itemId.length > 64 || !Number.isSafeInteger(expectedVersion)) {
      throw new HttpError(400, "Decoration action is invalid");
    }
    return { kind: "decorate", slot: slot as DenSlot, itemId, expectedVersion: expectedVersion as number };
  }
  throw new HttpError(400, "Unknown action");
}

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(key)) {
    throw new HttpError(400, "A valid Idempotency-Key is required");
  }
  return key.toLowerCase();
}

export async function buildApp(config: AppConfig, pool: Pool, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  if (options.worker && !options.repository) throw new Error("Worker composition requires its shared WorldRepository");
  const app = Fastify({ bodyLimit: 16 * 1024, logger: false, trustProxy: config.production, forceCloseConnections: true });
  const repository = options.repository ?? new WorldRepository(pool, 1000, config.storyDemo === true);
  const rateLimiter = options.rateLimiter ?? new ActionRateLimiter();

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'");
  });

  app.get("/healthz", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  app.get("/api/world", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    await ensureSession(request, reply, repository, config.production);
    const snapshot = await repository.snapshot();
    assertDenSlots(snapshot);
    return snapshot;
  });

  app.post("/api/actions", async (request, reply) => {
    if (!requireSameOrigin(request, reply)) return reply;
    const sessionId = await ensureSession(request, reply, repository, config.production);
    const rate = rateLimiter.check(sessionId, request.ip);
    if (!rate.allowed) {
      reply.header("Retry-After", String(rate.retryAfterSeconds));
      throw new HttpError(429, "Too many actions; give the badger a short breather");
    }
    const action = parseAction(request.body);
    if (action.kind === "story-demo" && config.storyDemo !== true) throw new HttpError(404, "Demo mode is not enabled");
    const result = await repository.applyAction(sessionId, idempotencyKey(request), action);
    return result;
  });

  app.post("/api/moderation/undo/:actionId", async (request, _reply) => {
    if (!validModeratorToken(request, config.moderatorToken)) throw new HttpError(401, "Moderator authorization required");
    const params = request.params as { actionId?: unknown };
    const body = request.body as { reason?: unknown } | null;
    if (typeof params.actionId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(params.actionId)) throw new HttpError(400, "Invalid action ID");
    if (typeof body?.reason !== "string") throw new HttpError(400, "A moderation reason is required");
    return { snapshot: await repository.undoDecoration(params.actionId, body.reason) };
  });

  app.get("/api/stream", async (request, reply) => {
    const query = request.query as { after?: unknown };
    const lastEventId = request.headers["last-event-id"];
    const rawRevision = query.after ?? lastEventId;
    const after = rawRevision === undefined ? null : Number(rawRevision);
    if (after !== null && (!Number.isSafeInteger(after) || after < 0)) throw new HttpError(400, "Invalid stream revision");

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    reply.raw.write(": connected\n\n");
    let ready = false;
    let closed = false;
    let lastSent = after ?? -1;
    const queued: WorldEvent[] = [];

    const unsubscribe = repository.onWorld((event) => {
      if (closed) return;
      if (!ready) queued.push(event);
      else if (event.revision > lastSent) {
        writeEvent(reply.raw, "world", event.snapshot);
        lastSent = event.revision;
      }
    });

    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(`: ${Date.now()}\n\n`);
    }, 15_000);
    heartbeat.unref();
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on("close", close);

    try {
      if (after === null) {
        const snapshot = await repository.snapshot();
        writeEvent(reply.raw, "reset", snapshot);
        lastSent = snapshot.revision;
      } else {
        const result = await repository.eventsAfter(after);
        if (result.reset) {
          writeEvent(reply.raw, "reset", result.reset);
          lastSent = result.reset.revision;
        }
        for (const event of result.events) {
          if (event.revision > lastSent) {
            writeEvent(reply.raw, "world", event.snapshot);
            lastSent = event.revision;
          }
        }
      }
      ready = true;
      queued.sort((a, b) => a.revision - b.revision);
      for (const event of queued) {
        if (event.revision > lastSent) {
          writeEvent(reply.raw, "world", event.snapshot);
          lastSent = event.revision;
        }
      }
    } catch (error) {
      app.log.error(error);
      close();
      reply.raw.destroy();
    }
  });

  if (options.serveClient !== false) {
    await app.register(fastifyStatic, { root: path.resolve(process.cwd(), "dist/client"), prefix: "/" });
  }

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    const candidate = error as { statusCode?: unknown; message?: unknown };
    const statusCode = typeof candidate.statusCode === "number" && candidate.statusCode >= 400 && candidate.statusCode < 500 ? candidate.statusCode : 500;
    const message = typeof candidate.message === "string" ? candidate.message : "Request failed";
    reply.code(statusCode).send({ error: statusCode === 500 ? "The den hit an internal error" : message });
    if (statusCode === 500) app.log.error(error);
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) reply.code(404).send({ error: "API route not found" });
    else reply.code(404).type("text/plain").send("Nothing in this part of the den.");
  });

  if (options.worker) {
    app.addHook("onReady", async () => { await options.worker?.start(); });
    app.addHook("onClose", async () => { await options.worker?.stop(); });
  }
  return app;
}

function writeEvent(stream: NodeJS.WritableStream, name: string, snapshot: unknown): void {
  const revision = (snapshot as { revision: number }).revision;
  stream.write(`id: ${revision}\nevent: ${name}\ndata: ${JSON.stringify(snapshot)}\n\n`);
}
