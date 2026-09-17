import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { AppError } from "@secondmind/core";
const exec = promisify(execFile);
export interface ClientPath {
  id: string;
  name: string;
  path: string;
  format: "json" | "toml";
  installed: boolean;
}
export interface PlatformAdapter {
  dataDirectory(): string;
  chooseFolder(): Promise<string | null>;
  openUrl(url: string): Promise<void>;
  openFolder(folder: string): Promise<void>;
  protect(secret: string): Promise<string>;
  unprotect(cipher: string): Promise<string>;
  clientPaths(): Promise<ClientPath[]>;
  findCloudflared(): Promise<string | null>;
  spawnTunnel(executable: string, token: string): ChildProcess;
  stopProcess(child: ChildProcess): Promise<void>;
}
async function powershell(script: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "",
      errors = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new AppError("platform_timeout", "Windows operation timed out."));
    }, 120000);
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (errors += b));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(output.trim())
        : reject(new AppError("platform_error", "Windows operation failed."));
    });
    child.stdin.end(input || "");
  });
}
export class WindowsPlatform implements PlatformAdapter {
  dataDirectory() {
    if (!process.env.LOCALAPPDATA)
      throw new AppError("platform", "LOCALAPPDATA is unavailable.");
    return path.join(process.env.LOCALAPPDATA, "SecondMind");
  }
  async chooseFolder() {
    const result = await powershell(
      "Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = 'Choose your Second Mind knowledge folder'; $picker.ShowNewFolderButton = $false; if ($picker.ShowDialog() -eq 'OK') { [Console]::Write($picker.SelectedPath) }; $picker.Dispose()",
    );
    return result || null;
  }
  async openUrl(url: string) {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol))
      throw new AppError("url", "Unsupported URL.");
    await powershell(
      "$url = [Console]::In.ReadToEnd(); Start-Process -FilePath $url",
      url,
    );
  }
  async openFolder(folder: string) {
    await exec("explorer.exe", [folder], { windowsHide: true }).catch(() => {});
  }
  async protect(secret: string) {
    return powershell(
      "Add-Type -AssemblyName System.Security; $value=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($value,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))",
      secret,
    );
  }
  async unprotect(cipher: string) {
    return powershell(
      "Add-Type -AssemblyName System.Security; $value=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($value,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))",
      cipher,
    );
  }
  async clientPaths(): Promise<ClientPath[]> {
    const user = process.env.USERPROFILE!;
    const entries: Omit<ClientPath, "installed">[] = [
      {
        id: "claude-code",
        name: "Claude Code",
        path: path.join(user, ".claude.json"),
        format: "json",
      },
      {
        id: "claude-desktop",
        name: "Claude Desktop",
        path: path.join(
          process.env.APPDATA!,
          "Claude",
          "claude_desktop_config.json",
        ),
        format: "json",
      },
      {
        id: "codex",
        name: "Codex",
        path: path.join(
          process.env.CODEX_HOME || path.join(user, ".codex"),
          "config.toml",
        ),
        format: "toml",
      },
      {
        id: "cursor",
        name: "Cursor",
        path: path.join(user, ".cursor", "mcp.json"),
        format: "json",
      },
    ];
    return Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        installed: await fs.access(entry.path).then(
          () => true,
          () => false,
        ),
      })),
    );
  }
  async findCloudflared() {
    try {
      const { stdout } = await exec("where.exe", ["cloudflared.exe"], {
        windowsHide: true,
      });
      return stdout.trim().split(/\r?\n/)[0] || null;
    } catch {
      return null;
    }
  }
  spawnTunnel(executable: string, token: string) {
    return spawn(executable, ["tunnel", "--no-autoupdate", "run"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TUNNEL_TOKEN: token },
    });
  }
  async stopProcess(child: ChildProcess) {
    if (child.pid && child.exitCode === null)
      await exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      }).catch(() => {});
  }
}
export function createPlatform(): PlatformAdapter {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new AppError("platform", "This beta supports Windows x64 only.");
  return new WindowsPlatform();
}
