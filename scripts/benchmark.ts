import { promises as fs } from "node:fs";
import path from "node:path";
import { Store } from "@secondmind/storage";
import { temporary } from "../tests/helpers.js";
import { randomUUID } from "node:crypto";
import { LocalEmbeddings } from "@secondmind/embeddings";
import { Retriever } from "@secondmind/retrieval";
import { defaults } from "@secondmind/config";
import { evaluationCorpus } from "../tests/fixtures/evaluation.js";
const total = Number(process.env.SECONDMIND_BENCHMARK_CHUNKS || 285368),
  documentCount = 12439,
  directory = await temporary();
const store = new Store(path.join(directory, "scale.db")),
  embedding = new LocalEmbeddings(
    path.resolve(".secondmind-test/models"),
    path.resolve("dist/embedding-worker.js"),
    false,
  );
try {
  const texts = evaluationCorpus.map((d) => d.text),
    vectors = await embedding.embedDocuments(texts);
  const source = store.addSource(
    "synthetic-scale-fixture",
    "Synthetic scale fixture",
  );
  const start = performance.now();
  store.transaction(() => {
    const doc = store.db.prepare(
        "INSERT INTO documents(id,source_id,path,title,hash,size,mtime,indexed_at,language,commit_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ),
      chunk = store.db.prepare(
        "INSERT INTO chunks(rowid,id,document_id,ordinal,text,parent_text,location,kind,hash,tokens) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ),
      fts = store.db.prepare(
        "INSERT INTO chunks_fts(rowid,text,title,path,symbol) VALUES(?,?,?,?,?)",
      ),
      vector = store.db.prepare(
        "INSERT INTO vectors(rowid,embedding) VALUES(?,?)",
      );
    const ids = Array.from({ length: documentCount }, () => randomUUID()),
      date = new Date().toISOString();
    ids.forEach((id, i) =>
      doc.run(
        id,
        source.id,
        `replica/${i}.md`,
        `Document ${i}`,
        `synthetic-${i}`,
        1000,
        Date.now(),
        date,
        null,
        null,
      ),
    );
    for (let i = 0; i < total; i++) {
      const index = i % texts.length,
        document = i % documentCount,
        id = i + 1;
      chunk.run(
        id,
        `chunk-${id}`,
        ids[document],
        i,
        texts[index],
        "",
        "{}",
        "paragraph",
        `content-${index}`,
        100,
      );
      fts.run(
        id,
        texts[index],
        `Document ${document}`,
        `replica/${document}.md`,
        "",
      );
      vector.run(
        BigInt(id),
        new Uint8Array(new Float32Array(vectors[index]).buffer),
      );
    }
    store.bump();
  });
  const build_ms = Math.round(performance.now() - start);
  console.log(
    `Prepared ${total.toLocaleString()} synthetic scale chunks in ${build_ms}ms.`,
  );
  const retriever = new Retriever(store, embedding, () => defaults),
    rows = [];
  for (const query of evaluationCorpus
    .filter((_, i) => i % 3 === 0)
    .map((d) => d.queries[0]))
    for (let repeat = 0; repeat < 3; repeat++) {
      const r = await retriever.retrieve(
        { id: "benchmark", sourceIds: "*", integration: "scale" },
        query,
      );
      rows.push({
        query,
        repeat,
        latency_ms: r.latency_ms,
        tokens: r.token_count,
      });
    }
  const times = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  const warm = rows
    .filter((r) => r.repeat > 0)
    .map((r) => r.latency_ms)
    .sort((a, b) => a - b);
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const report = {
    kind: "Synthetic storage-scale benchmark at the previous corpus size; repeated representative real-model vectors, not a semantic rebuild of the user corpus",
    documents: documentCount,
    chunks: total,
    build_ms,
    database_bytes: (await fs.stat(path.join(directory, "scale.db"))).size,
    p50_ms: times[Math.floor(times.length * 0.5)],
    p95_ms: times[Math.floor(times.length * 0.95)],
    warm_p50_ms: warm[Math.floor(warm.length * 0.5)],
    warm_p95_ms: warm[Math.floor(warm.length * 0.95)],
    average_tokens: rows.reduce((sum, r) => sum + r.tokens, 0) / rows.length,
    rows,
  };
  await fs.mkdir("artifacts", { recursive: true });
  await fs.writeFile(
    "artifacts/scale-benchmark.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
} finally {
  await embedding.close();
  store.close();
}
