# Security boundaries

## Local application

The management server binds only to `127.0.0.1`, validates its exact Host header and same-origin browser requests, and uses an installation secret protected by Windows DPAPI. CLI credentials are not accepted on the public gateway. Browser launch URLs carry a short-lived, single-use bootstrap in the fragment; the browser removes it and exchanges it for an HttpOnly SameSite session. State-changing browser operations also require a per-session CSRF header.

The local Windows account is the ownership boundary. This is not a defense against malware already operating as that account or a machine administrator. Local database contents are not independently encrypted; use Windows disk encryption when that is required.

Only registered roots are traversed. Symlinks/junctions below a root are skipped, source boundaries are checked before reads, and unavailable roots retain prior indexed data. Ignore rules are configurable; they are not a substitute for reviewing which folders are registered. Retrieved text is escaped and framed as untrusted evidence; no document instructions are executed.

## Remote gateway

The separate loopback port exposes retrieval and OAuth only. Tunnel traffic cannot reach the management UI, source registration, Explorer launching, diagnostics, or client-configuration routes. The HTTPS origin is configured locally and never derived from untrusted forwarded headers.

Remote clients use OAuth authorization code + PKCE S256 or explicitly created bearer tokens. OAuth discovery and dynamic client registration are implemented through the official MCP SDK. No remote owner password exists. Each connection requires approval of a matching request code and selected source IDs in the authenticated local UI. Tokens are bound to the configured MCP resource, expire, and can be revoked. Refresh tokens rotate; replay revokes the associated grant. Public-origin changes invalidate all prior grants and client registrations.

Only hashed access/refresh tokens are persisted. Confidential OAuth client secrets and Cloudflare credentials are protected with user-bound DPAPI. Cloudflare tokens are supplied to the child process through its environment, never command-line arguments or application logs. A process with access to the same user's process environment remains inside the trust boundary.

Every remote MCP call checks its token again after retrieval. Source restrictions are enforced before vector and lexical ranking. Bearer tokens cannot invoke local administration. HTTP request sizes, authorization requests, client registration, and total gateway traffic are bounded. Redirect URIs must exactly match registered HTTPS addresses. This beta uses dynamic registration rather than fetching arbitrary client metadata URLs.

Cloudflare terminates public TLS. Authorized query/excerpt traffic passes through Cloudflare and the selected AI client; the complete corpus and index remain on the PC. This is not end-to-end encryption past the tunnel provider. Remote access requires the PC, foreground service and tunnel to remain running.

## Retention and reporting

Retrieval logs retain counts, durations and integration labels for seven days, without query text or excerpts. The derived index necessarily contains document text. Deleting a source removes its searchable content. SQLite pages, model caches and historical legacy databases are not secure-erased. Diagnostics show relative file paths and sanitized errors.

Automated security checks cover CSRF, hostile Host/Origin, token audience, PKCE, redirects, refresh replay, revoked tokens, root boundaries, junctions, cache authorization, atomic deletion, and public/local route separation. Live third-party connector interoperability is a separate acceptance check requiring configured accounts and a tunnel.
