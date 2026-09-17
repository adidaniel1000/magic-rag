import { createHash } from "node:crypto";
import { z } from "zod";

export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const searchSchema = z
  .object({
    query: z.string().trim().min(1).max(10000),
    mode: z.enum(["knowledge", "code_navigation", "raw"]).default("knowledge"),
    max_tokens: z.number().int().min(64).max(12000).optional(),
    source_ids: z.array(z.string().uuid()).max(100).optional(),
    filters: z
      .object({
        path_prefix: z.string().max(500).optional(),
        language: z.string().max(40).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SearchInput = z.input<typeof searchSchema>;
export type SearchOptions = Omit<SearchInput, "query">;
export type Mode = "knowledge" | "code_navigation" | "raw";
export interface Principal {
  id: string;
  sourceIds: string[] | "*";
  integration: string;
}
export interface Location {
  heading?: string;
  page?: number;
  line_start?: number;
  line_end?: number;
  symbol?: string;
  symbol_type?: string;
}
export interface Section {
  text: string;
  location: Location;
  kind: string;
  parent?: string;
}
export interface ParsedDocument {
  title: string;
  sections: Section[];
  language?: string;
  imports?: string[];
}
export interface DocumentParser {
  supports(extension: string): boolean;
  parse(bytes: Uint8Array, filename: string): Promise<ParsedDocument>;
}
export interface Chunk {
  id: string;
  ordinal: number;
  text: string;
  parentText: string;
  location: Location;
  kind: string;
  hash: string;
  tokens: number;
  embedding: number[];
}
export interface EmbeddingProvider {
  modelId: string;
  revision: string;
  dimensions: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  split(text: string): Promise<string[]>;
  close(): Promise<void>;
}
export interface Source {
  id: string;
  name: string;
  root: string;
  paused: boolean;
  status: string;
  discovered: number;
  indexed: number;
  failed: number;
  last_sync: string | null;
  error: string | null;
  ignore_rules: string;
  created_at: string;
}
export interface StoredDocument {
  id: string;
  source_id: string;
  path: string;
  title: string;
  hash: string;
  size: number;
  mtime: number;
  indexed_at: string;
  language: string | null;
  commit: string | null;
  model_key?: string;
}
export interface Candidate {
  chunk_id: string;
  document_id: string;
  source_id: string;
  path: string;
  title: string;
  text: string;
  parent_text: string;
  location: Location;
  hash: string;
  indexed_at: string;
  modified_at: string;
  language: string | null;
  commit: string | null;
  score: number;
  vectorScore?: number;
  lexicalRank?: number;
}
export interface SearchResult {
  source_id: string;
  document_id: string;
  title: string;
  path: string;
  uri: string;
  score: number;
  text: string;
  location: Location;
  version: string;
  indexed_at: string;
  modified_at: string;
  commit?: string;
}
export interface RetrievalResponse {
  retrieval_id: string;
  context_text: string;
  token_count: number;
  tokenizer: string;
  results: SearchResult[];
  latency_ms: number;
  index_version: number;
}
export interface VectorStore {
  vectorSearch(
    vector: number[],
    sourceIds: string[],
    limit: number,
    filters?: SearchInput["filters"],
  ): Candidate[];
  lexicalSearch(
    query: string,
    sourceIds: string[],
    limit: number,
    filters?: SearchInput["filters"],
  ): Candidate[];
}
export interface Reranker {
  rank(query: string, candidates: Candidate[]): Promise<Candidate[]>;
}
export interface RetrievalService {
  retrieve(
    principal: Principal,
    query: string,
    options?: SearchOptions,
  ): Promise<RetrievalResponse>;
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function publicError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return "Operation failed. Check local diagnostics and try again.";
}
