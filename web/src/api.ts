export interface Settings {
  folders: string[];
  mcp_port: number;
  ui_port: number;
}
export interface Connector {
  id: string;
  name: string;
  label: string;
  instructions: string;
  commands: string;
}
export interface Snapshot {
  settings: Settings;
  settings_error: string | null;
  folders: { path: string; resolved: string; available: boolean }[];
  ui_port: number;
  mcp: {
    state: string;
    owned: boolean;
    active_port: number | null;
    saved_port: number;
    endpoint: string | null;
    pending_port: boolean;
    available: boolean;
    error: string | null;
  };
  index: {
    state: string;
    files: number | null;
    chunks: number | null;
    elapsed_seconds: number;
    error: string | null;
    metadata_error: string | null;
    sources_changed: boolean;
    last_build: {
      file_count: number;
      entry_count: number;
      built_at: string;
      build_seconds: number;
    } | null;
  };
  endpoint: string;
  connectors: Connector[];
}
export interface QueryResult {
  result: { content: unknown[]; isError: boolean };
  text: string;
  state: "success" | "no_matches" | "tool_error";
  elapsed_ms: number;
  endpoint: string;
}

export class ApiError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

let token = "";
export async function session() {
  const result = await request<{ token: string }>("/api/session");
  token = result.token;
}

export async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Magic-Rag-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(
      result.error || "Something went wrong. Please try again.",
      result.code,
    );
  return result as T;
}
