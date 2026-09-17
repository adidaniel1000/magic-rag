import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { Store } from "@secondmind/storage";
import { defaults } from "@secondmind/config";
import { AppError } from "@secondmind/core";
import { Indexer } from "../apps/service/src/indexer.js";
import { Tunnel } from "../apps/service/src/tunnel.js";
import { temporary, FakeEmbeddings, TestPlatform } from "./helpers.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("State did not converge");
}

it("preserves a complete long structural parent once and indexes every child", async () => {
  const root = await temporary(),
    folder = path.join(root, "docs");
  await fs.mkdir(folder);
  const text = "parent leave policy ".repeat(1400);
  await fs.writeFile(path.join(folder, "long.txt"), text);
  const store = new Store(":memory:", 4),
    indexer = new Indexer(
      store,
      new FakeEmbeddings(),
      () => defaults,
      path.join(root, "data"),
    );
  try {
    await indexer.register(folder);
    await indexer.idle();
    const rows = store.db
      .prepare("SELECT text FROM chunks ORDER BY ordinal")
      .all() as { text: string }[];
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.map((r) => r.text).join("")).toBe(text);
    const parents = store.db.prepare("SELECT text FROM sections").all();
    expect(parents).toHaveLength(1);
    expect(parents[0].text).toBe(text);
  } finally {
    await indexer.stop();
    store.close();
  }
});

it("recovers an interrupted model rebuild after a restart while keeping prior retrieval available", async () => {
  const root = await temporary(),
    folder = path.join(root, "docs"),
    database = path.join(root, "index.db");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "policy.txt"), "parent leave policy");
  let store = new Store(database, 4),
    embedding = new FakeEmbeddings(),
    indexer = new Indexer(
      store,
      embedding,
      () => defaults,
      path.join(root, "data"),
    );
  const source = await indexer.register(folder);
  await indexer.idle();
  await indexer.stop();
  store.close();
  store = new Store(database, 4);
  embedding = new FakeEmbeddings();
  embedding.revision = "2";
  embedding.embedDocuments = async () => {
    throw new AppError("embedding", "Interrupted model download");
  };
  indexer = new Indexer(
    store,
    embedding,
    () => defaults,
    path.join(root, "data"),
  );
  try {
    await indexer.start();
    await indexer.idle();
    expect(store.source(source.id)?.status).toBe("error");
    expect(store.lexicalSearch("parent", [source.id], 10)).toHaveLength(1);
  } finally {
    await indexer.stop();
    store.close();
  }
  store = new Store(database, 4);
  embedding = new FakeEmbeddings();
  embedding.revision = "2";
  indexer = new Indexer(
    store,
    embedding,
    () => defaults,
    path.join(root, "data"),
  );
  try {
    await indexer.start();
    await indexer.idle();
    expect(store.source(source.id)?.status).toBe("ready");
    expect(store.documents(source.id)[0].model_key).toBe("test-only@2");
    expect(embedding.calls).toBeGreaterThan(0);
  } finally {
    await indexer.stop();
    store.close();
  }
});

it("detects edits and deletes through the filesystem watcher without a manual scan", async () => {
  const root = await temporary(),
    folder = path.join(root, "docs");
  await fs.mkdir(folder);
  const filename = path.join(folder, "policy.txt");
  await fs.writeFile(filename, "parent leave");
  const store = new Store(":memory:", 4),
    indexer = new Indexer(
      store,
      new FakeEmbeddings(),
      () => defaults,
      path.join(root, "data"),
    );
  try {
    const source = await indexer.register(folder);
    await indexer.idle();
    await new Promise((r) => setTimeout(r, 300));
    await fs.writeFile(filename, "annual billing discount");
    await until(
      () => store.lexicalSearch("billing", [source.id], 10).length === 1,
    );
    expect(store.lexicalSearch("parent", [source.id], 10)).toHaveLength(0);
    await fs.unlink(filename);
    await until(() => store.documents(source.id).length === 0);
  } finally {
    await indexer.stop();
    store.close();
  }
});

