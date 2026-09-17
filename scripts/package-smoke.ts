import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WindowsPlatform } from "@secondmind/platform";
import { freePort } from "../tests/helpers.js";
const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "secondmind-package-"),
  ),
  app = path.join(directory, "app"),
  data = path.join(directory, "data");
const pkg = JSON.parse(await fs.readFile("package.json", "utf8")),
  archive = path.resolve(`public/releases/${pkg.name}-${pkg.version}.tgz`);
const npmCli =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
await new Promise<void>((resolve, reject) => {
  const p = spawn(
    process.execPath,
    [
      npmCli,
      "install",
      "--prefix",
      app,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      archive,
    ],
    { stdio: "inherit", windowsHide: true },
  );
  p.on("error", reject);
  p.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`Install failed: ${code}`)),
  );
});
const cli = path.join(app, "node_modules/secondmind-local/dist/cli.js");
await fs.mkdir(data, { recursive: true });
await fs.cp(
  path.resolve(".secondmind-test/models"),
  path.join(data, "models"),
  { recursive: true },
);
const port = await freePort(),
  gatewayPort = await freePort();
await fs.writeFile(
  path.join(data, "settings.json"),
  JSON.stringify({ port, gatewayPort }),
);
const processHandle = spawn(
  process.execPath,
  [cli, "start", "--no-browser", "--data-dir", data],
  { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
);
let output = "";
processHandle.stdout.on("data", (b) => (output += b));
processHandle.stderr.on("data", (b) => (output += b));
const exited = once(processHandle, "exit");
const platform = new WindowsPlatform();
let secret = "";
try {
  for (let i = 0; i < 100; i++) {
    try {
      const instance = JSON.parse(
        await fs.readFile(path.join(data, "instance.json"), "utf8"),
      );
      secret = await platform.unprotect(instance.secret);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  assert(secret, output);
  const call = async (route: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert(response.ok, await response.clone().text());
    return response.json();
  };
  assert(
    (await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text())).includes(
      "Second Mind",
    ),
  );
  const folder = path.join(directory, "knowledge");
  await fs.mkdir(folder);
  await fs.writeFile(
    path.join(folder, "pricing.md"),
    "# Annual pricing\n\nEnterprise subscriptions receive a twenty percent discount when billed annually.",
  );
  await call("/api/v1/sources", { path: folder });
  for (let i = 0; i < 100; i++) {
    const state = await call("/api/v1/status");
    if (state.sources[0]?.status === "ready") break;
    if (state.sources[0]?.status === "error")
      throw new Error(JSON.stringify(state));
    await new Promise((r) => setTimeout(r, 200));
  }
  const response = await call("/api/v1/retrieve", {
    query: "How much do annual enterprise subscriptions save?",
  });
  assert(response.results.some((r: any) => r.path === "pricing.md"));
  const client = new Client({ name: "installed-package-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp", "--data-dir", data],
        stderr: "pipe",
      }),
    );
    const reply = await client.callTool({
      name: "second_mind_search",
      arguments: { query: "annual enterprise discount" },
    });
    assert(JSON.stringify(reply.content).includes("pricing.md"));
  } finally {
    await client.close();
  }
  await call("/internal/stop", {});
  const [exitCode] = await exited;
  assert.equal(exitCode, 0, output);
  const report = {
    passed: true,
    archive,
    directory,
    node: process.version,
    package: pkg.version,
    realModelRetrieval: true,
    stdio: true,
    uiAssets: true,
    latency_ms: response.latency_ms,
  };
  await fs.writeFile(
    "artifacts/package-smoke.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (processHandle.exitCode === null) processHandle.kill();
}
