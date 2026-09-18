import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Copy,
  Database,
  FileText,
  FlaskConical,
  Folder,
  FolderOpen,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Search,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
  CircleAlert,
} from "lucide-react";
import { ApiError, request, session } from "./api";
import type { Connector, QueryResult, Snapshot } from "./api";
import "./styles.css";

const count = (value: number | null | undefined) =>
  value == null ? "—" : value.toLocaleString();
const elapsed = (seconds: number) =>
  seconds < 60
    ? `${Math.round(seconds)}s`
    : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
const folderName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";

const tabs = {
  dashboard: {
    label: "Dashboard",
    eyebrow: "A LITTLE CONTEXT. A LOT MORE POSSIBILITY.",
    title: "Your knowledge, connected.",
    description: "Bring your folders together. Make them useful to your AI tools.",
    icon: LayoutDashboard,
    headingIcon: Database,
  },
  server: {
    label: "MCP server",
    eyebrow: "YOUR LOCAL CONNECTION",
    title: "MCP server",
    description: "Manage your server, endpoint, and port settings.",
    icon: Server,
    headingIcon: Server,
  },
  connectors: {
    label: "Connect your tools",
    eyebrow: "BRING YOUR KNOWLEDGE TO YOUR TOOLS",
    title: "Connect your tools",
    description: "Connect your AI tools to your local knowledge with MCP.",
    icon: Plug,
    headingIcon: Plug,
  },
  playground: {
    label: "Playground",
    eyebrow: "TRY YOUR LOCAL KNOWLEDGE",
    title: "Ask your knowledge.",
    description: "Send a query to MCP and see exactly what your AI tools receive.",
    icon: FlaskConical,
    headingIcon: FlaskConical,
  },
};
type Tab = keyof typeof tabs;

function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "error" | "success";
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <CircleAlert size={16} />
      <div>{children}</div>
    </div>
  );
}

function CopyButton({
  text,
  label = "Copy",
  compact = false,
}: {
  text: string;
  label?: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (copied) {
      const timeout = setTimeout(() => setCopied(false), 2000);
      return () => clearTimeout(timeout);
    }
  }, [copied]);
  return (
    <button
      className={compact ? "icon-button" : "button subtle small"}
      title={error ? "Copy failed; select the text manually." : label}
      aria-label={error ? "Copy failed; select the text manually." : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setError(false);
        } catch {
          setError(true);
        }
      }}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {!compact && (error ? "Select to copy" : copied ? "Copied" : label)}
    </button>
  );
}

function StatusPill({ state }: { state: string }) {
  const available = state === "running" || state === "external";
  const busy = ["starting", "stopping", "external_starting"].includes(state);
  const label =
    {
      running: "Running",
      external: "Running externally",
      stopped: "Stopped",
      failed: "Needs attention",
      starting: "Starting",
      stopping: "Stopping",
      external_starting: "Starting externally",
    }[state] || state;
  return (
    <span
      className={`status-pill ${available ? "online" : state === "failed" ? "danger" : ""}`}
    >
      {busy ? (
        <LoaderCircle size={12} className="spin" />
      ) : (
        <span className="status-dot" />
      )}
      {label}
    </span>
  );
}

