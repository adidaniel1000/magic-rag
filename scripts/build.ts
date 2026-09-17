import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const common = {
  bundle: true,
  platform: "node" as const,
  target: "node24",
  format: "esm" as const,
  sourcemap: true,
  packages: "external" as const,
};
// Workspace packages are bundled; installed third-party dependencies remain external.
const workspacePlugin = {
  name: "workspace",
  setup(b: any) {
    b.onResolve({ filter: /^@secondmind\// }, (args: any) => ({
      path: `${process.cwd()}/packages/${args.path.split("/")[1]}/src/index.ts`,
    }));
  },
};
await build({
  ...common,
  plugins: [workspacePlugin],
  entryPoints: ["apps/service/src/cli.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
});
await build({
  ...common,
  plugins: [workspacePlugin],
  entryPoints: ["packages/embeddings/src/worker.ts"],
  outfile: "dist/embedding-worker.js",
});
await build({
  ...common,
  plugins: [workspacePlugin],
  entryPoints: ["packages/parsers/src/worker.ts"],
  outfile: "dist/parser-worker.js",
});
await viteBuild({ configFile: "apps/web/vite.config.ts" });
