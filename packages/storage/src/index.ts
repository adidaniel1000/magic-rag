import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { hash } from "@secondmind/core";
import type {
  Candidate,
  Chunk,
  Source,
  StoredDocument,
  SearchInput,
  VectorStore,
} from "@secondmind/core";

export class Store implements VectorStore {
  readonly db: DatabaseSync;
  constructor(
    filename: string,
    public dimensions = 384,
  ) {
    if (filename !== ":memory:")
      mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { allowExtension: true });
    sqliteVec.load(this.db);
    this.db.enableLoadExtension(false);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    const v = (this.db.prepare("PRAGMA user_version").get() as any)
      .user_version;
    if (v > 3)
      throw new Error(
        "Database was created by a newer version of Second Mind.",
      );
    if (v === 0)
      this.transaction(() => {
        this.db.exec(`
        CREATE TABLE sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,root TEXT NOT NULL UNIQUE,paused INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'queued',discovered INTEGER NOT NULL DEFAULT 0,indexed INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,last_sync TEXT,error TEXT,ignore_rules TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
        CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,path TEXT NOT NULL,title TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,mtime REAL NOT NULL,indexed_at TEXT NOT NULL,language TEXT,commit_id TEXT,UNIQUE(source_id,path));
        CREATE INDEX documents_hash ON documents(source_id,hash);
        CREATE TABLE chunks(rowid INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,text TEXT NOT NULL,parent_text TEXT NOT NULL,location TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT NOT NULL,tokens INTEGER NOT NULL);
        CREATE INDEX chunks_document ON chunks(document_id);
        CREATE VIRTUAL TABLE chunks_fts USING fts5(text,title,path,symbol,tokenize='unicode61');
        CREATE VIRTUAL TABLE vectors USING vec0(embedding float[${this.dimensions}] distance_metric=cosine);
        CREATE TABLE embedding_cache(cache_key TEXT PRIMARY KEY,vector BLOB NOT NULL);
        CREATE TABLE failures(source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,path TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_id,path));
        CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE metrics(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,integration TEXT NOT NULL,latency REAL NOT NULL,tokens INTEGER NOT NULL,result_count INTEGER NOT NULL);
        CREATE TABLE feedback(retrieval_id TEXT PRIMARY KEY REFERENCES metrics(id) ON DELETE CASCADE,rating TEXT NOT NULL);
        INSERT INTO state VALUES('index_version','0');
        INSERT INTO state VALUES('dimensions','${this.dimensions}');
        PRAGMA user_version=1;
      `);
      });
    if (v < 2)
      this.transaction(() => {
        this.db.exec(
          "ALTER TABLE documents ADD COLUMN model_key TEXT NOT NULL DEFAULT ''; PRAGMA user_version=2;",
        );
      });
    if (v < 3)
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE sections(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,section_key TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(document_id,section_key));
          ALTER TABLE chunks ADD COLUMN parent_key TEXT;
          UPDATE documents SET model_key='' WHERE id IN (SELECT document_id FROM chunks WHERE parent_text='');
          PRAGMA user_version=3;
        `);
      });
    if (Number(this.getState("dimensions")) !== this.dimensions)
      throw new Error(
        "Embedding dimensions differ. Rebuild the derived index.",
      );
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  getState(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM state WHERE key=?").get(key) as any
    )?.value;
  }
  setState(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  get version() {
    return Number(this.getState("index_version") || 0);
  }
  bump() {
    this.setState("index_version", String(this.version + 1));
  }
  sources(): Source[] {
    return (
      this.db
        .prepare("SELECT * FROM sources ORDER BY created_at")
        .all() as any[]
    ).map((s) => ({ ...s, paused: !!s.paused }));
  }
  source(id: string) {
    return this.sources().find((s) => s.id === id);
  }
  addSource(root: string, name: string) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO sources(id,name,root,created_at) VALUES(?,?,?,?)")
      .run(id, name, root, new Date().toISOString());
    return this.source(id)!;
  }
  updateSource(id: string, values: Partial<Source>) {
    const allowed = new Set([
      "name",
      "paused",
      "status",
      "discovered",
      "indexed",
      "failed",
      "last_sync",
      "error",
      "ignore_rules",
    ]);
    for (const [key, value] of Object.entries(values))
      if (allowed.has(key))
        this.db
          .prepare(`UPDATE sources SET ${key}=? WHERE id=?`)
          .run(typeof value === "boolean" ? +value : (value ?? null), id);
  }
  documents(sourceId: string): StoredDocument[] {
    return this.db
      .prepare(
        'SELECT *,commit_id AS "commit" FROM documents WHERE source_id=?',
      )
      .all(sourceId) as any;
  }
  document(sourceId: string, relativePath: string): StoredDocument | undefined {
    return this.db
      .prepare(
        'SELECT *,commit_id AS "commit" FROM documents WHERE source_id=? AND path=?',
      )
      .get(sourceId, relativePath) as any;
  }
  private removeDocument(id: string) {
    this.db
      .prepare(
        "DELETE FROM vectors WHERE rowid IN (SELECT rowid FROM chunks WHERE document_id=?)",
      )
      .run(id);
    this.db
      .prepare(
        "DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE document_id=?)",
      )
      .run(id);
    this.db.prepare("DELETE FROM documents WHERE id=?").run(id);
  }
  deleteDocuments(ids: string[]) {
    if (!ids.length) return;
    this.transaction(() => {
      for (const id of ids) this.removeDocument(id);
      this.bump();
    });
  }
  deleteSource(id: string) {
    this.transaction(() => {
      for (const d of this.documents(id)) this.removeDocument(d.id);
      this.db.prepare("DELETE FROM sources WHERE id=?").run(id);
      this.bump();
    });
  }
  replaceDocument(doc: StoredDocument, chunks: Chunk[]) {
    this.transaction(() => {
      this.removeDocument(doc.id);
      this.db
        .prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          doc.id,
          doc.source_id,
          doc.path,
          doc.title,
          doc.hash,
          doc.size,
          doc.mtime,
          doc.indexed_at,
          doc.language,
          doc.commit,
          doc.model_key || "",
        );
      const insert = this.db.prepare(
        "INSERT INTO chunks(id,document_id,ordinal,text,parent_text,location,kind,hash,tokens,parent_key) VALUES(?,?,?,?,?,?,?,?,?,?)",
      );
      const section = this.db.prepare(
        "INSERT OR IGNORE INTO sections VALUES(?,?,?)",
      );
      const fts = this.db.prepare(
        "INSERT INTO chunks_fts(rowid,text,title,path,symbol) VALUES(?,?,?,?,?)",
      );
      const vec = this.db.prepare(
        "INSERT INTO vectors(rowid,embedding) VALUES(?,?)",
      );
      for (const c of chunks) {
        const parentKey = hash(c.parentText);
        section.run(doc.id, parentKey, c.parentText);
        const rowid = insert.run(
          c.id,
          doc.id,
          c.ordinal,
          c.text,
          "",
          JSON.stringify(c.location),
          c.kind,
          c.hash,
          c.tokens,
          parentKey,
        ).lastInsertRowid;
        fts.run(rowid, c.text, doc.title, doc.path, c.location.symbol || "");
        vec.run(
          BigInt(rowid),
          new Uint8Array(new Float32Array(c.embedding).buffer),
        );
      }
      this.db
        .prepare("DELETE FROM failures WHERE source_id=? AND path=?")
        .run(doc.source_id, doc.path);
      this.bump();
    });
  }
  touchDocument(id: string, mtime: number, commit: string | null) {
    this.db
      .prepare("UPDATE documents SET mtime=?,commit_id=? WHERE id=?")
      .run(mtime, commit, id);
  }
  failure(sourceId: string, name: string, message: string) {
    this.db
      .prepare(
        "INSERT INTO failures VALUES(?,?,?,?) ON CONFLICT(source_id,path) DO UPDATE SET message=excluded.message,created_at=excluded.created_at",
      )
      .run(sourceId, name, message, new Date().toISOString());
  }
  clearFailures(sourceId: string) {
    this.db.prepare("DELETE FROM failures WHERE source_id=?").run(sourceId);
  }
  failures(sourceId?: string) {
    return sourceId
      ? this.db
          .prepare(
            "SELECT * FROM failures WHERE source_id=? ORDER BY created_at DESC LIMIT 200",
          )
          .all(sourceId)
      : this.db
          .prepare("SELECT * FROM failures ORDER BY created_at DESC LIMIT 200")
          .all();
  }
  cachedEmbedding(key: string): number[] | undefined {
    const row = this.db
      .prepare("SELECT vector FROM embedding_cache WHERE cache_key=?")
      .get(key) as any;
    if (!row) return undefined;
    const bytes = new Uint8Array(row.vector);
    return Array.from(new Float32Array(bytes.buffer));
  }
  cacheEmbedding(key: string, vector: number[]) {
    this.db
      .prepare("INSERT OR IGNORE INTO embedding_cache VALUES(?,?)")
      .run(key, new Uint8Array(new Float32Array(vector).buffer));
  }
  private eligible(sourceIds: string[], filters?: SearchInput["filters"]) {
    const params: (string | number)[] = [...sourceIds];
    let where = `d.source_id IN (${sourceIds.map(() => "?").join(",")})`;
    if (filters?.path_prefix) {
      where += " AND substr(d.path,1,?)=?";
      params.push(filters.path_prefix.length, filters.path_prefix);
    }
    if (filters?.language) {
      where += " AND d.language=?";
      params.push(filters.language);
    }
    return { where, params };
  }
  private candidates(rows: any[]): Candidate[] {
    return rows.map((r) => ({
      ...r,
      location: JSON.parse(r.location),
      modified_at: new Date(r.mtime).toISOString(),
      score: 0,
      ...(r.distance !== undefined ? { vectorScore: 1 - r.distance } : {}),
    }));
  }
  // Keep complete structural parents once on disk; only fetch bounded parents into candidate memory.
  private select = `c.id AS chunk_id,d.id AS document_id,d.source_id,d.path,d.title,c.text,COALESCE((SELECT CASE WHEN length(s.text)<=12000 THEN s.text ELSE '' END FROM sections s WHERE s.document_id=d.id AND s.section_key=c.parent_key),c.parent_text) AS parent_text,c.location,d.hash,d.indexed_at,d.mtime,d.language,d.commit_id AS "commit"`;
  vectorSearch(
    vector: number[],
    sourceIds: string[],
    limit: number,
    filters?: SearchInput["filters"],
  ): Candidate[] {
    if (!sourceIds.length) return [];
    const { where, params } = this.eligible(sourceIds, filters);
    const rows = this.db
      .prepare(
        `SELECT ${this.select},v.distance FROM (SELECT rowid,distance FROM vectors WHERE embedding MATCH ? AND k=? AND rowid IN (SELECT c.rowid FROM chunks c JOIN documents d ON d.id=c.document_id WHERE ${where})) v JOIN chunks c ON c.rowid=v.rowid JOIN documents d ON d.id=c.document_id ORDER BY v.distance`,
      )
      .all(new Uint8Array(new Float32Array(vector).buffer), limit, ...params);
    return this.candidates(rows);
  }
  lexicalSearch(
    query: string,
    sourceIds: string[],
    limit: number,
    filters?: SearchInput["filters"],
  ): Candidate[] {
    const terms = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) || [])].slice(
      0,
      64,
    );
    if (!terms.length || !sourceIds.length) return [];
    const match = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
    const { where, params } = this.eligible(sourceIds, filters);
    const rows = this.db
      .prepare(
        `SELECT ${this.select},bm25(chunks_fts,1,2,2,3) AS rank FROM chunks_fts JOIN chunks c ON c.rowid=chunks_fts.rowid JOIN documents d ON d.id=c.document_id WHERE chunks_fts MATCH ? AND ${where} ORDER BY rank LIMIT ?`,
      )
      .all(match, ...params, limit);
    return this.candidates(rows).map((c, i) => ({ ...c, lexicalRank: i + 1 }));
  }
  recordRetrieval(
    id: string,
    integration: string,
    latency: number,
    tokens: number,
    count: number,
  ) {
    this.db
      .prepare("INSERT INTO metrics VALUES(?,?,?,?,?,?)")
      .run(id, new Date().toISOString(), integration, latency, tokens, count);
    this.db
      .prepare(
        "DELETE FROM metrics WHERE created_at < datetime('now','-7 days')",
      )
      .run();
  }
  diagnostics() {
    return {
      documents: (
        this.db.prepare("SELECT count(*) AS n FROM documents").get() as any
      ).n,
      chunks: (this.db.prepare("SELECT count(*) AS n FROM chunks").get() as any)
        .n,
      requests: this.db
        .prepare(
          "SELECT count(*) AS count,avg(latency) AS average_latency,avg(tokens) AS average_tokens FROM metrics",
        )
        .get(),
      index_version: this.version,
      schema_version: 2,
    };
  }
}
