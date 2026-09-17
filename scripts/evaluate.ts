import { promises as fs } from "node:fs";
import path from "node:path";
import { temporary } from "../tests/helpers.js";
import { evaluationCorpus } from "../tests/fixtures/evaluation.js";
import { LocalEmbeddings } from "@secondmind/embeddings";
import { Store } from "@secondmind/storage";
import { defaults } from "@secondmind/config";
import { Retriever } from "@secondmind/retrieval";
import { Indexer } from "../apps/service/src/indexer.js";
const directory = await temporary(),
  folder = path.join(directory, "corpus"),
  data = path.join(directory, "data");
await fs.mkdir(folder);
for (const doc of evaluationCorpus) {
  const filename = path.join(folder, doc.path);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, doc.text);
}
const embedding = new LocalEmbeddings(
  path.resolve(".secondmind-test/models"),
  path.resolve("dist/embedding-worker.js"),
  false,
);
const store = new Store(path.join(data, "index.db")),
  indexer = new Indexer(store, embedding, () => defaults, data),
  retriever = new Retriever(store, embedding, () => defaults);
try {
  const started = performance.now();
  const source = await indexer.register(folder);
  await indexer.idle();
  const indexing_ms = Math.round(performance.now() - started);
  if (store.documents(source.id).length !== 60)
    throw new Error(JSON.stringify(store.failures()));
  const rows: any[] = [];
  for (const document of evaluationCorpus)
    for (const query of document.queries) {
      const response = await retriever.retrieve(
        { id: "evaluator", sourceIds: "*", integration: "evaluation" },
        query,
        {
          mode: document.category === "code" ? "code_navigation" : "knowledge",
        },
      );
      const paths = [...new Set(response.results.map((r) => r.path))];
      const rank = paths.indexOf(document.path) + 1;
      rows.push({
        category: document.category,
        query,
        expected: document.path,
        returned: paths,
        rank,
        recall: rank > 0 && rank <= 10 ? 1 : 0,
        reciprocal_rank: rank > 0 ? 1 / rank : 0,
        ndcg: rank > 0 ? 1 / Math.log2(rank + 1) : 0,
        tokens: response.token_count,
        latency_ms: response.latency_ms,
      });
    }
  const aggregate = (items: any[]) => {
    const times = items.map((r) => r.latency_ms).sort((a, b) => a - b),
      mean = (key: string) =>
        items.reduce((s, r) => s + r[key], 0) / items.length;
    return {
      queries: items.length,
      recall_at_10: mean("recall"),
      mrr: mean("reciprocal_rank"),
      ndcg_at_10: mean("ndcg"),
      average_tokens: mean("tokens"),
      p50_ms: times[Math.floor(times.length * 0.5)],
      p95_ms: times[Math.floor(times.length * 0.95)],
    };
  };
  const report = {
    kind: "Synthetic regression evaluation; not independently judged real-world quality",
    model: embedding.modelId,
    revision: embedding.revision,
    indexing_ms,
    documents: 60,
    overall: aggregate(rows),
    categories: Object.fromEntries(
      ["personal", "enterprise", "code"].map((c) => [
        c,
        aggregate(rows.filter((r) => r.category === c)),
      ]),
    ),
    results: rows,
  };
  await fs.mkdir("artifacts", { recursive: true });
  await fs.writeFile(
    "artifacts/evaluation.json",
    JSON.stringify(report, null, 2),
  );
  await fs.writeFile(
    "tests/fixtures/evaluation-queries.json",
    JSON.stringify(
      rows.map((r) => ({
        category: r.category,
        query: r.query,
        expected_documents: [r.expected],
      })),
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
  if (
    report.overall.recall_at_10 < 0.9 ||
    report.categories.code.recall_at_10 < 0.9
  )
    process.exitCode = 1;
} finally {
  const stopping = indexer.stop();
  await embedding.close();
  await stopping;
  store.close();
}