function FolderDialog({
  initial,
  onClose,
  onSave,
}: {
  initial: string | null;
  onClose: () => void;
  onSave: (path: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState(initial || "");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave(path.trim());
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="folder-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy && !picking) onClose();
      }}
    >
      <div className="dialog-heading">
        <div className="section-icon">
          <FolderOpen size={21} />
        </div>
        <button
          className="icon-button"
          aria-label="Close folder dialog"
          disabled={busy || picking}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <h2>{initial === null ? "Add a source folder" : "Edit source folder"}</h2>
      <p className="muted">
        Choose a folder on this computer. Your files stay right where they are.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="folder-path">Folder path</label>
        <input
          id="folder-path"
          autoFocus
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="C:\Users\you\Documents\Knowledge"
          disabled={busy || picking}
          required
        />
        <button
          type="button"
          className="button secondary browse-button"
          disabled={busy || picking}
          onClick={async () => {
            setPicking(true);
            setError("");
            try {
              const result = await request<{ path: string | null }>(
                "/api/folders/pick",
                {},
              );
              if (result.path) setPath(result.path);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setPicking(false);
            }
          }}
        >
          {picking ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <FolderOpen size={16} />
          )}
          {picking ? "Choose a folder in the system dialog…" : "Browse folders"}
        </button>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy || picking}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={!path.trim() || busy || picking}
          >
            {busy && <LoaderCircle size={15} className="spin" />}
            {initial === null ? "Add folder" : "Save folder"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function ConnectorCard({ connector }: { connector: Connector }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`connector ${expanded ? "expanded" : ""}`}>
      <div className="connector-top">
        <div className={`connector-logo ${connector.id}`} aria-hidden="true">
          {connector.id === "claude-code" ? (
            <Sparkles size={21} />
          ) : (
            <Terminal size={21} />
          )}
        </div>
        <div className="connector-name">
          <strong>{connector.name}</strong>
          <span>{connector.label}</span>
        </div>
        <button
          className="button subtle small"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide commands" : "Show commands"}
          <ChevronDown size={15} className={expanded ? "flipped" : ""} />
        </button>
      </div>
      {expanded && (
        <div className="connector-details">
          <p>{connector.instructions}</p>
          <pre className="command-block">{connector.commands}</pre>
          <CopyButton text={connector.commands} label="Copy commands" />
        </div>
      )}
    </div>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [data, setData] = useState<Snapshot | null>(null);
  const [disconnected, setDisconnected] = useState("");
  const [actionError, setActionError] = useState("");
  const [action, setAction] = useState("");
  const [feedback, setFeedback] = useState("");
  const [folderDialog, setFolderDialog] = useState<{
    index: number | null;
  } | null>(null);
  const [port, setPort] = useState("32187");
  const [uiPort, setUiPort] = useState("32188");
  const [query, setQuery] = useState("");
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryError, setQueryError] = useState("");
  const [queryPending, setQueryPending] = useState(false);
  const queryAbort = useRef<AbortController | null>(null);
  const revision = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      const requestedRevision = revision.current;
      try {
        const result = await request<Snapshot>(
          "/api/status",
          undefined,
          controller.signal,
        );
        if (!cancelled && requestedRevision === revision.current) {
          setData(result);
          setDisconnected("");
        }
      } catch {
        if (!cancelled)
          setDisconnected(
            "Dashboard connection lost. Keep the launcher open, then refresh this page to reconnect.",
          );
      }
      if (!cancelled) timer = setTimeout(poll, 1000);
    }
    session()
      .then(() => {
        if (!cancelled) void poll();
      })
      .catch(() => {
        if (!cancelled)
          setDisconnected(
            "Could not connect to the dashboard. Refresh this page to retry.",
          );
      });
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      queryAbort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (data) setPort(String(data.settings.mcp_port));
  }, [data?.settings.mcp_port]);
  useEffect(() => {
    if (data) setUiPort(String(data.settings.ui_port));
  }, [data?.settings.ui_port]);
  useEffect(() => {
    if (feedback) {
      const timer = setTimeout(() => setFeedback(""), 4000);
      return () => clearTimeout(timer);
    }
  }, [feedback]);

  async function perform(
    name: string,
    path: string,
    body: unknown = {},
    success = "",
  ) {
    setAction(name);
    setActionError("");
    revision.current += 1;
    try {
      const result = await request<Snapshot>(path, body);
      revision.current += 1;
      setData(result);
      if (success) setFeedback(success);
      return result;
    } catch (error) {
      setActionError(errorMessage(error));
      throw error;
    } finally {
      setAction("");
    }
  }
  function act(name: string, path: string, body: unknown = {}, success = "") {
    void perform(name, path, body, success).catch(() => {});
  }

  async function sendQuery(event: FormEvent) {
    event.preventDefault();
    if (
      !query.trim() ||
      query.length > 10000 ||
      queryPending ||
      !data?.mcp.available ||
      disconnected
    )
      return;
    setQueryPending(true);
    setQueryError("");
    setQueryResult(null);
    const controller = new AbortController();
    queryAbort.current = controller;
    const timeout = setTimeout(() => controller.abort(), 65000);
    try {
      setQueryResult(
        await request<QueryResult>(
          "/api/playground/query",
          { query },
          controller.signal,
        ),
      );
    } catch (error) {
      setQueryError(
        error instanceof ApiError
          ? error.message
          : controller.signal.aborted
            ? "The query timed out. You can try again."
            : "The connection was interrupted. Check the MCP server and try again.",
      );
    } finally {
      clearTimeout(timeout);
      setQueryPending(false);
      queryAbort.current = null;
    }
  }

  const indexing = data?.index.state === "running";
  const running = data?.mcp.available;
  const external = data?.mcp.state.startsWith("external");
  const transition = ["starting", "stopping", "external_starting"].includes(
    data?.mcp.state || "",
  );
  const blocked = !!action || !!disconnected || !!data?.settings_error;
  const lastBuild = data?.index.last_build;
  const validPort = (value: string) =>
    /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
  const currentTab = tabs[tab];
  const HeadingIcon = currentTab.headingIcon;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Magic RAG home">
          <img src="/favicon.svg" alt="" />
          <span>
            magic<span className="brand-light">rag</span>
            <small>LOCAL WORKSPACE</small>
          </span>
        </a>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {(Object.keys(tabs) as Tab[]).map((id) => {
            const Icon = tabs[id].icon;
            return (
              <button
                key={id}
                className={`nav-item ${tab === id ? "selected" : ""}`}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => setTab(id)}
              >
                <Icon size={19} />
                <span>{tabs[id].label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-icon">
            <ShieldCheck size={22} />
          </div>
          <strong>Local by design</strong>
          <p>
            Your files and index stay
            <br />
            on this computer.
          </p>
          <div className="local-tag">
            <span className={`status-dot ${disconnected ? "offline" : ""}`} />
            {disconnected ? "Disconnected" : "Local workspace"}
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace<span>/</span>
            <strong>{currentTab.label}</strong>
          </div>
          <span className="local-badge">
            <LockKeyhole size={13} />
            Only on this computer
          </span>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">{currentTab.eyebrow}</div>
              <h1>{currentTab.title}</h1>
              <p>{currentTab.description}</p>
            </div>
            <div className="heading-mark" aria-hidden="true">
              <HeadingIcon size={32} strokeWidth={1.3} />
            </div>
          </div>
          {disconnected && <Notice tone="error">{disconnected}</Notice>}
          {data?.settings_error && (
            <Notice tone="error">
              Settings could not be read: {data.settings_error} Fix
              magic_rag_settings.json, then refresh the dashboard.
            </Notice>
          )}
          {actionError && <Notice tone="error">{actionError}</Notice>}
          {feedback && (
            <div className="toast" role="status">
              <CheckCircle2 size={17} />
              {feedback}
            </div>
          )}
          {!data ? (
            <div className="loading-panel">
              <LoaderCircle className="spin" size={24} />
              <p>Loading your workspace…</p>
            </div>
          ) : tab === "dashboard" ? (
            <div className="dashboard-grid">
              <section className="card sources-card">
                <div className="card-heading">
                  <div className="title-group">
                    <div className="section-icon">
                      <FolderOpen size={20} />
                    </div>
                    <div>
                      <h2>
                        Source folders{" "}
                        <span className="count-badge">
                          {data.settings.folders.length}
                        </span>
                      </h2>
                      <p>The places your knowledge lives.</p>
                    </div>
                  </div>
                  <button
                    className="button secondary small"
                    disabled={blocked || indexing}
                    onClick={() => setFolderDialog({ index: null })}
                  >
                    <Plus size={15} />
                    Add folder
                  </button>
                </div>
                <div className="folder-list">
                  {data.folders.length ? (
                    data.folders.map((folder, index) => (
                      <div
                        className="folder-row"
                        key={`${folder.path}-${index}`}
                      >
                        <div className="folder-icon">
                          <Folder size={23} strokeWidth={1.5} />
                        </div>
                        <div className="folder-description">
                          <strong>{folderName(folder.path)}</strong>
                          <span title={folder.resolved}>{folder.path}</span>
                          {!folder.available && (
                            <small className="unavailable">
                              Folder unavailable
                            </small>
                          )}
                        </div>
                        <button
                          className="icon-button"
                          aria-label={`Edit ${folder.path}`}
                          title="Edit folder"
                          disabled={blocked || indexing}
                          onClick={() => setFolderDialog({ index })}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-button destructive"
                          aria-label={`Remove ${folder.path}`}
                          title="Remove source (keeps files)"
                          disabled={blocked || indexing}
                          onClick={() =>
                            act(
                              "folders",
                              "/api/settings",
                              {
                                folders: data.settings.folders.filter(
                                  (_, position) => position !== index,
                                ),
                              },
                              "Source removed. Rebuild the index to apply.",
                            )
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className="empty-folders">
                      <FolderOpen size={30} strokeWidth={1.3} />
                      <strong>A home for your knowledge</strong>
                      <p>Add a folder of notes or documents to get started.</p>
                    </div>
                  )}
                </div>
                <div className="card-footnote">
                  <ShieldCheck size={14} />
                  <span>
                    Reads .md, .txt, and .json files, including subfolders.
                    <br />
                    Removing a source keeps your original files.
                  </span>
                </div>
              </section>

              <section className="card index-card">
                <div className="card-heading">
                  <div className="title-group">
                    <div className="section-icon">
                      <Database size={20} />
                    </div>
                    <div>
                      <h2>Knowledge index</h2>
                      <p>Turn your files into searchable context.</p>
                    </div>
                  </div>
                  <span className={`mini-label ${indexing ? "green" : ""}`}>
                    {indexing
                      ? "INDEXING"
                      : lastBuild
                        ? "LOCAL INDEX"
                        : "NOT BUILT YET"}
                  </span>
                </div>
                <div className="index-content">
                  <div className="index-stats">
                    <div>
                      <span>
                        <FileText size={14} />
                        {indexing ? "Files processed" : "Indexed files"}
                      </span>
                      <strong>
                        {count(
                          indexing ? data.index.files : lastBuild?.file_count,
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>
                        <Database size={14} />
                        Text chunks
                      </span>
                      <strong>
                        {count(
                          indexing ? data.index.chunks : lastBuild?.entry_count,
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>
                        <Clock3 size={14} />
                        {indexing ? "Elapsed" : "Build time"}
                      </span>
                      <strong>
                        {indexing
                          ? elapsed(data.index.elapsed_seconds)
                          : lastBuild
                            ? elapsed(lastBuild.build_seconds)
                            : "—"}
                      </strong>
                    </div>
                  </div>
                  {indexing && (
                    <div className="index-progress" role="status">
                      <LoaderCircle size={16} className="spin" />
                      <span>
                        Building your index… Counts update as the indexer
                        reports progress.
                      </span>
                    </div>
                  )}
                  {data.index.sources_changed && !indexing && (
                    <Notice>
                      Your source folders changed. Rebuild to update searchable
                      content.
                    </Notice>
                  )}
                  {data.index.state === "failed" && (
                    <Notice tone="error">{data.index.error}</Notice>
                  )}
                  {data.index.metadata_error && (
                    <Notice tone="error">
                      The index needs attention. Rebuild it to recover.{" "}
                      {data.index.metadata_error}
                    </Notice>
                  )}
                  {!data.settings.folders.length && (
                    <p className="field-note">
                      No sources selected. Building will create an empty index.
                    </p>
                  )}
                  <div className="index-bottom">
                    <p>
                      {lastBuild ? (
                        <>
                          Last built{" "}
                          <strong>
                            {new Date(lastBuild.built_at).toLocaleString(
                              undefined,
                              {
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                              },
                            )}
                          </strong>
                        </>
                      ) : (
                        "Your first index is one click away."
                      )}
                    </p>
                    <button
                      className="button primary"
                      disabled={
                        blocked ||
                        indexing ||
                        data.folders.some((folder) => !folder.available)
                      }
                      onClick={() => act("index", "/api/index/build")}
                    >
                      {indexing ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : (
                        <RefreshCw size={15} />
                      )}
                      {indexing
                        ? "Indexing…"
                        : lastBuild
                          ? "Rebuild index"
                          : "Build index"}
                    </button>
                  </div>
                </div>
                <div className="card-footnote">
                  <LockKeyhole size={14} />
                  <span>
                    Built locally. Existing searches stay available during
                    rebuilds.
                  </span>
                </div>
              </section>

            </div>
          ) : tab === "server" ? (
            <div className="settings-layout">
              <section className="card server-card">
                <div className="card-heading">
                  <div className="title-group">
                    <div className="section-icon">
                      <Server size={20} />
                    </div>
                    <div>
                      <h2>MCP server</h2>
                      <p>A bridge to your AI tools.</p>
                    </div>
                  </div>
                  <StatusPill state={data.mcp.state} />
                </div>
                <div className="server-content">
                  <label htmlFor="mcp-port">MCP port</label>
                  <div className="port-row">
                    <input
                      id="mcp-port"
                      type="number"
                      min="1"
                      max="65535"
                      value={port}
                      onChange={(event) => setPort(event.target.value)}
                      disabled={blocked}
                    />
                    <button
                      className="button secondary"
                      disabled={
                        blocked ||
                        port === String(data.settings.mcp_port) ||
                        !validPort(port) ||
                        Number(port) === data.ui_port ||
                        Number(port) === data.settings.ui_port
                      }
                      onClick={() =>
                        act(
                          "port",
                          "/api/settings",
                          { mcp_port: Number(port) },
                          "MCP port saved. It applies on the next start.",
                        )
                      }
                    >
                      Save port
                    </button>
                  </div>
                  {data.mcp.pending_port && (
                    <div className="field-note pending">
                      <Clock3 size={13} />
                      Port {data.settings.mcp_port} applies on next start.
                      Active: {data.mcp.active_port}.
                    </div>
                  )}
                  <label className="endpoint-label">
                    {running ? "Active endpoint" : "MCP endpoint"}
                  </label>
                  <div className="endpoint">
                    <code>{data.endpoint}</code>
                    <CopyButton
                      text={data.endpoint}
                      label="Copy MCP endpoint"
                      compact
                    />
                  </div>
                  {external && (
                    <Notice>
                      Started outside this dashboard. Stop it in its original
                      console before using dashboard controls.
                    </Notice>
                  )}
                  {data.mcp.error && (
                    <Notice tone="error">{data.mcp.error}</Notice>
                  )}
                  <div className="server-actions">
                    <span className="field-note">
                      {running
                        ? "Ready for your AI tools"
                        : transition
                          ? "Just a moment…"
                          : "Start when you’re ready"}
                    </span>
                    <button
                      className={`button ${running && !external ? "secondary" : "primary"}`}
                      disabled={
                        blocked ||
                        transition ||
                        external ||
                        (data.mcp.owned && !running)
                      }
                      onClick={() =>
                        act("mcp", running ? "/api/mcp/stop" : "/api/mcp/start")
                      }
                    >
                      {transition || action === "mcp" ? (
                        <LoaderCircle size={15} className="spin" />
                      ) : running ? (
                        <Square size={13} />
                      ) : (
                        <Power size={16} />
                      )}
                      {transition
                        ? data.mcp.state === "stopping"
                          ? "Stopping…"
                          : "Starting…"
                        : running
                          ? "Stop server"
                          : "Start server"}
                    </button>
                  </div>
                  <details className="advanced">
                    <summary>
                      Dashboard settings
                      <ChevronDown size={13} />
                    </summary>
                    <label htmlFor="ui-port">Dashboard port</label>
                    <div className="port-row">
                      <input
                        id="ui-port"
                        type="number"
                        min="1"
                        max="65535"
                        value={uiPort}
                        onChange={(event) => setUiPort(event.target.value)}
                        disabled={blocked}
                      />
                      <button
                        className="button secondary small"
                        disabled={
                          blocked ||
                          !validPort(uiPort) ||
                          Number(uiPort) === data.settings.mcp_port ||
                          uiPort === String(data.settings.ui_port)
                        }
                        onClick={() =>
                          act(
                            "ui-port",
                            "/api/settings",
                            { ui_port: Number(uiPort) },
                            "Dashboard port saved. Relaunch the dashboard to apply.",
                          )
                        }
                      >
                        Save
                      </button>
                    </div>
                    <p className="field-note">
                      Current: {data.ui_port}. Changes apply when you relaunch
                      the dashboard.
                    </p>
                  </details>
                </div>
              </section>
            </div>
          ) : tab === "connectors" ? (
            <div className="settings-layout">
              <section className="card connectors-card">
                <div className="card-heading">
                  <div className="title-group">
                    <div className="section-icon">
                      <Plug size={20} />
                    </div>
                    <div>
                      <h2>Connect your tools</h2>
                      <p>Give your AI a little more context.</p>
                    </div>
                  </div>
                  <MoreHorizontal size={18} className="muted" />
                </div>
                <div className="connectors-list">
                  {data.connectors.map((connector) => (
                    <ConnectorCard key={connector.id} connector={connector} />
                  ))}
                </div>
                <div className="generic-connector">
                  <span>Other MCP client?</span>
                  <CopyButton text={data.endpoint} label="Copy endpoint" />
                </div>
                <div className="card-footnote">
                  <Terminal size={14} />
                  <span>
                    Copy and run commands yourself. After changing the MCP port,
                    update your clients with the new commands.
                  </span>
                </div>
              </section>
            </div>
          ) : (
            <div className="playground-layout">
              <section className="card query-card">
                <div className="card-heading">
                  <div className="title-group">
                    <div className="section-icon">
                      <Search size={20} />
                    </div>
                    <div>
                      <h2>Query your index</h2>
                      <p>Find relevant excerpts from your folders.</p>
                    </div>
                  </div>
                  <StatusPill state={data.mcp.state} />
                </div>
                <form className="query-form" onSubmit={sendQuery}>
                  <label htmlFor="query">What would you like to find?</label>
                  <textarea
                    id="query"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="e.g. What did we decide about the project architecture?"
                    rows={6}
                    disabled={queryPending}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        (event.ctrlKey || event.metaKey)
                      ) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <div className="query-meta">
                    <span className={query.length > 10000 ? "unavailable" : ""}>
                      {count(query.length)} / 10,000 characters
                    </span>
                    <span>Ctrl + Enter to send</span>
                  </div>
                  {!running && (
                    <Notice>
                      Start MCP from the{" "}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setTab("server")}
                      >
                        MCP server tab
                        <ArrowRight size={13} />
                      </button>{" "}
                      before sending a query.
                    </Notice>
                  )}
                  {!lastBuild && (
                    <Notice>
                      No index yet. Your first query may build it automatically
                      and take longer. You can build it from the Dashboard
                      first.
                    </Notice>
                  )}
                  {data.mcp.pending_port && (
                    <Notice>
                      Queries use active port {data.mcp.active_port}. Saved port{" "}
                      {data.settings.mcp_port} applies after Stop → Start.
                    </Notice>
                  )}
                  <div className="query-actions">
                    <span>
                      <ShieldCheck size={14} />
                      Searches stay on this computer
                    </span>
                    <button
                      className="button primary"
                      disabled={
                        !running ||
                        queryPending ||
                        !query.trim() ||
                        query.length > 10000 ||
                        !!disconnected
                      }
                    >
                      {queryPending ? (
                        <LoaderCircle size={16} className="spin" />
                      ) : (
                        <Send size={16} />
                      )}
                      {queryPending ? "Searching…" : "Send query"}
                    </button>
                  </div>
                </form>
              </section>
              <section className="card response-card">
                <div className="card-heading">
                  <div className="title-group">
                    <div className="section-icon">
                      <Terminal size={20} />
                    </div>
                    <div>
                      <h2>MCP response</h2>
                      <p>Original excerpts and source citations.</p>
                    </div>
                  </div>
                  {queryResult && (
                    <CopyButton text={queryResult.text} label="Copy response" />
                  )}
                </div>
                {queryError ? (
                  <div className="response-content">
                    <Notice tone="error">{queryError}</Notice>
                  </div>
                ) : queryPending ? (
                  <div className="response-empty" role="status">
                    <LoaderCircle size={30} className="spin" />
                    <strong>Searching your knowledge</strong>
                    <p>Waiting for the MCP server to respond…</p>
                  </div>
                ) : queryResult ? (
                  <div className="response-content">
                    <div className="response-meta">
                      <span
                        className={
                          queryResult.state === "tool_error"
                            ? "unavailable"
                            : "result-label"
                        }
                      >
                        {queryResult.state === "tool_error" ? (
                          <CircleAlert size={14} />
                        ) : (
                          <CheckCircle2 size={14} />
                        )}
                        {queryResult.state === "no_matches"
                          ? "No matches found"
                          : queryResult.state === "tool_error"
                            ? "MCP tool error"
                            : "Response received"}
                      </span>
                      <span>{queryResult.elapsed_ms.toLocaleString()} ms</span>
                    </div>
                    <pre className="response-text">
                      {queryResult.text ||
                        JSON.stringify(queryResult.result.content, null, 2)}
                    </pre>
                    <div className="response-endpoint">
                      <Server size={13} />
                      {queryResult.endpoint}
                    </div>
                  </div>
                ) : (
                  <div className="response-empty">
                    <div className="empty-symbol">
                      <Sparkles size={27} strokeWidth={1.4} />
                    </div>
                    <strong>A little knowledge goes a long way.</strong>
                    <p>Send a query above to see what’s in your index.</p>
                  </div>
                )}
              </section>
              <div className="playground-note">
                <FileText size={15} />
                <span>
                  Returns up to 4 excerpts using the server’s default relevance
                  threshold. This is retrieved context, not an AI-generated
                  answer.
                </span>
              </div>
            </div>
          )}
          <footer className="page-footer">
            <span>
              MAGIC RAG <span className="footer-dot">·</span> YOUR KNOWLEDGE,
              CLOSE AT HAND.
            </span>
            <span>
              <ShieldCheck size={13} />
              Local. Private. Yours.
            </span>
          </footer>
        </main>
      </div>
      {folderDialog && data && (
        <FolderDialog
          initial={
            folderDialog.index === null
              ? null
              : data.settings.folders[folderDialog.index]
          }
          onClose={() => setFolderDialog(null)}
          onSave={async (path) => {
            const folders = [...data.settings.folders];
            if (folderDialog.index === null) folders.push(path);
            else folders[folderDialog.index] = path;
            await perform(
              "folders",
              "/api/settings",
              { folders },
              "Source folders saved. Rebuild the index to apply.",
            );
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
