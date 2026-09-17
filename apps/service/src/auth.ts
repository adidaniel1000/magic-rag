import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
  InvalidClientMetadataError,
  InvalidTargetError,
  InvalidScopeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { AppError, hash, type Principal } from "@secondmind/core";
import type { Store } from "@secondmind/storage";
import type { PlatformAdapter } from "@secondmind/platform";

const secret = () => randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
export const equalSecret = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
type Grant = {
  id: string;
  name: string;
  clientId: string;
  sources: string[];
  expires: number;
  revoked: boolean;
  created: number;
  kind: "oauth" | "token";
};
type Token = {
  grantId: string;
  clientId: string;
  expires: number;
  kind: "access" | "refresh";
  used?: boolean;
};
type AuthState = {
  version: 1;
  clients: Record<
    string,
    OAuthClientInformationFull & { protected_secret?: string }
  >;
  grants: Record<string, Grant>;
  tokens: Record<string, Token>;
};
type Pending = {
  id: string;
  display: string;
  browserHash: string;
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expires: number;
  decision?: "approved" | "denied";
  sources?: string[];
};
type Code = {
  clientId: string;
  challenge: string;
  redirect: string;
  resource: string;
  sources: string[];
  expires: number;
  name: string;
};
export class Authorization implements OAuthServerProvider {
  private state: AuthState;
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Code>();
  constructor(
    private store: Store,
    private platform: PlatformAdapter,
    private origin: () => string,
  ) {
    this.state = JSON.parse(
      store.getState("authorization") ||
        '{"version":1,"clients":{},"grants":{},"tokens":{}}',
    );
  }
  private save() {
    this.store.setState("authorization", JSON.stringify(this.state));
  }
  get resource() {
    return `${this.origin()}/mcp`;
  }
  private checkResource(resource?: URL) {
    if (!resource || resource.href !== this.resource)
      throw new InvalidTargetError("Resource must match this MCP endpoint.");
  }
  private checkScopes(scopes?: string[]) {
    if (scopes?.some((s) => s !== "knowledge:read"))
      throw new InvalidScopeError("Only knowledge:read is supported.");
  }
  clientsStore = {
    getClient: async (id: string) => {
      const value = this.state.clients[id];
      if (!value) return undefined;
      const { protected_secret, ...client } = value;
      return {
        ...client,
        ...(protected_secret
          ? { client_secret: await this.platform.unprotect(protected_secret) }
          : {}),
      };
    },
    registerClient: async (
      input: Omit<
        OAuthClientInformationFull,
        "client_id" | "client_id_issued_at"
      >,
    ): Promise<OAuthClientInformationFull> => {
      if (Object.keys(this.state.clients).length >= 1000)
        throw new InvalidClientMetadataError("Registration capacity reached.");
      if (input.redirect_uris.length > 10)
        throw new InvalidClientMetadataError("Too many redirect URIs.");
      for (const uri of input.redirect_uris) {
        const u = new URL(uri);
        if (u.protocol !== "https:" || u.username || u.password || u.hash)
          throw new InvalidClientMetadataError(
            "Remote clients require HTTPS redirects without credentials or fragments.",
          );
      }
      if (input.scope && input.scope !== "knowledge:read")
        throw new InvalidClientMetadataError("Unsupported scope.");
      const client = {
        ...input,
        client_id: randomUUID(),
        client_id_issued_at: now(),
        client_secret_expires_at: 0,
      };
      const { client_secret, ...safe } = client;
      this.state.clients[client.client_id] = {
        ...safe,
        ...(client_secret
          ? { protected_secret: await this.platform.protect(client_secret) }
          : {}),
      };
      this.save();
      return client;
    },
  };
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ) {
    this.checkResource(params.resource);
    this.checkScopes(params.scopes);
    if (!client.redirect_uris.includes(params.redirectUri))
      throw new InvalidGrantError("Unregistered redirect.");
    for (const [id, p] of this.pending)
      if (p.expires < now()) this.pending.delete(id);
    if (this.pending.size >= 100)
      throw new InvalidGrantError("Too many pending authorizations.");
    const id = randomUUID(),
      browser = secret(),
      display = randomBytes(4).toString("hex").toUpperCase(),
      nonce = secret();
    this.pending.set(id, {
      id,
      display,
      browserHash: hash(browser),
      client,
      params,
      expires: now() + 600,
    });
    res.cookie("sm_pending", browser, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/authorize/result",
      maxAge: 600000,
    });
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Approve Second Mind connection</title><style>body{font:18px system-ui;max-width:560px;margin:12vh auto;padding:24px;background:#f4f5f0;color:#18302b}strong{font-size:36px;letter-spacing:6px}p{line-height:1.6}</style><h1>Approve on your Windows PC</h1><p>Open Second Mind locally, select Connections, and approve the request with this matching code.</p><strong>${display}</strong><p id="status">Waiting for your approval…</p><script nonce="${nonce}">async function poll(){try{const r=await fetch('/authorize/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'${id}'})});const d=await r.json();if(d.redirect){location.replace(d.redirect);return}if(!r.ok){document.getElementById('status').textContent='Request expired or denied. Start again in your AI client.';return}setTimeout(poll,1500)}catch{setTimeout(poll,3000)}}poll()</script>`,
      );
  }
  pendingRequests() {
    return [...this.pending.values()]
      .filter((p) => p.expires >= now() && !p.decision)
      .map((p) => ({
        id: p.id,
        code: p.display,
        name: p.client.client_name || "Unnamed client",
        redirect: p.params.redirectUri,
        expires: p.expires,
      }));
  }
  approve(id: string, sourceIds: string[], approve: boolean) {
    const p = this.pending.get(id);
    if (!p || p.expires < now() || p.decision)
      throw new AppError("authorization", "Authorization request expired.");
    const available = new Set(this.store.sources().map((s) => s.id));
    if (
      approve &&
      (!sourceIds.length || sourceIds.some((s) => !available.has(s)))
    )
      throw new AppError("sources", "Select valid knowledge folders.");
    p.decision = approve ? "approved" : "denied";
    p.sources = [...new Set(sourceIds)];
  }
  result(id: string, browser: string) {
    const p = this.pending.get(id);
    if (!p || p.expires < now() || !equalSecret(p.browserHash, hash(browser)))
      throw new AppError(
        "authorization",
        "Authorization request unavailable.",
        403,
      );
    if (!p.decision) return { pending: true };
    const redirect = new URL(p.params.redirectUri);
    if (p.params.state) redirect.searchParams.set("state", p.params.state);
    if (p.decision === "denied")
      redirect.searchParams.set("error", "access_denied");
    else {
      const code = secret();
      this.codes.set(hash(code), {
        clientId: p.client.client_id,
        challenge: p.params.codeChallenge,
        redirect: p.params.redirectUri,
        resource: this.resource,
        sources: p.sources!,
        expires: now() + 120,
        name: p.client.client_name || "Remote client",
      });
      redirect.searchParams.set("code", code);
    }
    this.pending.delete(id);
    return { redirect: redirect.href };
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ) {
    const c = this.codes.get(hash(code));
    if (!c || c.clientId !== client.client_id || c.expires < now())
      throw new InvalidGrantError("Invalid or expired code.");
    return c.challenge;
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirect?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.checkResource(resource);
    const key = hash(code),
      c = this.codes.get(key);
    if (
      !c ||
      c.expires < now() ||
      c.clientId !== client.client_id ||
      redirect !== c.redirect ||
      c.resource !== resource!.href
    )
      throw new InvalidGrantError("Invalid authorization code.");
    this.codes.delete(key);
    const grant: Grant = {
      id: randomUUID(),
      name: c.name,
      clientId: client.client_id,
      sources: c.sources,
      expires: now() + 30 * 86400,
      revoked: false,
      created: now(),
      kind: "oauth",
    };
    this.state.grants[grant.id] = grant;
    return this.issue(grant);
  }
  private issue(grant: Grant): OAuthTokens {
    const access = secret(),
      refresh = secret();
    this.state.tokens[hash(access)] = {
      grantId: grant.id,
      clientId: grant.clientId,
      expires: now() + 900,
      kind: "access",
    };
    this.state.tokens[hash(refresh)] = {
      grantId: grant.id,
      clientId: grant.clientId,
      expires: grant.expires,
      kind: "refresh",
    };
    for (const [key, t] of Object.entries(this.state.tokens))
      if (t.expires < now()) delete this.state.tokens[key];
    this.save();
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 900,
      scope: "knowledge:read",
    };
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refresh: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.checkResource(resource);
    this.checkScopes(scopes);
    const t = this.state.tokens[hash(refresh)];
    if (!t || t.kind !== "refresh" || t.clientId !== client.client_id)
      throw new InvalidGrantError("Invalid refresh token.");
    const grant = this.state.grants[t.grantId];
    if (t.used) {
      grant.revoked = true;
      this.save();
      throw new InvalidGrantError(
        "Refresh token reuse detected. Reconnect this client.",
      );
    }
    if (!grant || grant.revoked || grant.expires < now() || t.expires < now())
      throw new InvalidGrantError("Refresh token expired or revoked.");
    t.used = true;
    return this.issue(grant);
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = this.state.tokens[hash(token)],
      g = t && this.state.grants[t.grantId];
    if (
      !this.origin() ||
      !t ||
      t.kind !== "access" ||
      t.expires < now() ||
      !g ||
      g.revoked ||
      g.expires < now()
    )
      throw new InvalidTokenError("Invalid or expired token.");
    return {
      token,
      clientId: g.clientId,
      scopes: ["knowledge:read"],
      expiresAt: t.expires,
      resource: new URL(this.resource),
      extra: { grantId: g.id, sourceIds: g.sources },
    };
  }
  async principal(token: string): Promise<Principal> {
    const info = await this.verifyAccessToken(token);
    return {
      id: String(info.extra!.grantId),
      sourceIds: info.extra!.sourceIds as string[],
      integration: "remote-mcp",
    };
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ) {
    const t = this.state.tokens[hash(request.token)];
    if (t && t.clientId === client.client_id) this.revoke(t.grantId);
  }
  revoke(id: string) {
    if (this.state.grants[id]) {
      this.state.grants[id].revoked = true;
      this.save();
    }
  }
  grants() {
    return Object.values(this.state.grants)
      .filter((g) => !g.revoked && g.expires >= now())
      .map((g) => ({ ...g, clientId: undefined }));
  }
  mint(name: string, sources: string[], days = 30) {
    if (!this.origin())
      throw new AppError("origin", "Configure the HTTPS hostname first.");
    if (!sources.length || sources.some((s) => !this.store.source(s)))
      throw new AppError("sources", "Select valid knowledge folders.");
    const token = secret(),
      grant: Grant = {
        id: randomUUID(),
        name,
        clientId: "personal-token",
        sources: [...new Set(sources)],
        expires: now() + days * 86400,
        revoked: false,
        created: now(),
        kind: "token",
      };
    this.state.grants[grant.id] = grant;
    this.state.tokens[hash(token)] = {
      grantId: grant.id,
      clientId: grant.clientId,
      expires: grant.expires,
      kind: "access",
    };
    this.save();
    return { token, id: grant.id, expires: grant.expires };
  }
  reset() {
    this.state = { version: 1, clients: {}, grants: {}, tokens: {} };
    this.pending.clear();
    this.codes.clear();
    this.save();
  }
}
