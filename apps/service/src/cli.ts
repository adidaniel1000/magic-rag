import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPlatform } from "@secondmind/platform";
import { LocalEmbeddings } from "@secondmind/embeddings";
import { createMcp } from "@secondmind/mcp";
import { AppError } from "@secondmind/core";
import { createService } from "./server.js";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args[0] : "start";
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const platform = createPlatform();
const directory = path.resolve(arg("--data-dir") || platform.dataDirectory());
const here = path.dirname(fileURLToPath(import.meta.url));
async function instance() {
  try {
    const data = JSON.parse(
      await fs.readFile(path.join(directory, "instance.json"), "utf8"),
    );
    return { port: data.port, secret: await platform.unprotect(data.secret) };
  } catch {
    return undefined;
  }
}
async function call(route: string, body?: unknown) {
  const i = await instance();
  if (!i) throw new Error("Service unavailable.");
  const response = await fetch(`http://127.0.0.1:${i.port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${i.secret}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(route.includes("retrieve") ? 30000 : 5000),
  });
  if (!response.ok) throw new Error("Service unavailable.");
  return response.json();
}
async function main() {
  if (command === "mcp") {
    const server = createMcp((input) => call("/api/v1/retrieve", input));
    await server.connect(new StdioServerTransport());
    return;
  }
  if (command === "hook") {
    try {
      let input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 100000) throw new Error();
      }
      const payload = JSON.parse(input);
      const result = await call("/api/v1/retrieve", {
        query: String(payload.prompt || "").slice(0, 10000),
        mode: "code_navigation",
        max_tokens: 2500,
      });
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: result.context_text,
          },
        }),
      );
    } catch {
      process.stdout.write("{}");
    }
    return;
  }
  if (command === "status") {
    try {
      const data = await call("/api/v1/status");
      process.stdout.write(
        JSON.stringify({ running: true, ...data }, null, 2) + "\n",
      );
    } catch {
      process.stdout.write("Second Mind is stopped.\n");
      process.exitCode = 1;
    }
    return;
  }
  if (command === "stop") {
    try {
      await call("/internal/stop", {});
      console.log("Second Mind is stopping.");
    } catch {
      console.log("Second Mind is already stopped.");
    }
    return;
  }
  if (!["start", "secondmind"].includes(command)) {
    console.log(
      "Usage: secondmind [start|stop|status|mcp|hook] [--no-browser] [--data-dir PATH]",
    );
    process.exitCode = 1;
    return;
  }
  try {
    await call("/api/v1/status");
    if (!args.includes("--no-browser")) {
      const { url } = await call("/internal/browser", {});
      await platform.openUrl(url);
    }
    console.log("Second Mind is already running in another terminal.");
    return;
  } catch {}
  const service = await createService({
    directory,
    platform,
    embeddings: new LocalEmbeddings(
      path.join(directory, "models"),
      path.join(here, "embedding-worker.js"),
    ),
    webDirectory: path.join(here, "web"),
    entrypoint: fileURLToPath(import.meta.url),
  });
  console.log(
    `Second Mind is running at http://127.0.0.1:${service.settings().port}\nKeep this terminal open. Press Ctrl+C to stop.`,
  );
  const stop = () => void service.shutdown();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (!args.includes("--no-browser"))
    await platform
      .openUrl(service.bootstrap())
      .catch(() =>
        console.log("Browser could not open. Run secondmind again to retry."),
      );
  await service.closed;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
main().catch((error) => {
  console.error(
    error instanceof AppError
      ? error.message
      : `Second Mind could not start: ${error.code || error.message}`,
  );
  process.exitCode = 1;
});
