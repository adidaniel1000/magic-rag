import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
const args = process.argv.slice(2),
  at = args.indexOf("--base-url");
const base = at >= 0 ? args[at + 1] : process.env.SECONDMIND_INSTALL_BASE;
if (base) {
  const url = new URL(base);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTPS origin with no path or credentials.");
}
const run = (command: string, argv: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, argv, {
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Command exited ${code}`)),
    );
  });
const npm =
  process.env.npm_execpath ||
  path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
await run(process.execPath, [npm, "run", "build"]);
await fs.mkdir("artifacts", { recursive: true });
await run(process.execPath, [
  npm,
  "pack",
  "--ignore-scripts",
  "--pack-destination",
  "artifacts",
]);
const pkg = JSON.parse(await fs.readFile("package.json", "utf8")),
  filename = `${pkg.name}-${pkg.version}.tgz`;
const bytes = await fs.readFile(path.join("artifacts", filename));
if (bytes.length > 25 * 1024 * 1024)
  throw new Error("Package exceeds Cloudflare Pages per-file limit.");
await fs.mkdir("public/releases", { recursive: true });
await fs.writeFile(path.join("public/releases", filename), bytes);
const versions: any[] = await fetch("https://nodejs.org/dist/index.json").then(
  (r) => {
    if (!r.ok) throw new Error("Unable to resolve Node release.");
    return r.json();
  },
);
const nodeVersion = versions
  .find((v) => /^v24\./.test(v.version) && v.files.includes("win-x64-zip"))
  ?.version.slice(1);
if (!nodeVersion) throw new Error("No Node 24 Windows release found.");
const manifest = {
  version: pkg.version,
  package: `releases/${filename}`,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
  nodeVersion,
  createdAt: new Date().toISOString(),
};
await fs.writeFile(
  "public/release.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
await fs.writeFile(
  "public/releases/SHA256SUMS.txt",
  `${manifest.sha256}  ${filename}\n`,
);
let installer = await fs.readFile("public/install.ps1", "utf8");
installer = installer.replace(
  /^\s*\$InstallBase = .+$/m,
  `  $InstallBase = '${base ? new URL(base).origin.replaceAll("'", "''") : "__SECOND_MIND_BASE_URL__"}'`,
);
await fs.writeFile("public/install.ps1", installer);
console.log(
  base
    ? `Ready to deploy public/. Install: powershell -c "irm ${new URL(base).origin}/install.ps1 | iex"`
    : "public/ package prepared. Hostname remains unconfigured; run release again with --base-url https://YOUR-PROJECT.pages.dev before deployment.",
);
