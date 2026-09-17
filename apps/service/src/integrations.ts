import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as TOML from "@iarna/toml";
import { AppError, hash } from "@secondmind/core";
import { atomicWrite } from "@secondmind/config";
import type { PlatformAdapter, ClientPath } from "@secondmind/platform";

export class Integrations {
  private previews = new Map<
    string,
    { client: ClientPath; before: string; after: string; created: number }
  >();
  constructor(
    private platform: PlatformAdapter,
    private entrypoint: string,
  ) {}
  snippet() {
    return { command: process.execPath, args: [this.entrypoint, "mcp"] };
  }
  async list() {
    return Promise.all(
      (await this.platform.clientPaths()).map(async (c) => {
        let configured = false;
        try {
          const text = await fs.readFile(c.path, "utf8");
          const data: any =
            c.format === "toml" ? TOML.parse(text) : JSON.parse(text);
          const item =
            c.format === "toml"
              ? data.mcp_servers?.secondmind
              : data.mcpServers?.secondmind;
          configured = JSON.stringify(item) === JSON.stringify(this.snippet());
        } catch {}
        return { ...c, configured, snippet: this.snippet() };
      }),
    );
  }
  async preview(id: string) {
    const client = (await this.platform.clientPaths()).find((c) => c.id === id);
    if (!client) throw new AppError("client", "Unknown AI client.");
    let before = "";
    try {
      before = await fs.readFile(client.path, "utf8");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    let after: string;
    try {
      if (client.format === "json") {
        const data = before ? JSON.parse(before) : {};
        data.mcpServers = { ...data.mcpServers, secondmind: this.snippet() };
        after = JSON.stringify(data, null, 2) + "\n";
      } else {
        if (before) TOML.parse(before);
        // Preserve all unrelated TOML text and comments, including other server tables.
        const lines = before.split(/\r?\n/),
          kept: string[] = [];
        let removing = false;
        for (const line of lines) {
          if (/^\s*\[/.test(line))
            removing =
              /^\s*\[\[?mcp_servers\.(?:secondmind|"secondmind"|'secondmind')(?:\.|\])/.test(
                line,
              );
          if (!removing) kept.push(line);
        }
        after =
          kept.join("\n").trimEnd() +
          "\n\n" +
          TOML.stringify({ mcp_servers: { secondmind: this.snippet() } });
        TOML.parse(after);
      }
    } catch {
      throw new AppError(
        "client_config",
        "The existing configuration cannot be safely parsed. Use manual setup.",
      );
    }
    const preview_id = randomUUID();
    this.previews.set(preview_id, {
      client,
      before,
      after,
      created: Date.now(),
    });
    return { preview_id, path: client.path, before, after };
  }
  async apply(id: string) {
    const preview = this.previews.get(id);
    this.previews.delete(id);
    if (!preview || Date.now() - preview.created > 600000)
      throw new AppError(
        "preview",
        "Preview expired. Preview the change again.",
      );
    let current = "";
    try {
      current = await fs.readFile(preview.client.path, "utf8");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (hash(current) !== hash(preview.before))
      throw new AppError(
        "changed",
        "Configuration changed since preview. Preview it again.",
        409,
      );
    const backup = preview.before
      ? `${preview.client.path}.secondmind-${Date.now()}.bak`
      : null;
    if (backup) await atomicWrite(backup, preview.before);
    await atomicWrite(preview.client.path, preview.after);
    return { backup, path: preview.client.path };
  }
}
