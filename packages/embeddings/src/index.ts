import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import type { EmbeddingProvider } from "@secondmind/core";
import { AppError } from "@secondmind/core";

export const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export class LocalEmbeddings extends EventEmitter implements EmbeddingProvider {
  modelId = MODEL_ID;
  revision = MODEL_REVISION;
  dimensions = 384;
  private worker: Worker;
  private serial = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  progress: any = { status: "not_loaded" };
  constructor(cacheDir: string, workerFile: string, allowDownload = true) {
    super();
    this.worker = new Worker(workerFile, {
      workerData: {
        cacheDir,
        modelId: this.modelId,
        revision: this.revision,
        allowDownload,
      },
    });
    this.worker.on("message", (message) => {
      if (message.progress) {
        this.progress = message.progress;
        this.emit("progress", this.progress);
        return;
      }
      const task = this.pending.get(message.id);
      if (!task) return;
      this.pending.delete(message.id);
      clearTimeout(task.timer);
      message.error
        ? task.reject(new AppError("embedding", message.error, 503))
        : task.resolve(message.result);
    });
    const fail = () => {
      for (const task of this.pending.values()) {
        clearTimeout(task.timer);
        task.reject(
          new AppError(
            "embedding",
            "Embedding worker stopped. Restart Second Mind.",
            503,
          ),
        );
      }
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", fail);
  }
  private request(type: string, value: any): Promise<any> {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppError(
            "embedding_timeout",
            "Model setup or inference timed out. Check the connection and retry.",
            503,
          ),
        );
      }, 600000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, value });
    });
  }
  async initialize() {
    await this.request("initialize", null);
  }
  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.request("embed", texts);
  }
  async embedQuery(text: string) {
    const pieces = await this.split(text);
    const vectors = await this.embedDocuments(pieces);
    const mean = Array.from(
      { length: this.dimensions },
      (_, i) => vectors.reduce((s, v) => s + v[i], 0) / vectors.length,
    );
    const norm = Math.sqrt(mean.reduce((s, x) => s + x * x, 0)) || 1;
    return mean.map((x) => x / norm);
  }
  split(text: string): Promise<string[]> {
    return this.request("split", text);
  }
  async close() {
    await this.worker.terminate();
  }
}
