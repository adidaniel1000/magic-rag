import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { get as httpGet } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaults, saveSettings } from "@secondmind/config";
import { createService } from "../apps/service/src/server.js";
import { WindowsPlatform } from "@secondmind/platform";
import {
  TestPlatform,
  FakeEmbeddings,
  freePort,
  temporary,
} from "./helpers.js";

describe("HTTP and remote security", () => {
  let service: Awaited<ReturnType<typeof createService>>,
    base: string,
    remote: string,
    directory: string,
    sourceId: string,
    csrf: string,
    sessionCookie: string;
  beforeAll(async () => {
    directory = await temporary();
    const port = await freePort(),
      gatewayPort = await freePort();
    await saveSettings(directory, {
      ...defaults,
      port,
      gatewayPort,
      publicOrigin: "https://mind.example.com",
    });
    service = await createService({
      directory,
      platform: new TestPlatform(directory),
      embeddings: new FakeEmbeddings(),
      entrypoint: path.resolve("dist/cli.js"),
      webDirectory: path.resolve("dist/web"),
      watch: false,
    });
    base = `http://127.0.0.1:${port}`;
    remote = `http://127.0.0.1:${gatewayPort}`;
    const docs = path.join(await temporary(), "docs");
    await fs.mkdir(docs);
    await fs.writeFile(
      path.join(docs, "leave.md"),
      "# Parent leave\n\nParental leave is sixteen paid weeks.",
    );
    await fs.writeFile(
      path.join(docs, "leave.ts"),
      "export function parentalLeaveWeeks() { return 16; }",
    );
    const source = await service.indexer.register(docs);
    await service.indexer.idle();
    sourceId = source.id;
    const code = new URL(service.bootstrap()).hash.slice("#setup=".length);
    const login = await fetch(base + "/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    csrf = (await login.json()).csrf;
    sessionCookie = login.headers.get("set-cookie")!.split(";")[0];
  });
  afterAll(async () => {
    await service?.shutdown();
  });
  const local = (route: string, body?: any) =>
    fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${service.localSecret}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  it("requires authentication, validates host/origin and rejects CSRF", async () => {
    expect((await fetch(base + "/api/v1/sources")).status).toBe(401);
    const invalidHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        httpGet(
          base + "/health",
          { headers: { Host: "evil.example.com" } },
          (r) => {
            r.resume();
            resolve(r.statusCode);
          },
        ).on("error", reject);
      },
    );
    expect(invalidHost).toBe(403);
    expect(
      (
        await fetch(base + "/api/v1/sources", {
          headers: {
            Authorization: `Bearer ${service.localSecret}`,
            Origin: "https://evil.example.com",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + "/api/v1/folder-picker", {
          method: "POST",
          headers: {
            Cookie: sessionCookie,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const valid = await fetch(base + "/api/v1/folder-picker", {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        "X-SecondMind-CSRF": csrf,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ path: null });
  });
  it("consumes a browser bootstrap only once", async () => {
    const code = new URL(service.bootstrap()).hash.slice("#setup=".length);
    const request = () =>
      fetch(base + "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(401);
  });
  it("supports concurrent local HTTP clients and both search tools without credentials", async () => {
    const clients = [
      new Client({ name: "local-a", version: "1" }),
      new Client({ name: "local-b", version: "1" }),
    ];
    try {
      await Promise.all(
        clients.map((client) =>
          client.connect(
            new StreamableHTTPClientTransport(new URL(base + "/mcp")),
          ),
        ),
      );
      for (const client of clients) {
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
          "second_mind_search",
          "second_mind_code_search",
        ]);
        const knowledge = await client.callTool({
          name: "second_mind_search",
          arguments: { query: "parent leave", max_tokens: 300 },
        });
        expect(knowledge.isError).not.toBe(true);
        expect(JSON.stringify(knowledge.content)).toContain("leave.md");
        const code = await client.callTool({
          name: "second_mind_code_search",
          arguments: {
            query: "parentalLeaveWeeks",
            max_tokens: 300,
            source_ids: [sourceId],
          },
        });
        expect(code.isError).not.toBe(true);
        expect(JSON.stringify(code.content)).toContain("leave.ts");
      }
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
  it("keeps local HTTP MCP behind Host/Origin checks and request limits", async () => {
    for (const origin of ["https://evil.example.com", "null", remote]) {
      expect(
        (await fetch(base + "/mcp", { headers: { Origin: origin } })).status,
      ).toBe(403);
    }
    const invalidHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        httpGet(
          base + "/mcp",
          { headers: { Host: "rebinding.example.com" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        ).on("error", reject);
      },
    );
    expect(invalidHost).toBe(403);
    expect((await fetch(base + "/mcp", { method: "PUT" })).status).toBe(405);
    expect(
      (
        await fetch(base + "/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ padding: "x".repeat(129 * 1024) }),
        })
      ).status,
    ).toBe(413);
    for (const route of [
      "/api/v1/sources",
      "/api/v1/settings",
      "/internal/stop",
    ]) {
      expect((await fetch(base + route, { method: "POST" })).status).toBe(401);
    }
    expect(
      (
        await fetch(remote + "/mcp", {
          method: "POST",
          headers: {
            "X-Forwarded-For": "127.0.0.1",
            "X-Forwarded-Host": new URL(base).host,
          },
        })
      ).status,
    ).toBe(401);
  });
  it("serves search aliases and bounded context; validates input", async () => {
    const response = await local("/api/search", {
      query: "parent leave",
      max_tokens: 150,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).token_count).toBeLessThanOrEqual(150);
    expect(
      (await local("/api/v1/retrieve", { query: "", max_tokens: -1 })).status,
    ).toBe(400);
  });
  it("does not expose administration or document files on the public gateway", async () => {
    expect((await fetch(remote + "/api/v1/sources")).status).toBe(404);
    expect((await fetch(remote + "/")).status).toBe(404);
    expect((await fetch(remote + "/mcp")).status).toBe(401);
    expect(
      (
        await fetch(remote + "/mcp", {
          headers: { Origin: "https://evil.example.com" },
        })
      ).status,
    ).toBe(403);
  });
  it("publishes resource metadata and PKCE discovery", async () => {
    const metadata = await fetch(
      remote + "/.well-known/oauth-protected-resource/mcp",
    ).then((r) => r.json());
    expect(metadata.resource).toBe("https://mind.example.com/mcp");
    const issuer = await fetch(
      remote + "/.well-known/oauth-authorization-server",
    ).then((r) => r.json());
    expect(issuer.code_challenge_methods_supported).toContain("S256");
  });
  it("supports concurrent Streamable HTTP clients, source restriction and revocation", async () => {
    const minted = service.auth.mint("test-client", [sourceId]);
    const clients = [
      new Client({ name: "a", version: "1" }),
      new Client({ name: "b", version: "1" }),
    ];
    try {
      await Promise.all(
        clients.map((c) =>
          c.connect(
            new StreamableHTTPClientTransport(new URL(remote + "/mcp"), {
              requestInit: {
                headers: { Authorization: `Bearer ${minted.token}` },
              },
            }),
          ),
        ),
      );
      for (const client of clients) {
        const list = await client.listTools();
        expect(list.tools.map((t) => t.name)).toEqual([
          "second_mind_search",
          "second_mind_code_search",
        ]);
        const response = await client.callTool({
          name: "second_mind_search",
          arguments: { query: "parent leave", max_tokens: 300 },
        });
        expect(JSON.stringify(response.content)).toContain("leave.md");
      }
      service.auth.revoke(minted.id);
      expect(
        (
          await fetch(remote + "/mcp", {
            headers: { Authorization: `Bearer ${minted.token}` },
          })
        ).status,
      ).toBe(401);
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  });
  it("requires local OAuth approval, validates PKCE/redirect/audience, rotates and revokes tokens", async () => {
    const registration = await fetch(remote + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "OAuth test",
        redirect_uris: ["https://client.example.com/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "knowledge:read",
      }),
    });
    expect(registration.status).toBe(201);
    const client = await registration.json();
    const verifier = randomBytes(32).toString("base64url"),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://client.example.com/callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "knowledge:read",
      state: "opaque-test-state",
      resource: "https://mind.example.com/mcp",
    });
    const authorization = await fetch(remote + "/authorize?" + params, {
      redirect: "manual",
    });
    expect(authorization.status).toBe(200);
    const pendingCookie = authorization.headers
      .get("set-cookie")!
      .split(";")[0];
    const pending = service.auth
      .pendingRequests()
      .find((p) => p.name === "OAuth test")!;
    expect(pending).toBeTruthy();
    const poll = () =>
      fetch(remote + "/authorize/result", {
        method: "POST",
        headers: { Cookie: pendingCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ id: pending.id }),
      });
    expect(await (await poll()).json()).toEqual({ pending: true });
    expect(
      (
        await fetch(remote + "/authorize/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: pending.id }),
        })
      ).status,
    ).toBe(403);
    service.auth.approve(pending.id, [sourceId], true);
    const completed = await (await poll()).json();
    const redirect = new URL(completed.redirect);
    expect(redirect.searchParams.get("state")).toBe("opaque-test-state");
    const code = redirect.searchParams.get("code")!;
    const exchange = (overrides: any = {}) =>
      fetch(remote + "/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          code,
          code_verifier: verifier,
          redirect_uri: "https://client.example.com/callback",
          resource: "https://mind.example.com/mcp",
          ...overrides,
        }),
      });
    expect((await exchange({ code_verifier: "wrong".repeat(12) })).status).toBe(
      400,
    );
    expect(
      (await exchange({ resource: "https://evil.example.com/mcp" })).status,
    ).toBe(400);
    expect(
      (await exchange({ redirect_uri: "https://evil.example.com/callback" }))
        .status,
    ).toBe(400);
    const exchanged = await exchange();
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json();
    expect(
      (await service.auth.principal(tokens.access_token)).sourceIds,
    ).toEqual([sourceId]);
    expect((await exchange()).status).toBe(400);
    const refresh = () =>
      fetch(remote + "/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
          resource: "https://mind.example.com/mcp",
        }),
      });
    const rotated = await refresh();
    expect(rotated.status).toBe(200);
    const newTokens = await rotated.json();
    expect(newTokens.refresh_token).not.toBe(tokens.refresh_token);
    expect((await refresh()).status).toBe(400);
    await expect(
      service.auth.verifyAccessToken(newTokens.access_token),
    ).rejects.toThrow();
  });
  it("rejects malicious registration and unsupported scopes", async () => {
    const response = await fetch(remote + "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["javascript:alert(1)"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(response.status).toBe(400);
  });
  it("invalidates remote tokens on public hostname changes", async () => {
    const minted = service.auth.mint("old-origin", [sourceId]);
    const changed = await fetch(base + "/api/v1/settings", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${service.localSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...service.settings(),
        publicOrigin: "https://new.example.com",
      }),
    });
    expect(changed.status).toBe(200);
    await expect(
      service.auth.verifyAccessToken(minted.token),
    ).rejects.toThrow();
  });
  it("reports missing tunnel software without exposing credentials", async () => {
    await service.tunnel.setToken("fake-test-secret-that-must-not-leak");
    await expect(service.tunnel.start()).rejects.toThrow("cloudflared");
    expect(JSON.stringify(service.tunnel.status)).not.toContain(
      "fake-test-secret",
    );
    expect(service.tunnel.status.state).toBe("error");
  });
});

