import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { LocalEmbeddings } from "@secondmind/embeddings";
import { Store } from "@secondmind/storage";
import { defaults } from "@secondmind/config";
import { Retriever, tokenCount } from "@secondmind/retrieval";
import { Indexer } from "../apps/service/src/indexer.js";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "secondmind-smoke-"));
const sources = path.join(root, "documents"),
  data = path.join(root, "data");
await fs.mkdir(sources);
await fs.writeFile(
  path.join(sources, "leave.md"),
  "# Family leave\n\nEmployees welcoming a newborn or adopting a child receive sixteen weeks of paid parental leave. Contact Human Resources to arrange coverage.",
);
await fs.writeFile(
  path.join(sources, "billing.md"),
  "# Billing decisions\n\nEnterprise annual contracts receive a twenty percent discount. The pricing committee selected annual invoicing to simplify procurement.",
);
const embedding = new LocalEmbeddings(
  path.resolve(process.env.SECONDMIND_SMOKE_CACHE || ".secondmind-test/models"),
  path.resolve("dist/embedding-worker.js"),
);
let last = "";
embedding.on("progress", (p) => {
  if (["progress", "progress_total"].includes(p.status)) return;
  const next = `${p.status} ${p.file || ""}`;
  if (next !== last) {
    process.stderr.write(next + "\n");
    last = next;
  }
});
const store = new Store(path.join(data, "index.db"));
const indexer = new Indexer(store, embedding, () => defaults, data);
try {
  await embedding.initialize();
  const pieces = await embedding.split(
    "unbelievablyLongIdentifier中文 ".repeat(200) + "end",
  );
  assert.equal(
    pieces.join(""),
    "unbelievablyLongIdentifier中文 ".repeat(200) + "end",
  );
  const source = await indexer.register(sources);
  await indexer.idle(source.id);
  assert.equal(
    store.documents(source.id).length,
    2,
    JSON.stringify(store.failures()),
  );
  const retriever = new Retriever(store, embedding, () => defaults);
  const owner = { id: "owner", sourceIds: "*" as const, integration: "smoke" };
  const result = await retriever.retrieve(
    owner,
    "What support is available after becoming a parent?",
    { max_tokens: 400 },
  );
  assert(result.results.some((r) => r.path === "leave.md"));
  assert(tokenCount(result.context_text) <= 400);
  const restricted = await retriever.retrieve(
    { id: "remote", sourceIds: [], integration: "smoke" },
    "parental leave",
  );
  assert.equal(restricted.results.length, 0);
  await fs.rm(path.join(sources, "leave.md"));
  indexer.schedule(source.id, true);
  await indexer.idle(source.id);
  assert.equal(store.documents(source.id).length, 1);
  console.log(
    JSON.stringify(
      {
        passed: true,
        model: embedding.modelId,
        revision: embedding.revision,
        semanticResult: result.results[0]?.path,
        latency_ms: result.latency_ms,
        token_count: result.token_count,
        directory: root,
      },
      null,
      2,
    ),
  );
} finally {
  const stopping = indexer.stop();
  await embedding.close();
  await stopping;
  store.close();
}
