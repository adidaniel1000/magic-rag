import { promises as fs } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import ignore from "ignore";
import {
  AppError,
  hash,
  type EmbeddingProvider,
  type Chunk,
  type Section,
} from "@secondmind/core";
import { DEFAULT_IGNORES, type Settings } from "@secondmind/config";
import { Parsers, ParserWorker } from "@secondmind/parsers";
import type { Store } from "@secondmind/storage";
import { tokenCount } from "@secondmind/retrieval";
const exec = promisify(execFile);
export const within = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
};
export async function safeRoot(root: string, dataDirectory: string) {
  if (!path.isAbsolute(root))
    throw new AppError("folder", "Choose an absolute folder path.");
  const real = await fs.realpath(root);
  const stat = await fs.stat(real);
  if (!stat.isDirectory())
    throw new AppError("folder", "The selected path is not a folder.");
  if (within(real, dataDirectory) || within(dataDirectory, real))
    throw new AppError(
      "folder",
      "Choose a folder outside Second Mind application data.",
    );
  return real;
}
export class Indexer extends EventEmitter {
  private watchers = new Map<string, FSWatcher>();
  private active = new Map<string, Promise<void>>();
  private queued = new Map<string, boolean>();
  private dirty = new Map<string, Set<string>>();
  private debounce = new Map<string, NodeJS.Timeout>();
  private lastHash = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private parserWorker?: ParserWorker;
  constructor(
    private store: Store,
    private embeddings: EmbeddingProvider,
    private settings: () => Settings,
    private dataDirectory: string,
    parserWorkerFile?: string,
  ) {
    super();
    if (parserWorkerFile)
      this.parserWorker = new ParserWorker(parserWorkerFile);
  }
  async start() {
    for (const s of this.store.sources()) {
      await this.watch(s.id);
      this.schedule(s.id, true);
    }
    this.timer = setInterval(() => {
      for (const s of this.store.sources())
        if (!s.paused)
          this.schedule(
            s.id,
            Date.now() - (this.lastHash.get(s.id) || 0) >
              this.settings().hashSeconds * 1000,
          );
    }, this.settings().reconcileSeconds * 1000);
  }
  async register(root: string, name?: string) {
    const real = await safeRoot(root, this.dataDirectory);
    if (
      this.store
        .sources()
        .some((s) => within(s.root, real) || within(real, s.root))
    )
      throw new AppError(
        "overlap",
        "This folder overlaps an existing knowledge folder.",
      );
    const source = this.store.addSource(
      real,
      name?.trim() || path.basename(real) || real,
    );
    await this.watch(source.id);
    this.schedule(source.id, true);
    return source;
  }
  async watch(id: string) {
    const source = this.store.source(id);
    if (!source || this.watchers.has(id)) return;
    const watcher = chokidar.watch(source.root, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 750, pollInterval: 100 },
      ignored: (p: string) => {
        const rel = path.relative(source.root, p).split(path.sep).join("/");
        return /(^|\/)(node_modules|\.git|\.venv|venv|\.cache)(\/|$)/.test(rel);
      },
    });
    watcher.on("all", (_event, p) => {
      const set = this.dirty.get(id) || new Set<string>();
      set.add(path.relative(source.root, p).split(path.sep).join("/"));
      this.dirty.set(id, set);
      clearTimeout(this.debounce.get(id));
      this.debounce.set(
        id,
        setTimeout(() => this.schedule(id, false), 600),
      );
    });
    watcher.on("error", () => {
      this.store.updateSource(id, {
        error:
          "Folder watching interrupted; periodic reconciliation remains active.",
      });
      this.emit("change");
    });
    this.watchers.set(id, watcher);
  }
  schedule(id: string, force = false) {
    if (this.stopped || !this.store.source(id) || this.store.source(id)!.paused)
      return;
    if (this.active.has(id)) {
      this.queued.set(id, this.queued.get(id) || false || force);
      return;
    }
    const job = this.scan(id, force)
      .catch(() => {
        if (this.store.source(id))
          this.store.updateSource(id, {
            status: "error",
            error: "Indexing interrupted. Retry synchronization.",
          });
      })
      .finally(() => {
        this.active.delete(id);
        this.emit("change");
        if (this.queued.has(id)) {
          const again = this.queued.get(id)!;
          this.queued.delete(id);
          this.schedule(id, again);
        }
      });
    this.active.set(id, job);
  }
  async idle(id?: string) {
    do {
      await Promise.all(id ? [this.active.get(id)] : this.active.values());
    } while (id ? this.active.has(id) : this.active.size);
  }
  async pause(id: string, paused: boolean) {
    this.store.updateSource(id, {
      paused,
      status: paused ? "paused" : "queued",
    });
    if (!paused) this.schedule(id, true);
    this.emit("change");
  }
  async remove(id: string) {
    this.store.updateSource(id, { paused: true });
    this.queued.delete(id);
    await this.watchers.get(id)?.close();
    this.watchers.delete(id);
    await this.active.get(id);
    this.store.deleteSource(id);
    this.dirty.delete(id);
    clearTimeout(this.debounce.get(id));
    this.emit("change");
  }
  async rebuild(id: string) {
    this.schedule(id, true);
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const t of this.debounce.values()) clearTimeout(t);
    await this.parserWorker?.close();
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    await Promise.all(this.active.values());
  }
  private running(id: string) {
    return (
      !this.stopped && !!this.store.source(id) && !this.store.source(id)!.paused
    );
  }
  private async scan(id: string, force: boolean) {
    const source = this.store.source(id)!;
    const settings = this.settings();
    const parsers = new Parsers(settings.maxExtractedChars);
    try {
      const real = await fs.realpath(source.root);
      if (real !== source.root) throw new Error("root changed");
      await fs.access(source.root);
    } catch {
      this.store.updateSource(id, {
        status: "unavailable",
        error:
          "Knowledge folder is unavailable. Existing index retained; reconnect the folder to synchronize.",
      });
      return;
    }
    const rules = ignore().add(DEFAULT_IGNORES);
    try {
      rules.add(
        await fs.readFile(path.join(source.root, ".secondmindignore"), "utf8"),
      );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    rules.add(source.ignore_rules);
    const dirty = this.dirty.get(id) || new Set<string>();
    this.dirty.delete(id);
    if (dirty.has(".secondmindignore")) force = true;
    const files: { absolute: string; relative: string }[] = [];
    let complete = true;
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        complete = false;
        return;
      }
      for (const entry of entries) {
        if (!this.running(id)) return;
        const absolute = path.join(dir, entry.name),
          relative = path
            .relative(source.root, absolute)
            .split(path.sep)
            .join("/");
        if (
          entry.isSymbolicLink() ||
          rules.ignores(relative + (entry.isDirectory() ? "/" : ""))
        )
          continue;
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile() && parsers.supports(path.extname(entry.name)))
          files.push({ absolute, relative });
      }
    };
    this.store.updateSource(id, { status: "discovering", error: null });
    this.emit("change");
    await walk(source.root);
    if (!this.running(id)) return;
    this.store.updateSource(id, {
      status: "indexing",
      discovered: files.length,
      indexed: 0,
      failed: 0,
    });
    this.store.clearFailures(id);
    this.emit("change");
    let commit: string | null = null;
    try {
      commit = (
        await exec("git", ["-C", source.root, "rev-parse", "HEAD"], {
          windowsHide: true,
          timeout: 5000,
        })
      ).stdout.trim();
    } catch {}
    let indexed = 0,
      failed = 0;
    const seen = new Set(files.map((f) => f.relative));
    for (const file of files) {
      if (!this.running(id)) return;
      const old = this.store.document(id, file.relative);
      try {
        const real = await fs.realpath(file.absolute);
        if (!within(source.root, real))
          throw new AppError(
            "boundary",
            "File resolves outside the knowledge folder.",
          );
        const link = await fs.lstat(file.absolute);
        if (link.isSymbolicLink()) continue;
        const stat = await fs.stat(real);
        if (stat.size > settings.maxFileBytes)
          throw new AppError(
            "file_limit",
            "File exceeds the configured size limit.",
          );
        if (
          old &&
          !force &&
          !dirty.has(file.relative) &&
          old.size === stat.size &&
          old.mtime === stat.mtimeMs &&
          old.model_key ===
            `${this.embeddings.modelId}@${this.embeddings.revision}`
        ) {
          indexed++;
          continue;
        }
        const bytes = await fs.readFile(real);
        const digest = hash(bytes);
        if (
          old &&
          old.hash === digest &&
          old.model_key ===
            `${this.embeddings.modelId}@${this.embeddings.revision}`
        ) {
          this.store.touchDocument(old.id, stat.mtimeMs, commit);
          indexed++;
          continue;
        }
        const parsed = this.parserWorker
          ? await this.parserWorker.parse(
              bytes,
              file.relative,
              settings.maxExtractedChars,
            )
          : await parsers.parse(bytes, file.relative);
        const chunks: Chunk[] = [];
        // Combine adjacent prose into structural parent sections, then honor the embedding tokenizer's smaller window.
        const parents: Section[] = [];
        for (const section of parsed.sections) {
          const last = parents.at(-1);
          if (
            last &&
            last.location.heading === section.location.heading &&
            last.location.page === section.location.page &&
            !last.location.symbol &&
            !section.location.symbol &&
            last.kind !== "code_block" &&
            tokenCount(last.text + "\n\n" + section.text) <= 550
          ) {
            last.text += "\n\n" + section.text;
            last.location.line_end = section.location.line_end;
          } else
            parents.push({ ...section, location: { ...section.location } });
        }
        for (const section of parents) {
          if (!this.running(id)) return;
          const parts = await this.embeddings.split(section.text);
          let consumed = "";
          for (const text of parts) {
            if (!text.trim()) {
              consumed += text;
              continue;
            }
            const location = { ...section.location };
            if (location.line_start) {
              location.line_start += (consumed.match(/\n/g) || []).length;
              location.line_end =
                location.line_start + (text.match(/\n/g) || []).length;
            }
            const contentHash = hash(text),
              key = hash(
                `${this.embeddings.modelId}@${this.embeddings.revision}:${contentHash}`,
              );
            chunks.push({
              id: randomUUID(),
              ordinal: chunks.length,
              text,
              parentText: section.text,
              location,
              kind: section.kind,
              hash: contentHash,
              tokens: tokenCount(text),
              embedding: this.store.cachedEmbedding(key) || [],
            });
            consumed += text;
          }
        }
        for (let n = 0; n < chunks.length; n += 16) {
          if (!this.running(id)) return;
          const batch = chunks
            .slice(n, n + 16)
            .filter((c) => !c.embedding.length);
          if (!batch.length) continue;
          const vectors = await this.embeddings.embedDocuments(
            batch.map((c) => c.text),
          );
          batch.forEach((c, i) => {
            c.embedding = vectors[i];
            this.store.cacheEmbedding(
              hash(
                `${this.embeddings.modelId}@${this.embeddings.revision}:${c.hash}`,
              ),
              c.embedding,
            );
          });
        }
        if (!this.running(id)) return;
        const after = await fs.stat(file.absolute);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
          this.queued.set(id, true);
          continue;
        }
        this.store.replaceDocument(
          {
            id: old?.id || randomUUID(),
            source_id: id,
            path: file.relative,
            title: parsed.title,
            hash: digest,
            size: stat.size,
            mtime: stat.mtimeMs,
            indexed_at: new Date().toISOString(),
            language: parsed.language || null,
            commit,
            model_key: `${this.embeddings.modelId}@${this.embeddings.revision}`,
          },
          chunks,
        );
        indexed++;
      } catch (e: any) {
        if (!this.running(id)) return;
        if (
          e instanceof AppError &&
          ["embedding", "embedding_timeout"].includes(e.code)
        ) {
          this.store.updateSource(id, {
            status: "error",
            error: e.message,
            indexed,
            failed,
          });
          this.emit("change");
          return;
        }
        if (old) this.store.deleteDocuments([old.id]);
        failed++;
        this.store.failure(
          id,
          file.relative,
          e instanceof AppError
            ? e.message
            : "Unable to read or parse this file. Check its format and permissions.",
        );
      }
      this.store.updateSource(id, { indexed, failed });
      this.emit("change");
    }
    if (!this.running(id)) return;
    if (complete)
      this.store.deleteDocuments(
        this.store
          .documents(id)
          .filter((d) => !seen.has(d.path))
          .map((d) => d.id),
      );
    this.store.setState(
      "embedding_model",
      `${this.embeddings.modelId}@${this.embeddings.revision}`,
    );
    if (force) this.lastHash.set(id, Date.now());
    this.store.updateSource(id, {
      indexed,
      failed,
      status: failed || !complete ? "degraded" : "ready",
      last_sync: new Date().toISOString(),
      error: complete
        ? null
        : "Some directories were unreadable. Deletion reconciliation was deferred.",
    });
    this.emit("change");
  }
}
