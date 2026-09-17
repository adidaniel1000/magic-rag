import { promises as fs } from "node:fs";
import path from "node:path";
import { createService } from "../apps/service/src/server.js";
import { defaults, saveSettings } from "@secondmind/config";
import { temporary, TestPlatform, FakeEmbeddings } from "./helpers.js";
const directory = await temporary();
await saveSettings(directory, { ...defaults, port: 32287, gatewayPort: 32288 });
const service = await createService({
  directory,
  platform: new TestPlatform(directory),
  embeddings: new FakeEmbeddings(),
  webDirectory: path.resolve("dist/web"),
  entrypoint: path.resolve("dist/cli.js"),
});
await fs.mkdir(".secondmind-test", { recursive: true });
await fs.writeFile(
  ".secondmind-test/ui-bootstrap.json",
  JSON.stringify({ url: service.bootstrap(), directory }),
);
process.on("SIGTERM", () => void service.shutdown());
process.on("SIGINT", () => void service.shutdown());
await service.closed;
