import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
  AppError,
  publicError,
  searchSchema,
  type EmbeddingProvider,
  type Principal,
  type SearchInput,
} from "@secondmind/core";
import {
  atomicWrite,
  loadSettings,
  saveSettings,
  settingsSchema,
  type Settings,
} from "@secondmind/config";
import type { PlatformAdapter } from "@secondmind/platform";
import { Store } from "@secondmind/storage";
import { Retriever } from "@secondmind/retrieval";
import { createMcp } from "@secondmind/mcp";
import { Indexer } from "./indexer.js";
import { Authorization, equalSecret } from "./auth.js";
import { Tunnel } from "./tunnel.js";
import { Integrations } from "./integrations.js";

const cookie = (req: Request, name: string) =>
  req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1) || "";
const token = () => randomBytes(32).toString("base64url");
const listen = (server: Server, port: number) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
export interface ServiceOptions {
  directory: string;
  platform: PlatformAdapter;
  embeddings: EmbeddingProvider;
  webDirectory: string;
  entrypoint: string;
  watch?: boolean;
}
export async function createService(options: ServiceOptions) {
  const { directory, platform, embeddings } = options;
  await fs.mkdir(directory, { recursive: true });
  let settings = await loadSettings(directory);
  const store = new Store(
    path.join(directory, "index", "secondmind.db"),
    embeddings.dimensions,
  );
  const retriever = new Retriever(store, embeddings, () => settings),
    indexer = new Indexer(
      store,
      embeddings,
      () => settings,
      directory,
      path.join(path.dirname(options.entrypoint), "parser-worker.js"),
    );
  const auth = new Authorization(store, platform, () => settings.publicOrigin),
    tunnel = new Tunnel(platform, directory, () => settings),
    integrations = new Integrations(platform, options.entrypoint);
  let activeSearches = 0;
  async function retrieveBounded(principal: Principal, input: SearchInput) {
    if (activeSearches >= 4)
      throw new AppError("busy", "Search is busy. Retry shortly.", 503);
    activeSearches++;
    const work = retriever
      .retrieve(principal, input.query, input)
      .finally(() => activeSearches--);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AppError(
                  "search_timeout",
                  "Search timed out. Retry after indexing settles.",
                  503,
                ),
              ),
            30000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  let localSecret: string;
  const encrypted = store.getState("local_secret");
  if (encrypted) localSecret = await platform.unprotect(encrypted);
  else {
    localSecret = token();
    store.setState("local_secret", await platform.protect(localSecret));
  }
  const app = express(),
    gateway = express();
  app.disable("x-powered-by");
  gateway.disable("x-powered-by");
  const sessions = new Map<string, { csrf: string; expires: number }>(),
    bootstraps = new Map<string, number>();
  const streams = new Set<Response>();
  let localServer: Server,
    gatewayServer: Server,
    shuttingDown = false;
  const localOrigin = () => `http://127.0.0.1:${settings.port}`;
  const snapshot = () => ({
    sources: store.sources(),
    model: (embeddings as any).progress || { status: "ready" },
    tunnel: tunnel.status,
    diagnostics: store.diagnostics(),
    pending: auth.pendingRequests(),
  });
  let notifyTimer: NodeJS.Timeout | undefined;
  const notify = () => {
    if (shuttingDown || notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined;
      if (shuttingDown) return;
      const data = `data: ${JSON.stringify(snapshot())}\n\n`;
      for (const res of streams) res.write(data);
    }, 150);
  };
  indexer.on("change", notify);
  tunnel.on("change", notify);
  (embeddings as any).on?.("progress", notify);
  const heartbeat = setInterval(() => {
    for (const res of streams)
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    for (const [key, s] of sessions)
      if (s.expires < Date.now()) sessions.delete(key);
    for (const [key, t] of bootstraps)
      if (t < Date.now()) bootstraps.delete(key);
  }, 15000);
  const errors = (
    err: any,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    if (res.headersSent) return;
    if (err instanceof z.ZodError) {
      res.status(400).json({
        error: "Invalid request.",
        details: err.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
      return;
    }
    if (err?.type === "entity.too.large") {
      res.status(413).json({ error: "Request is too large." });
      return;
    }
    if (err?.type === "entity.parse.failed") {
      res.status(400).json({ error: "Invalid JSON request." });
      return;
    }
    res
      .status(err instanceof AppError ? err.status : 500)
      .json({ error: publicError(err) });
  };
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (req.headers.host !== `127.0.0.1:${settings.port}`) {
      res.status(403).json({ error: "Invalid host." });
      return;
    }
    if (req.headers.origin && req.headers.origin !== localOrigin()) {
      res.status(403).json({ error: "Invalid origin." });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "128kb" }));
  app.get("/health", (_req, res) =>
    res.json({ service: "secondmind", version: "0.1.0" }),
  );
  app.post("/api/session", (req, res) => {
    const code = z.object({ code: z.string().max(100) }).parse(req.body).code;
    const expires = bootstraps.get(code);
    bootstraps.delete(code);
    if (!expires || expires < Date.now()) {
      res.status(401).json({
        error:
          "Setup link expired. Run secondmind again to open a new session.",
      });
      return;
    }
    const id = token(),
      csrf = token();
    sessions.set(id, { csrf, expires: Date.now() + 12 * 3600000 });
    res.cookie("sm_session", id, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 12 * 3600000,
    });
    res.json({ csrf });
  });
  app.use(["/api", "/internal"], (req, res, next) => {
    const authorization = req.headers.authorization;
    if (
      authorization?.startsWith("Bearer ") &&
      equalSecret(authorization.slice(7), localSecret)
    ) {
      res.locals.internal = true;
      next();
      return;
    }
    const session = sessions.get(cookie(req, "sm_session"));
    if (!session || session.expires < Date.now()) {
      res.status(401).json({
        error: "Open Second Mind from its terminal command to sign in locally.",
      });
      return;
    }
    if (
      !["GET", "HEAD"].includes(req.method) &&
      !equalSecret(String(req.headers["x-secondmind-csrf"] || ""), session.csrf)
    ) {
      res.status(403).json({ error: "Invalid session protection token." });
      return;
    }
    res.locals.session = session;
    next();
  });
  function bootstrap() {
    const value = token();
    bootstraps.set(value, Date.now() + 120000);
    return `${localOrigin()}/#setup=${value}`;
  }
  app.post("/internal/browser", (_req, res) => res.json({ url: bootstrap() }));
  app.post("/internal/stop", (_req, res) => {
    res.json({ stopping: true });
    setTimeout(() => void shutdown(), 100);
  });
  app.get("/api/v1/session", (_req, res) =>
    res.json({ csrf: res.locals.session?.csrf || "" }),
  );
  app.get("/api/v1/status", (_req, res) => res.json(snapshot()));
  app.get("/api/v1/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    streams.add(res);
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    req.on("close", () => streams.delete(res));
  });
  app.get("/api/v1/sources", (_req, res) => res.json(store.sources()));
  app.post("/api/v1/folder-picker", async (_req, res) =>
    res.json({ path: await platform.chooseFolder() }),
  );
  app.post("/api/v1/sources", async (req, res) => {
    const input = z
      .object({
        path: z.string().min(1).max(2000),
        name: z.string().max(200).optional(),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(await indexer.register(input.path, input.name));
  });
  app.delete("/api/v1/sources/:id", async (req, res) => {
    await indexer.remove(String(req.params.id));
    res.json({ removed: true });
  });
  const source = (id: string) => {
    const s = store.source(id);
    if (!s) throw new AppError("source", "Knowledge folder not found.", 404);
    return s;
  };
  app.post("/api/v1/sources/:id/sync", async (req, res) => {
    source(String(req.params.id));
    await indexer.rebuild(String(req.params.id));
    res.json({ queued: true });
  });
  app.post("/api/v1/sources/:id/pause", async (req, res) => {
    source(String(req.params.id));
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
    await indexer.pause(String(req.params.id), paused);
    res.json({ paused });
  });
  app.put("/api/v1/sources/:id/ignore", (req, res) => {
    source(String(req.params.id));
    const { rules } = z
      .object({ rules: z.string().max(32000) })
      .parse(req.body);
    store.updateSource(String(req.params.id), { ignore_rules: rules });
    indexer.schedule(String(req.params.id), true);
    res.json({ saved: true });
  });
  app.post("/api/v1/sources/:id/open", async (req, res) => {
    await platform.openFolder(source(String(req.params.id)).root);
    res.json({ opened: true });
  });
  const search = async (req: Request, res: Response) => {
    const input = searchSchema.parse(req.body);
    res.json(
      await retrieveBounded(
        {
          id: "owner",
          sourceIds: "*",
          integration: res.locals.internal ? "local-mcp" : "playground",
        },
        input,
      ),
    );
  };
  app.post("/api/v1/retrieve", search);
  app.post("/api/search", search);
  app.get("/api/v1/diagnostics", (_req, res) =>
    res.json({ ...store.diagnostics(), failures: store.failures() }),
  );
  app.post("/api/v1/retrievals/:id/feedback", (req, res) => {
    const { rating } = z
      .object({
        rating: z.enum([
          "helpful",
          "not_helpful",
          "wrong_source",
          "missing_knowledge",
        ]),
      })
      .parse(req.body);
    if (
      !store.db
        .prepare("SELECT id FROM metrics WHERE id=?")
        .get(String(req.params.id))
    )
      throw new AppError("retrieval", "Retrieval not found.", 404);
    store.db
      .prepare(
        "INSERT INTO feedback VALUES(?,?) ON CONFLICT(retrieval_id) DO UPDATE SET rating=excluded.rating",
      )
      .run(String(req.params.id), rating);
    res.json({ saved: true });
  });
  app.get("/api/v1/settings", async (_req, res) =>
    res.json({ ...settings, tunnelConfigured: await tunnel.configured() }),
  );
  let authRouter: any;
  const updateRouter = () => {
    authRouter = settings.publicOrigin
      ? mcpAuthRouter({
          provider: auth,
          issuerUrl: new URL(settings.publicOrigin),
          resourceServerUrl: new URL(auth.resource),
          scopesSupported: ["knowledge:read"],
          resourceName: "Second Mind",
          clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
        })
      : undefined;
  };
  updateRouter();
  app.put("/api/v1/settings", async (req, res) => {
    const next = settingsSchema.parse(req.body);
    const restart =
      next.port !== settings.port ||
      next.gatewayPort !== settings.gatewayPort ||
      next.reconcileSeconds !== settings.reconcileSeconds;
    if (next.publicOrigin !== settings.publicOrigin) {
      await tunnel.stop();
      auth.reset();
    }
    await saveSettings(directory, next);
    settings = {
      ...next,
      port: settings.port,
      gatewayPort: settings.gatewayPort,
      reconcileSeconds: settings.reconcileSeconds,
    };
    updateRouter();
    res.json({ saved: true, restartRequired: restart });
    notify();
  });
  app.post("/api/v1/model/setup", async (_req, res) => {
    if ((embeddings as any).initialize) await (embeddings as any).initialize();
    res.json({ ready: true });
  });
  app.get("/api/v1/integrations", async (_req, res) =>
    res.json(await integrations.list()),
  );
  app.post("/api/v1/integrations/:id/preview", async (req, res) =>
    res.json(await integrations.preview(String(req.params.id))),
  );
  app.post("/api/v1/integrations/apply", async (req, res) =>
    res.json(
      await integrations.apply(
        z.object({ preview_id: z.string().uuid() }).parse(req.body).preview_id,
      ),
    ),
  );
  app.get("/api/v1/tunnel", async (_req, res) =>
    res.json({
      ...tunnel.status,
      configured: await tunnel.configured(),
      detectedPath: await platform.findCloudflared(),
    }),
  );
  app.post("/api/v1/tunnel/token", async (req, res) => {
    const { token } = z
      .object({ token: z.string().min(20).max(10000) })
      .parse(req.body);
    await tunnel.setToken(token);
    res.json({ saved: true });
  });
  app.post("/api/v1/tunnel/start", async (_req, res) => {
    await tunnel.start();
    res.json(tunnel.status);
  });
  app.post("/api/v1/tunnel/stop", async (_req, res) => {
    await tunnel.stop();
    res.json(tunnel.status);
  });
  app.get("/api/v1/authorization", (_req, res) =>
    res.json({ pending: auth.pendingRequests(), grants: auth.grants() }),
  );
  app.post("/api/v1/authorization/:id/decision", (req, res) => {
    const input = z
      .object({
        approve: z.boolean(),
        source_ids: z.array(z.string().uuid()).max(100),
      })
      .parse(req.body);
    auth.approve(String(req.params.id), input.source_ids, input.approve);
    res.json({ saved: true });
    notify();
  });
  app.post("/api/v1/tokens", (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        source_ids: z.array(z.string().uuid()).max(100),
        days: z.number().int().min(1).max(365).default(30),
      })
      .parse(req.body);
    res.json(auth.mint(input.name, input.source_ids, input.days));
  });
  app.delete("/api/v1/authorization/:id", (req, res) => {
    auth.revoke(String(req.params.id));
    res.json({ revoked: true });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "Unknown API route." }),
  );
  app.use(express.static(options.webDirectory, { index: "index.html" }));
  app.use(errors);

  const rate = new Map<string, { count: number; until: number }>();
  gateway.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!settings.publicOrigin) {
      res.status(503).json({ error: "Remote access is not configured." });
      return;
    }
    if (
      ![
        new URL(settings.publicOrigin).host,
        `127.0.0.1:${settings.gatewayPort}`,
      ].includes(req.headers.host || "")
    ) {
      res.status(403).json({ error: "Invalid host." });
      return;
    }
    if (
      req.headers.origin &&
      ![
        settings.publicOrigin,
        "https://claude.ai",
        "https://chatgpt.com",
      ].includes(req.headers.origin)
    ) {
      res.status(403).json({ error: "Invalid origin." });
      return;
    }
    // Use a global boundary as well as SDK endpoint limits; never trust forwarded IP headers.
    const key = "gateway",
      bucket = rate.get(key);
    if (!bucket || bucket.until < Date.now())
      rate.set(key, { count: 1, until: Date.now() + 60000 });
    else if (++bucket.count > 240) {
      res.status(429).json({ error: "Too many requests. Retry shortly." });
      return;
    }
    next();
  });
  gateway.use(express.json({ limit: "64kb" }));
  gateway.use(express.urlencoded({ extended: false, limit: "16kb" }));
  gateway.post("/authorize/result", (req, res) =>
    res.json(
      auth.result(
        z.object({ id: z.string().uuid() }).parse(req.body).id,
        cookie(req, "sm_pending"),
      ),
    ),
  );
  gateway.use((req, res, next) =>
    authRouter ? authRouter(req, res, next) : next(),
  );
  gateway.all("/mcp", async (req, res) => {
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    let principal;
    try {
      principal = await auth.principal(bearer || "");
    } catch {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${settings.publicOrigin}/.well-known/oauth-protected-resource/mcp", scope="knowledge:read"`,
      );
      res.status(401).json({ error: "Authorization required." });
      return;
    }
    if (!["POST", "GET", "DELETE"].includes(req.method)) {
      res.status(405).end();
      return;
    }
    const mcp = createMcp(async (input) => {
      const current = await auth.principal(bearer!);
      const result = await retrieveBounded(current, input);
      await auth.verifyAccessToken(bearer!);
      return result;
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  gateway.use((_req, res) => res.status(404).json({ error: "Not found." }));
  gateway.use(errors);
  let resolveClosed: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    clearTimeout(notifyTimer);
    await tunnel.stop();
    for (const res of streams) res.end();
    streams.clear();
    await Promise.all([close(localServer), close(gatewayServer)]);
    const stopping = indexer.stop();
    await embeddings.close();
    await stopping;
    store.close();
    await fs.rm(path.join(directory, "instance.json"), { force: true });
    resolveClosed();
  }
  try {
    localServer = createServer(app);
    gatewayServer = createServer(gateway);
    localServer.requestTimeout = 30000;
    gatewayServer.requestTimeout = 30000;
    await listen(localServer, settings.port);
    await listen(gatewayServer, settings.gatewayPort);
    await atomicWrite(
      path.join(directory, "instance.json"),
      JSON.stringify({
        pid: process.pid,
        port: settings.port,
        secret: await platform.protect(localSecret),
        instance: randomUUID(),
      }),
    );
    if (options.watch !== false) await indexer.start();
  } catch (e) {
    shuttingDown = true;
    clearInterval(heartbeat);
    clearTimeout(notifyTimer);
    if (localServer!) await close(localServer);
    if (gatewayServer!) await close(gatewayServer);
    const stopping = indexer.stop();
    await embeddings.close();
    await stopping;
    store.close();
    throw e;
  }
  return {
    app,
    gateway,
    store,
    indexer,
    auth,
    tunnel,
    retriever,
    settings: () => settings,
    bootstrap,
    shutdown,
    closed,
    localSecret,
  };
}
