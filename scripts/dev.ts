import { spawn } from "node:child_process";
// Build the UI and service together so development keeps the production same-origin security boundary.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const build = spawn(npm, ["run", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
build.on("exit", (code) => {
  if (code) {
    process.exitCode = code;
    return;
  }
  const child = spawn(process.execPath, ["dist/cli.js"], { stdio: "inherit" });
  process.on("SIGINT", () => child.kill("SIGINT"));
  child.on("exit", (code) => (process.exitCode = code || 0));
});
