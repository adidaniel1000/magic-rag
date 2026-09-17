import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const settingsSchema = z
  .object({
    port: z.number().int().min(1024).max(65535).default(32187),
    gatewayPort: z.number().int().min(1024).max(65535).default(32188),
    knowledgeTokens: z.number().int().min(64).max(12000).default(3000),
    codeTokens: z.number().int().min(64).max(12000).default(2500),
    vectorCandidates: z.number().int().min(1).max(200).default(30),
    lexicalCandidates: z.number().int().min(1).max(200).default(30),
    fusedCandidates: z.number().int().min(1).max(200).default(40),
    rerankCandidates: z.number().int().min(1).max(100).default(20),
    maxResults: z.number().int().min(1).max(30).default(10),
    minSimilarity: z.number().min(0).max(1).default(0.35),
    reconcileSeconds: z.number().int().min(10).max(86400).default(300),
    hashSeconds: z.number().int().min(60).max(604800).default(3600),
    maxFileBytes: z.number().int().min(1024).max(104857600).default(104857600),
    maxExtractedChars: z
      .number()
      .int()
      .min(1000)
      .max(50000000)
      .default(10000000),
    publicOrigin: z.string().default(""),
    cloudflaredPath: z.string().max(2000).default(""),
  })
  .strict()
  .refine(
    (s) => s.port !== s.gatewayPort,
    "The local and gateway ports must differ.",
  )
  .refine((s) => {
    if (!s.publicOrigin) return true;
    try {
      const u = new URL(s.publicOrigin);
      return (
        u.protocol === "https:" &&
        /^[a-z0-9.-]+$/i.test(u.hostname) &&
        !u.username &&
        !u.password &&
        u.pathname === "/" &&
        !u.search &&
        !u.hash &&
        u.port === ""
      );
    } catch {
      return false;
    }
  }, "Public origin must be an HTTPS hostname without a path, port, or credentials.")
  .transform((s) => ({
    ...s,
    publicOrigin: s.publicOrigin ? new URL(s.publicOrigin).origin : "",
  }));
export type Settings = z.infer<typeof settingsSchema>;
export const defaults = settingsSchema.parse({});
export async function atomicWrite(filename: string, data: string) {
  const temp = `${filename}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  try {
    await fs.writeFile(temp, data, { mode: 0o600 });
    await fs.rename(temp, filename);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
export async function loadSettings(directory: string): Promise<Settings> {
  try {
    return settingsSchema.parse(
      JSON.parse(
        await fs.readFile(path.join(directory, "settings.json"), "utf8"),
      ),
    );
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    return { ...defaults };
  }
}
export async function saveSettings(directory: string, settings: Settings) {
  await atomicWrite(
    path.join(directory, "settings.json"),
    JSON.stringify(settingsSchema.parse(settings), null, 2),
  );
}
export const DEFAULT_IGNORES = [
  ".git/",
  "node_modules/",
  ".venv/",
  "venv/",
  "dist/",
  "build/",
  ".cache/",
  "__pycache__/",
  ".secondmind/",
  ".env",
  ".env.*",
  "*.key",
  "*.pem",
];
