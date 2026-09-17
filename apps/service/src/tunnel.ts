import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { PlatformAdapter } from "@secondmind/platform";
import { atomicWrite, type Settings } from "@secondmind/config";
import { AppError } from "@secondmind/core";

export class Tunnel extends EventEmitter {
  private child?: ChildProcess;
  private desired = false;
  private retry = 0;
  private generation = 0;
  private timer?: NodeJS.Timeout;
  status: { state: string; message: string; url?: string } = {
    state: "stopped",
    message: "Remote access is off.",
  };
  constructor(
    private platform: PlatformAdapter,
    private directory: string,
    private settings: () => Settings,
  ) {
    super();
  }
  private update(state: string, message: string) {
    this.status = {
      state,
      message,
      url: this.settings().publicOrigin
        ? this.settings().publicOrigin + "/mcp"
        : undefined,
    };
    this.emit("change");
  }
  async configured() {
    return fs.access(path.join(this.directory, "tunnel.secret")).then(
      () => true,
      () => false,
    );
  }
  async setToken(token: string) {
    if (this.desired)
      throw new AppError(
        "tunnel_running",
        "Stop the tunnel before changing its token.",
      );
    await atomicWrite(
      path.join(this.directory, "tunnel.secret"),
      await this.platform.protect(token),
    );
  }
  async start() {
    if (this.child || this.desired) return;
    if (!this.settings().publicOrigin)
      throw new AppError(
        "hostname",
        "Configure your Cloudflare HTTPS hostname first.",
      );
    this.desired = true;
    const generation = ++this.generation;
    this.retry = 0;
    try {
      await this.launch(generation);
    } catch (e) {
      this.desired = false;
      this.update(
        "error",
        e instanceof AppError ? e.message : "Tunnel could not start.",
      );
      throw e;
    }
  }
  private async launch(generation: number) {
    const executable =
      this.settings().cloudflaredPath ||
      (await this.platform.findCloudflared());
    if (!executable)
      throw new AppError(
        "cloudflared_missing",
        "Install cloudflared or provide its executable path in Settings.",
      );
    let token: string;
    try {
      token = await this.platform.unprotect(
        await fs.readFile(path.join(this.directory, "tunnel.secret"), "utf8"),
      );
    } catch {
      throw new AppError(
        "tunnel_token",
        "Save a valid Cloudflare tunnel token first.",
      );
    }
    if (!this.desired || generation !== this.generation) return;
    this.update("connecting", "Connecting to Cloudflare…");
    const child = this.platform.spawnTunnel(executable, token);
    this.child = child;
    let tail = "";
    const inspect = (bytes: Buffer) => {
      if (!this.desired || generation !== this.generation) return;
      tail = (tail + bytes.toString()).slice(-4000);
      if (/Registered tunnel connection/i.test(tail)) {
        this.retry = 0;
        this.update(
          "connected",
          "Tunnel connected. Authorized AI clients can retrieve knowledge.",
        );
        tail = "";
      } else if (/retrying|reconnecting/i.test(tail)) {
        this.update(
          "reconnecting",
          "Cloudflare connection interrupted; reconnecting.",
        );
        tail = "";
      } else if (
        /Unauthorized|Invalid tunnel secret|invalid token/i.test(tail)
      ) {
        this.update("error", "Cloudflare rejected the tunnel credentials.");
        tail = "";
      }
    };
    child.stderr?.on("data", inspect);
    child.stdout?.on("data", inspect);
    child.on("error", () =>
      this.update(
        "error",
        "Could not run cloudflared. Check the executable and tunnel settings.",
      ),
    );
    child.on("close", () => {
      if (this.child === child) this.child = undefined;
      if (this.desired && generation === this.generation && this.retry < 5) {
        const wait = Math.min(30000, 1000 * 2 ** this.retry++);
        this.update(
          "reconnecting",
          "Tunnel stopped unexpectedly; reconnecting.",
        );
        this.timer = setTimeout(
          () =>
            this.launch(generation).catch(() => {
              if (generation !== this.generation) return;
              this.desired = false;
              this.update(
                "error",
                "Reconnect failed. Check tunnel settings and start again.",
              );
            }),
          wait,
        );
      } else if (this.desired && generation === this.generation) {
        this.desired = false;
        this.update(
          "error",
          "Tunnel stopped. Check credentials and network access, then retry.",
        );
      }
    });
  }
  async stop() {
    this.desired = false;
    this.generation++;
    clearTimeout(this.timer);
    if (this.child) {
      const child = this.child;
      this.child = undefined;
      await this.platform.stopProcess(child);
    }
    this.update("stopped", "Remote access is off.");
  }
}
