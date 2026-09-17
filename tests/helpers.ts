import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import type { EmbeddingProvider } from "@secondmind/core";
import type { PlatformAdapter, ClientPath } from "@secondmind/platform";
export const temporary = () =>
  fs.mkdtemp(path.join(os.tmpdir(), "secondmind-test-"));
export async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
// Deliberately synthetic vectors for deterministic storage/security tests only.
// Production and retrieval evaluation always use the real ONNX model.
export class FakeEmbeddings implements EmbeddingProvider {
  modelId = "test-only";
  revision = "1";
  dimensions = 4;
  calls = 0;
  async embedDocuments(texts: string[]) {
    this.calls += texts.length;
    return texts.map((t) => {
      const values = [
        /parent|leave/i.test(t) ? 1 : 0,
        /bill|pricing/i.test(t) ? 1 : 0,
        /code|retry/i.test(t) ? 1 : 0,
        0.01,
      ];
      const n = Math.hypot(...values);
      return values.map((v) => v / n);
    });
  }
  async embedQuery(text: string) {
    return (await this.embedDocuments([text]))[0];
  }
  async split(text: string) {
    return text.match(/[\s\S]{1,800}/g) || [];
  }
  async close() {}
}
export class TestPlatform implements PlatformAdapter {
  constructor(private root: string) {}
  dataDirectory() {
    return this.root;
  }
  async chooseFolder() {
    return null;
  }
  async openUrl(_url: string) {}
  async openFolder(_path: string) {}
  async protect(s: string) {
    return Buffer.from(s).toString("base64");
  }
  async unprotect(s: string) {
    return Buffer.from(s, "base64").toString("utf8");
  }
  async clientPaths(): Promise<ClientPath[]> {
    return [
      {
        id: "claude-code",
        name: "Claude Code",
        path: path.join(this.root, "claude.json"),
        format: "json",
        installed: true,
      },
      {
        id: "codex",
        name: "Codex",
        path: path.join(this.root, "config.toml"),
        format: "toml",
        installed: true,
      },
    ];
  }
  async findCloudflared() {
    return null;
  }
  spawnTunnel(_executable: string, _token: string) {
    return spawn(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
      windowsHide: true,
    });
  }
  async stopProcess(child: ReturnType<typeof spawn>) {
    child.kill();
  }
}
