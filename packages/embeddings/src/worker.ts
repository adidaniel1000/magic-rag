import { parentPort, workerData } from "node:worker_threads";
import { env, pipeline, AutoTokenizer } from "@huggingface/transformers";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
env.cacheDir = workerData.cacheDir;
env.allowRemoteModels = false;
env.localModelPath = "";
const artifacts: Record<string, string> = {
  "config.json":
    "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
  "tokenizer_config.json":
    "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  "tokenizer.json":
    "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  "onnx/model_quantized.onnx":
    "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
};
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function prepareModel() {
  const directory = path.join(
    workerData.cacheDir,
    workerData.modelId,
    workerData.revision,
  );
  for (const [name, checksum] of Object.entries(artifacts)) {
    const filename = path.join(directory, name);
    if (
      await fs.readFile(filename).then(
        (b) => digest(b) === checksum,
        () => false,
      )
    )
      continue;
    if (!workerData.allowDownload)
      throw new Error(
        "Model cache is incomplete. Prepare the model while connected to the internet.",
      );
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temp = `${filename}.${randomUUID()}.tmp`;
    try {
      const response = await fetch(
        `https://huggingface.co/${workerData.modelId}/resolve/${workerData.revision}/${name}`,
        { signal: AbortSignal.timeout(600000) },
      );
      if (!response.ok || !response.body)
        throw new Error(
          "Model download failed. Check the internet connection and retry.",
        );
      const handle = await fs.open(temp, "wx"),
        sum = createHash("sha256");
      const total = Number(response.headers.get("content-length") || 0);
      let loaded = 0,
        last = 0;
      try {
        for await (const piece of response.body as any) {
          const bytes = Buffer.from(piece);
          loaded += bytes.length;
          if (loaded > 50 * 1024 * 1024)
            throw new Error("Unexpected model file size.");
          sum.update(bytes);
          await handle.write(bytes);
          if (Date.now() - last > 200) {
            parentPort!.postMessage({
              progress: {
                status: "downloading",
                file: name,
                loaded,
                total,
                progress: total ? (100 * loaded) / total : 0,
              },
            });
            last = Date.now();
          }
        }
      } finally {
        await handle.close();
      }
      if (sum.digest("hex") !== checksum)
        throw new Error("Model checksum did not match. Retry setup.");
      await fs.rename(temp, filename);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
  return directory.replaceAll("\\", "/");
}
let extractor: any, tokenizer: any;
async function initialize() {
  if (extractor) return;
  parentPort!.postMessage({ progress: { status: "loading" } });
  const modelPath = await prepareModel();
  const options = { local_files_only: true, cache_dir: workerData.cacheDir };
  tokenizer = await AutoTokenizer.from_pretrained(modelPath, options);
  extractor = await pipeline("feature-extraction", modelPath, {
    ...options,
    dtype: "q8",
    device: "cpu",
  });
  parentPort!.postMessage({
    progress: { status: "ready", model: workerData.modelId },
  });
}
function split(text: string): string[] {
  if (!text) return [];
  const pieces: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let low = 1,
      high = Math.min(text.length - offset, 3000),
      best = 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (tokenizer.encode(text.slice(offset, offset + mid)).length <= 220) {
        best = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    let end = offset + best;
    if (end < text.length) {
      const slice = text.slice(offset, end);
      const match = /[\s\n][^\s\n]*$/.exec(slice);
      if (match && match.index > best / 2) end = offset + match.index + 1;
      if (end > offset && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    }
    pieces.push(text.slice(offset, end));
    offset = end;
  }
  return pieces;
}
let queue = Promise.resolve();
parentPort!.on("message", (message) => {
  queue = queue.then(async () => {
    try {
      await initialize();
      let result: any;
      if (message.type === "initialize") result = true;
      else if (message.type === "split") result = split(message.value);
      else {
        for (const t of message.value)
          if (tokenizer.encode(t).length > 256)
            throw new Error("Embedding input exceeds model limit.");
        const output = await extractor(message.value, {
          pooling: "mean",
          normalize: true,
        });
        result = output.tolist();
      }
      parentPort!.postMessage({ id: message.id, result });
    } catch (e: any) {
      parentPort!.postMessage({ progress: { status: "error" } });
      parentPort!.postMessage({
        id: message.id,
        error: `Local model unavailable: ${String(e.message)
          .replace(/https?:\/\/\S+/g, "[model download]")
          .slice(0, 200)}`,
      });
    }
  });
});
