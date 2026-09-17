import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import type { Source, RetrievalResponse } from "@secondmind/core";
import "./style.css";

let csrf = "";
async function api(
  route: string,
  body?: unknown,
  method?: string,
): Promise<any> {
  const response = await fetch(route, {
    method: method || (body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", "X-SecondMind-CSRF": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
function App() {
  const [page, setPage] = useState("Library"),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<any>({
    sources: [],
    model: { status: "not_loaded" },
    diagnostics: {},
    pending: [],
    tunnel: { state: "stopped" },
  });
  const sources: Source[] = snapshot.sources;
  const [folder, setFolder] = useState(""),
    [query, setQuery] = useState(""),
    [mode, setMode] = useState("knowledge"),
    [budget, setBudget] = useState(3000),
    [result, setResult] = useState<RetrievalResponse | null>(null),
    [searchSources, setSearchSources] = useState<string[]>([]);
  const [settings, setSettings] = useState<any>(null),
    [clients, setClients] = useState<any[]>([]),
    [preview, setPreview] = useState<any>(null),
    [auth, setAuth] = useState<any>({ pending: [], grants: [] }),
    [selected, setSelected] = useState<string[]>([]);
  const [tunnelToken, setTunnelToken] = useState(""),
    [tokenName, setTokenName] = useState(""),
    [createdToken, setCreatedToken] = useState(""),
    [diagnostics, setDiagnostics] = useState<any>(null),
    [ignoreEdit, setIgnoreEdit] = useState<Source | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const refresh = useCallback(
    async () => setSnapshot(await api("/api/v1/status")),
    [],
  );
  useEffect(() => {
    void (async () => {
      try {
        const setup = new URLSearchParams(location.hash.slice(1)).get("setup");
        if (setup) {
          history.replaceState(null, "", location.pathname);
          csrf = (await api("/api/session", { code: setup })).csrf;
        } else csrf = (await api("/api/v1/session")).csrf;
        await refresh();
        setReady(true);
      } catch (e: any) {
        setError(e.message);
      }
    })();
  }, [refresh]);
  useEffect(() => {
    if (!ready) return;
    const events = new EventSource("/api/v1/events");
    events.onmessage = (e) => setSnapshot(JSON.parse(e.data));
    return () => events.close();
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    void run(async () => {
      if (page === "Connections") {
        setClients(await api("/api/v1/integrations"));
        setSettings(await api("/api/v1/settings"));
        setAuth(await api("/api/v1/authorization"));
      }
      if (page === "Settings") setSettings(await api("/api/v1/settings"));
      if (page === "Diagnostics")
        setDiagnostics(await api("/api/v1/diagnostics"));
    });
  }, [page, ready]);
  useEffect(() => {
    if (!ready || page !== "Connections") return;
    const t = setInterval(
      () =>
        api("/api/v1/authorization")
          .then(setAuth)
          .catch(() => {}),
      3000,
    );
    return () => clearInterval(t);
  }, [page, ready]);
  const saveSettings = async () => {
    const { tunnelConfigured, ...data } = settings;
    const response = await api("/api/v1/settings", data, "PUT");
    setNotice(
      response.restartRequired
        ? "Saved. Restart Second Mind to apply port or reconciliation changes."
        : "Settings saved.",
    );
  };
  const toggle = (id: string, list: string[], setter: (v: string[]) => void) =>
    setter(list.includes(id) ? list.filter((s) => s !== id) : [...list, id]);
  const choices = (values: string[], setter: (v: string[]) => void) => (
    <div className="checks">
      {sources.map((s) => (
        <label key={s.id}>
          <input
            type="checkbox"
            checked={values.includes(s.id)}
            onChange={() => toggle(s.id, values, setter)}
          />
          {s.name}
        </label>
      ))}
    </div>
  );
  if (!ready)
    return (
      <main className="welcome">
        <div className="brandmark">M</div>
        <h1>Second Mind</h1>
        <p>Your knowledge, within reach.</p>
        {error ? (
          <div role="alert" className="alert">
            {error}
            <p>
              Run <code>secondmind</code> to open a fresh local session.
            </p>
          </div>
        ) : (
          <p>Opening your private workspace…</p>
        )}
      </main>
    );
  return (
    <div className="shell">
      <aside>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("Library");
          }}
        >
          <span className="brandmark">M</span>
          <span>
            Second Mind<small>YOUR LOCAL KNOWLEDGE</small>
          </span>
        </a>
        <nav>
          {[
            ["Library", "▦"],
            ["Playground", "⌕"],
            ["Connections", "⇄"],
            ["Settings", "⚙"],
            ["Diagnostics", "◷"],
          ].map(([name, icon]) => (
            <button
              className={page === name ? "active" : ""}
              key={name}
              onClick={() => setPage(name)}
            >
              <span aria-hidden>{icon}</span>
              {name}
              {name === "Connections" && snapshot.pending.length > 0 && (
                <b>{snapshot.pending.length}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="local-note">
          <span className="dot" /> Stored on this computer
          <p>
            Your files stay in their folders.
            <br />
            Your index stays here.
          </p>
        </div>
        <footer>
          WINDOWS BETA <span>v0.1</span>
        </footer>
      </aside>
      <main>
        <header>
          <span className="eyebrow">YOUR SPACE / {page.toUpperCase()}</span>
          <span className="status-pill">
            <span className="dot" />
            Local service running
          </span>
        </header>
        <div className="page-title">
          <div>
            <h1>
              {page === "Library"
                ? "A little more at your fingertips."
                : page === "Playground"
                  ? "Find the thread."
                  : page === "Connections"
                    ? "Bring your knowledge along."
                    : page === "Settings"
                      ? "Make it yours."
                      : "A clear view of your index."}
            </h1>
            <p>
              {page === "Library"
                ? "Turn the folders you already use into memory for your AI tools."
                : page === "Playground"
                  ? "Try a question and see the evidence your AI will receive."
                  : page === "Connections"
                    ? "Connect your AI tools to one shared, private index."
                    : page === "Settings"
                      ? "Control local search, service, and remote connection settings."
                      : "Inspect indexing issues and retrieval activity. Query text is never logged."}
            </p>
          </div>
        </div>
        {error && (
          <div role="alert" className="alert">
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div role="status" className="notice">
            {notice}
          </div>
        )}
        {page === "Library" && (
          <>
            <div className="stats">
              <div>
                <small>KNOWLEDGE FOLDERS</small>
                <strong>{sources.length.toLocaleString()}</strong>
                <span>Chosen by you</span>
              </div>
              <div>
                <small>INDEXED DOCUMENTS</small>
                <strong>
                  {(snapshot.diagnostics.documents || 0).toLocaleString()}
                </strong>
                <span>Ready to search</span>
              </div>
              <div>
                <small>LOCAL SEARCH MODEL</small>
                <strong className="word">
                  {snapshot.model.status === "ready"
                    ? "Ready"
                    : snapshot.model.status === "not_loaded"
                      ? "Not loaded"
                      : snapshot.model.status === "error"
                        ? "Needs attention"
                        : "Preparing"}
                </strong>
                <span>English · runs on your CPU</span>
              </div>
            </div>
            <section className="card add-folder">
              <div className="folder-art" aria-hidden>
                ▱
              </div>
              <div>
                <h2>
                  {sources.length
                    ? "Add a knowledge folder"
                    : "Start with one folder."}
                </h2>
                <p>
                  Notes, research, documents, or a codebase. Choose a folder and
                  Second Mind takes care of the rest.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(async () => {
                      await api("/api/v1/sources", { path: folder });
                      setFolder("");
                      await refresh();
                    });
                  }}
                >
                  <div className="inline">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const picked = await api("/api/v1/folder-picker", {});
                          if (picked.path) setFolder(picked.path);
                        })
                      }
                    >
                      Choose folder
                    </button>
                    <input
                      aria-label="Folder path"
                      placeholder="Or enter a folder path"
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                    />
                    <button disabled={busy || !folder.trim()}>
                      Add folder
                    </button>
                  </div>
                </form>
                <small>Markdown · Text · PDF · Word · HTML · Source code</small>
              </div>
            </section>
            {sources.length > 0 && (
              <div className="section-heading">
                <h2>Your library</h2>
                <span>
                  {sources.length} {sources.length === 1 ? "folder" : "folders"}
                </span>
              </div>
            )}
            {sources.map((s) => (
              <section className="card source" key={s.id}>
                <div className="source-top">
                  <div>
                    <h3>{s.name}</h3>
                    <p className="path">{s.root}</p>
                  </div>
                  <span className={"badge " + s.status}>{s.status}</span>
                </div>
                <div className="progress">
                  <div
                    style={{
                      width: `${s.discovered ? Math.min(100, (100 * (s.indexed + s.failed)) / s.discovered) : 0}%`,
                    }}
                  />
                </div>
                <div className="source-details">
                  <span>
                    {s.indexed.toLocaleString()} indexed ·{" "}
                    {s.discovered.toLocaleString()} discovered · {s.failed}{" "}
                    issues
                  </span>
                  <span>
                    {s.last_sync
                      ? "Checked " + new Date(s.last_sync).toLocaleString()
                      : "First index in progress"}
                  </span>
                </div>
                {s.error && <p className="warning">{s.error}</p>}
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api(`/api/v1/sources/${s.id}/pause`, {
                          paused: !s.paused,
                        });
                        await refresh();
                      })
                    }
                  >
                    {s.paused ? "Resume" : "Pause"}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api(`/api/v1/sources/${s.id}/sync`, {});
                        setNotice(
                          "Full reconciliation queued. Unchanged embeddings will be reused.",
                        );
                      })
                    }
                  >
                    Reindex
                  </button>
                  <button
                    onClick={() =>
                      void run(async () => {
                        await api(`/api/v1/sources/${s.id}/open`, {});
                      })
                    }
                  >
                    Open folder
                  </button>
                  <button onClick={() => setIgnoreEdit({ ...s })}>
                    Ignore rules
                  </button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        confirm(
                          `Remove ${s.name} from Second Mind? Your original files will stay in place.`,
                        )
                      )
                        void run(async () => {
                          await api(`/api/v1/sources/${s.id}`, {}, "DELETE");
                          await refresh();
                        });
                    }}
                  >
                    Remove
                  </button>
                </div>
              </section>
            ))}
            <div className="tip">
              <span>↗</span>
              <div>
                <strong>Already using a synced folder?</strong>
                <p>
                  OneDrive, Dropbox, Google Drive, or a network folder works
                  too. Each computer builds its own local index.
                </p>
              </div>
            </div>
            {snapshot.model.status !== "ready" && (
              <section className="card model">
                <h3>Prepare local search</h3>
                <p>
                  The first setup downloads a small English model. After that,
                  indexing and local search work offline.
                </p>
                {snapshot.model.file && (
                  <p>
                    {snapshot.model.file}{" "}
                    {snapshot.model.progress
                      ? Math.round(snapshot.model.progress) + "%"
                      : ""}
                  </p>
                )}
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api("/api/v1/model/setup", {});
                      await refresh();
                    })
                  }
                >
                  {busy ? "Preparing…" : "Prepare model"}
                </button>
              </section>
            )}
          </>
        )}
        {page === "Playground" && (
          <>
            <section className="card">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () =>
                    setResult(
                      await api("/api/v1/retrieve", {
                        query,
                        mode,
                        max_tokens: budget,
                        ...(searchSources.length
                          ? { source_ids: searchSources }
                          : {}),
                      }),
                    ),
                  );
                }}
              >
                <label className="field">
                  Your question
                  <textarea
                    rows={3}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="What did we decide about annual pricing?"
                    required
                    maxLength={10000}
                  />
                </label>
                <div className="form-row">
                  <label className="field">
                    Search mode
                    <select
                      value={mode}
                      onChange={(e) => {
                        setMode(e.target.value);
                        setBudget(
                          e.target.value === "code_navigation" ? 2500 : 3000,
                        );
                      }}
                    >
                      <option value="knowledge">Knowledge excerpts</option>
                      <option value="code_navigation">Code navigation</option>
                      <option value="raw">Raw chunks</option>
                    </select>
                  </label>
                  <label className="field">
                    Context budget
                    <input
                      type="number"
                      min={64}
                      max={12000}
                      value={budget}
                      onChange={(e) => setBudget(Number(e.target.value))}
                    />
                  </label>
                  <button className="primary" disabled={busy || !query.trim()}>
                    {busy ? "Searching…" : "Search knowledge"}
                  </button>
                </div>
                <details>
                  <summary>Limit to selected folders</summary>
                  {choices(searchSources, setSearchSources)}
                  <small>No selection searches all your folders.</small>
                </details>
              </form>
            </section>
            {result && (
              <>
                <div className="section-heading">
                  <h2>
                    {result.results.length
                      ? `${result.results.length} sources found`
                      : "No sufficiently relevant evidence"}
                  </h2>
                  <span>
                    {result.token_count.toLocaleString()} tokens ·{" "}
                    {result.latency_ms} ms
                  </span>
                </div>
                {result.results.map((r, i) => (
                  <section className="card result" key={i}>
                    <span className="result-number">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <h3>{r.title}</h3>
                      <p className="path">
                        {r.path}
                        {r.location.line_start
                          ? ` · lines ${r.location.line_start}–${r.location.line_end}`
                          : ""}
                        {r.location.page ? ` · page ${r.location.page}` : ""}
                      </p>
                      <p className="excerpt">{r.text}</p>
                      <small>
                        {r.location.heading || r.location.symbol} · Score{" "}
                        {r.score.toFixed(4)} · Indexed{" "}
                        {new Date(r.indexed_at).toLocaleString()}
                      </small>
                    </div>
                  </section>
                ))}
                <details className="card">
                  <summary>Exact context sent to your AI</summary>
                  <pre>{result.context_text || "No context returned."}</pre>
                  <small>
                    Reference tokenizer: {result.tokenizer}. AI providers may
                    count tokens differently.
                  </small>
                </details>
                <div className="actions">
                  <span>Was this useful?</span>
                  {[
                    ["helpful", "Helpful"],
                    ["not_helpful", "Not helpful"],
                    ["wrong_source", "Wrong source"],
                    ["missing_knowledge", "Missing knowledge"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() =>
                        void run(async () => {
                          await api(
                            `/api/v1/retrievals/${result.retrieval_id}/feedback`,
                            { rating: value },
                          );
                          setNotice("Feedback saved locally.");
                        })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        {page === "Connections" && (
          <>
            <div className="section-heading">
              <h2>On this computer</h2>
              <span>Local connections</span>
            </div>
            <section className="card" aria-label="Local HTTP connection">
              <h3>Connect with a local address</h3>
              <p>
                Choose Streamable HTTP in your AI app and paste this address. No
                sign-in or token is needed. Apps on this PC can search all
                registered knowledge folders while Second Mind is running.
              </p>
              <p className="endpoint">
                Local MCP address <code>{window.location.origin}/mcp</code>
                <button
                  onClick={() =>
                    void run(async () => {
                      await navigator.clipboard.writeText(
                        window.location.origin + "/mcp",
                      );
                      setNotice("Local MCP address copied.");
                    })
                  }
                >
                  Copy local address
                </button>
              </p>
            </section>
            <div className="client-grid">
              {clients.map((c) => (
                <section className="card client" key={c.id}>
                  <div className="client-symbol">{c.name[0]}</div>
                  <h3>{c.name}</h3>
                  <span className={"badge " + (c.configured ? "ready" : "")}>
                    {c.configured
                      ? "Configured"
                      : c.installed
                        ? "Configuration found"
                        : "Manual setup available"}
                  </span>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () =>
                        setPreview(
                          await api(`/api/v1/integrations/${c.id}/preview`, {}),
                        ),
                      )
                    }
                  >
                    Preview connection
                  </button>
                  <details>
                    <summary>Manual configuration</summary>
                    <pre>{JSON.stringify(c.snippet, null, 2)}</pre>
                    <small>{c.path}</small>
                  </details>
                </section>
              ))}
            </div>
            <section className="card">
              <h2>Connect from anywhere</h2>
              <p>
                Use your existing Cloudflare named tunnel to reach this computer
                from Claude or ChatGPT. Keep the Second Mind terminal open.
              </p>
              <div className="connection-status">
                <span className={"badge " + snapshot.tunnel.state}>
                  {snapshot.tunnel.state}
                </span>
                <span>{snapshot.tunnel.message}</span>
              </div>
              {settings && (
                <>
                  <label className="field">
                    Public HTTPS hostname
                    <input
                      placeholder="https://mind.example.com"
                      value={settings.publicOrigin}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          publicOrigin: e.target.value,
                        })
                      }
                    />
                  </label>
                  <div className="actions">
                    <button
                      disabled={busy}
                      onClick={() => void run(saveSettings)}
                    >
                      Save hostname
                    </button>
                  </div>
                  <p className="muted">
                    In Cloudflare, route this hostname to{" "}
                    <code>http://127.0.0.1:{settings.gatewayPort}</code>. Route
                    the whole hostname so authorization endpoints are reachable.
                  </p>
                </>
              )}
              <label className="field">
                Cloudflare tunnel token
                <input
                  type="password"
                  autoComplete="off"
                  value={tunnelToken}
                  onChange={(e) => setTunnelToken(e.target.value)}
                  placeholder="Paste token to save or replace"
                />
              </label>
              <div className="actions">
                <button
                  disabled={busy || !tunnelToken}
                  onClick={() =>
                    void run(async () => {
                      await api("/api/v1/tunnel/token", { token: tunnelToken });
                      setTunnelToken("");
                      setNotice(
                        "Tunnel token saved securely for this Windows user.",
                      );
                    })
                  }
                >
                  Save token
                </button>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    snapshot.tunnel.state === "connected" ||
                    snapshot.tunnel.state === "connecting"
                  }
                  onClick={() =>
                    void run(async () => {
                      await api("/api/v1/tunnel/start", {});
                      await refresh();
                    })
                  }
                >
                  Start tunnel
                </button>
                <button
                  disabled={busy || snapshot.tunnel.state === "stopped"}
                  onClick={() =>
                    void run(async () => {
                      await api("/api/v1/tunnel/stop", {});
                      await refresh();
                    })
                  }
                >
                  Stop tunnel
                </button>
              </div>
              {settings?.publicOrigin && (
                <p className="endpoint">
                  MCP address <code>{settings.publicOrigin}/mcp</code>
                  <button
                    onClick={() =>
                      void navigator.clipboard.writeText(
                        settings.publicOrigin + "/mcp",
                      )
                    }
                  >
                    Copy
                  </button>
                </p>
              )}
              <small>
                Only authorized retrieval and connection approval are available
                through this address. Folder management stays local. Retrieved
                excerpts pass through Cloudflare to your chosen AI client.
              </small>
            </section>
            <section className="card">
              <h2>Remote permissions</h2>
              <p>
                Choose which folders the next connection or access token may
                search.
              </p>
              {choices(selected, setSelected)}
              {auth.pending.length === 0 ? (
                <p className="muted">No connections waiting for approval.</p>
              ) : (
                auth.pending.map((p: any) => (
                  <div className="approval" key={p.id}>
                    <h3>{p.name}</h3>
                    <strong>{p.code}</strong>
                    <p className="path">{p.redirect}</p>
                    <p>
                      Match this code to the request you started in your AI
                      client.
                    </p>
                    <div className="actions">
                      <button
                        className="primary"
                        disabled={busy || !selected.length}
                        onClick={() =>
                          void run(async () => {
                            await api(
                              `/api/v1/authorization/${p.id}/decision`,
                              { approve: true, source_ids: selected },
                            );
                            setAuth(await api("/api/v1/authorization"));
                          })
                        }
                      >
                        Approve selected folders
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api(
                              `/api/v1/authorization/${p.id}/decision`,
                              { approve: false, source_ids: [] },
                            );
                            setAuth(await api("/api/v1/authorization"));
                          })
                        }
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                ))
              )}
              <h3>Developer access tokens</h3>
              <p className="muted">
                For clients that support a Bearer authorization header. Tokens
                expire after 30 days.
              </p>
              <div className="inline">
                <input
                  aria-label="Access token name"
                  placeholder="Name this connection"
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                />
                <button
                  disabled={busy || !tokenName || !selected.length}
                  onClick={() =>
                    void run(async () => {
                      const data = await api("/api/v1/tokens", {
                        name: tokenName,
                        source_ids: selected,
                      });
                      setCreatedToken(data.token);
                      setTokenName("");
                      setAuth(await api("/api/v1/authorization"));
                    })
                  }
                >
                  Create token
                </button>
              </div>
              {createdToken && (
                <div className="notice">
                  <p>Copy this token now. It will not be shown again.</p>
                  <code className="secret">{createdToken}</code>
                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(createdToken);
                    }}
                  >
                    Copy token
                  </button>
                  <button onClick={() => setCreatedToken("")}>Hide</button>
                </div>
              )}
              {auth.grants.map((g: any) => (
                <div className="grant" key={g.id}>
                  <div>
                    <strong>{g.name}</strong>
                    <small>
                      {g.sources.length} folders · expires{" "}
                      {new Date(g.expires * 1000).toLocaleDateString()}
                    </small>
                  </div>
                  <button
                    className="danger"
                    onClick={() =>
                      void run(async () => {
                        await api(
                          `/api/v1/authorization/${g.id}`,
                          {},
                          "DELETE",
                        );
                        setAuth(await api("/api/v1/authorization"));
                      })
                    }
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </section>
          </>
        )}
        {page === "Settings" && settings && (
          <section className="card settings">
            <h2>Search preferences</h2>
            <div className="form-row">
              {[
                ["knowledgeTokens", "Knowledge context tokens"],
                ["codeTokens", "Code context tokens"],
                ["minSimilarity", "Minimum semantic similarity"],
                ["maxResults", "Maximum results"],
              ].map(([key, label]) => (
                <label className="field" key={key}>
                  {label}
                  <input
                    type="number"
                    step={key === "minSimilarity" ? 0.01 : 1}
                    value={settings[key]}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        [key]: Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <h2>Local service</h2>
            <div className="form-row">
              {[
                ["port", "Browser port"],
                ["gatewayPort", "Tunnel gateway port"],
                ["reconcileSeconds", "Reconcile interval (seconds)"],
                ["hashSeconds", "Content verification interval (seconds)"],
              ].map(([key, label]) => (
                <label className="field" key={key}>
                  {label}
                  <input
                    type="number"
                    value={settings[key]}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        [key]: Number(e.target.value),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <label className="field">
              cloudflared executable path (optional)
              <input
                value={settings.cloudflaredPath}
                onChange={(e) =>
                  setSettings({ ...settings, cloudflaredPath: e.target.value })
                }
                placeholder="Leave empty to detect from PATH"
              />
            </label>
            <p className="muted">
              If missing, install cloudflared from Cloudflare’s official Windows
              distribution, then restart Second Mind or enter its full
              executable path.
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void run(saveSettings)}
            >
              Save settings
            </button>
            <hr />
            <h3>Privacy</h3>
            <p>
              Raw queries and document excerpts are not stored in logs.
              Retrieval timings and token counts are retained locally for seven
              days. Your original files are never changed.
            </p>
            <p>
              Removing a folder removes its searchable documents. To rebuild,
              use Reindex in your library. Closing this browser leaves indexing
              active; closing the terminal stops it.
            </p>
          </section>
        )}
        {page === "Diagnostics" && diagnostics && (
          <>
            <section className="card">
              <div className="section-heading">
                <h2>Local activity</h2>
                <button
                  onClick={() =>
                    void run(async () =>
                      setDiagnostics(await api("/api/v1/diagnostics")),
                    )
                  }
                >
                  Refresh
                </button>
              </div>
              <div className="stats compact">
                <div>
                  <small>CHUNKS</small>
                  <strong>{diagnostics.chunks.toLocaleString()}</strong>
                </div>
                <div>
                  <small>RETRIEVALS</small>
                  <strong>{diagnostics.requests.count}</strong>
                </div>
                <div>
                  <small>AVERAGE LATENCY</small>
                  <strong>
                    {Math.round(diagnostics.requests.average_latency || 0)}
                    <em>ms</em>
                  </strong>
                </div>
              </div>
              <p className="muted">
                Index version {diagnostics.index_version} · Schema version{" "}
                {diagnostics.schema_version}
              </p>
            </section>
            <section className="card">
              <h2>Files needing attention</h2>
              {diagnostics.failures.length ? (
                diagnostics.failures.map((f: any, i: number) => (
                  <div className="issue" key={i}>
                    <strong>{f.path}</strong>
                    <p>{f.message}</p>
                  </div>
                ))
              ) : (
                <p className="muted">No file errors recorded.</p>
              )}
            </section>
          </>
        )}
        <div className="bottom-note">
          Your files. Your context. Your Second Mind.
        </div>
      </main>
      {preview && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="preview-title"
            className="modal"
          >
            <h2 id="preview-title">Review connection settings</h2>
            <p>
              Second Mind will update this file and back up its current
              contents.
            </p>
            <p className="path">{preview.path}</p>
            <h3>Proposed configuration</h3>
            <pre>{preview.after}</pre>
            <details>
              <summary>Current configuration</summary>
              <pre>{preview.before || "(New file)"}</pre>
            </details>
            <div className="actions">
              <button onClick={() => setPreview(null)}>Cancel</button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api("/api/v1/integrations/apply", {
                      preview_id: preview.preview_id,
                    });
                    setPreview(null);
                    setClients(await api("/api/v1/integrations"));
                    setNotice(
                      "Connection saved. Restart the AI client to load Second Mind.",
                    );
                  })
                }
              >
                Connect
              </button>
            </div>
          </section>
        </div>
      )}
      {ignoreEdit && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="ignore-title"
            className="modal"
          >
            <h2 id="ignore-title">Ignore rules · {ignoreEdit.name}</h2>
            <p>
              Add one pattern per line, using gitignore syntax. Rules apply
              after defaults and the folder’s .secondmindignore file.
            </p>
            <textarea
              aria-label="Ignore patterns"
              rows={10}
              value={ignoreEdit.ignore_rules}
              onChange={(e) =>
                setIgnoreEdit({ ...ignoreEdit, ignore_rules: e.target.value })
              }
            />
            <div className="actions">
              <button onClick={() => setIgnoreEdit(null)}>Cancel</button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(
                      `/api/v1/sources/${ignoreEdit.id}/ignore`,
                      { rules: ignoreEdit.ignore_rules },
                      "PUT",
                    );
                    setIgnoreEdit(null);
                    await refresh();
                  })
                }
              >
                Save rules
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