describe("stdio transport", () => {
  it("initializes with a stopped service and returns a concise retriable error", async () => {
    const directory = await temporary();
    const client = new Client({ name: "stdio-test", version: "1" }),
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("dist/cli.js"), "mcp", "--data-dir", directory],
        stderr: "pipe",
      });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(2);
      const response = await client.callTool({
        name: "second_mind_search",
        arguments: { query: "parent leave" },
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.content)).toContain(
        "temporarily unavailable",
      );
    } finally {
      await client.close();
    }
  });
  it("queries a local-only service over stdio and HTTP without remote configuration", async () => {
    const directory = await temporary(),
      port = await freePort(),
      gatewayPort = await freePort();
    await saveSettings(directory, { ...defaults, port, gatewayPort });
    const platform = new WindowsPlatform(),
      service = await createService({
        directory,
        platform,
        embeddings: new FakeEmbeddings(),
        entrypoint: path.resolve("dist/cli.js"),
        webDirectory: path.resolve("dist/web"),
        watch: false,
      });
    const folder = await temporary();
    await fs.writeFile(
      path.join(folder, "billing.txt"),
      "Annual billing pricing policy",
    );
    await service.indexer.register(folder);
    await service.indexer.idle();
    const client = new Client({ name: "stdio-live", version: "1" });
    const httpClient = new Client({ name: "local-http-live", version: "1" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [path.resolve("dist/cli.js"), "mcp", "--data-dir", directory],
          stderr: "pipe",
        }),
      );
      const response = await client.callTool({
        name: "second_mind_search",
        arguments: { query: "annual billing" },
      });
      expect(response.isError).not.toBe(true);
      expect(JSON.stringify(response.content)).toContain("billing.txt");
      await httpClient.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/mcp`),
        ),
      );
      const httpResponse = await httpClient.callTool({
        name: "second_mind_search",
        arguments: { query: "annual billing" },
      });
      expect(httpResponse.isError).not.toBe(true);
      expect(JSON.stringify(httpResponse.content)).toContain("billing.txt");
      expect((await fetch(`http://127.0.0.1:${gatewayPort}/mcp`)).status).toBe(
        503,
      );
    } finally {
      await client.close();
      await httpClient.close();
      await service.shutdown();
    }
  });
});