it("reconciles missed events and detects same-size edits whose timestamps were restored", async () => {
  const root = await temporary(),
    folder = path.join(root, "docs"),
    file = path.join(folder, "a.txt");
  await fs.mkdir(folder);
  await fs.writeFile(file, "parent leave");
  const store = new Store(":memory:", 4),
    indexer = new Indexer(
      store,
      new FakeEmbeddings(),
      () => defaults,
      path.join(root, "data"),
    );
  const source = await indexer.register(folder);
  await indexer.idle();
  await indexer.stop();
  const before = await fs.stat(file);
  await fs.writeFile(file, "annual bills");
  await fs.utimes(file, before.atime, before.mtime);
  const resumed = new Indexer(
    store,
    new FakeEmbeddings(),
    () => ({ ...defaults, reconcileSeconds: 0.1, hashSeconds: 0.1 }),
    path.join(root, "data"),
  );
  try {
    await resumed.start();
    await until(
      () => store.lexicalSearch("bills", [source.id], 10).length === 1,
    );
    expect(store.lexicalSearch("parent", [source.id], 10)).toHaveLength(0);
  } finally {
    await resumed.stop();
    store.close();
  }
});

it("migrates the previous schema without losing searchable documents", async () => {
  const root = await temporary(),
    file = path.join(root, "index.db");
  let store = new Store(file, 4);
  const folder = path.join(root, "docs");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "policy.txt"), "parent leave policy");
  const indexer = new Indexer(
    store,
    new FakeEmbeddings(),
    () => defaults,
    path.join(root, "data"),
  );
  const source = await indexer.register(folder, "Migration");
  await indexer.idle();
  await indexer.stop();
  store.db.exec(
    "DROP TABLE sections; ALTER TABLE chunks DROP COLUMN parent_key; ALTER TABLE documents DROP COLUMN model_key; PRAGMA user_version=1;",
  );
  store.close();
  store = new Store(file, 4);
  try {
    expect(store.source(source.id)?.name).toBe("Migration");
    expect(store.lexicalSearch("parent", [source.id], 10)).toHaveLength(1);
    expect(store.vectorSearch([1, 0, 0, 0], [source.id], 10)).toHaveLength(1);
    expect(store.documents(source.id)[0].model_key).toBe("");
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(
      store.db.prepare("SELECT count(*) AS n FROM sections").get()?.n,
    ).toBe(0);
  } finally {
    store.close();
  }
});

it("cancels an in-flight tunnel start and stops the child it owns", async () => {
  const root = await temporary(),
    platform = new TestPlatform(root);
  let resolveDiscovery!: (value: string) => void;
  platform.findCloudflared = () =>
    new Promise<any>((resolve) => (resolveDiscovery = resolve));
  let spawned = 0;
  const spawn = platform.spawnTunnel.bind(platform);
  platform.spawnTunnel = (exe, token) => {
    spawned++;
    return spawn(exe, token);
  };
  const tunnel = new Tunnel(platform, root, () => ({
    ...defaults,
    publicOrigin: "https://mcp.example.com",
  }));
  await tunnel.setToken("private-test-token");
  const starting = tunnel.start();
  await tunnel.stop();
  resolveDiscovery("fake-cloudflared");
  await starting;
  expect(spawned).toBe(0);
  expect(tunnel.status.state).toBe("stopped");
  platform.findCloudflared = async () => "fake-cloudflared" as any;
  let child: ReturnType<typeof spawn> | undefined;
  platform.spawnTunnel = (exe, token) => (child = spawn(exe, token));
  await tunnel.start();
  expect(child).toBeTruthy();
  const closed = once(child!, "close");
  await tunnel.stop();
  await closed;
  expect(tunnel.status.state).toBe("stopped");
  expect(JSON.stringify(tunnel.status)).not.toContain("private-test-token");
});
