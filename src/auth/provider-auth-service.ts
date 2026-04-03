import fs from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config/index.js";
import type { SqliteStorage } from "../storage/sqlite-storage.js";
import type { ProviderCredential, ProviderId, ProviderOAuthCredential } from "../types/runtime.js";

const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
const CODEX_AUTH_FILENAME = "auth.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStoredCredential(providerId: ProviderId, raw: Record<string, unknown> | null): ProviderCredential | null {
  if (!raw) {
    return null;
  }

  if (raw.type === "api-key" && typeof raw.apiKey === "string" && raw.apiKey) {
    return {
      type: "api-key",
      provider: providerId,
      apiKey: raw.apiKey
    };
  }

  if (
    raw.type === "oauth" &&
    typeof raw.accessToken === "string" &&
    typeof raw.refreshToken === "string" &&
    typeof raw.expiresAt === "number"
  ) {
    const credential: ProviderOAuthCredential = {
      type: "oauth",
      provider: providerId,
      accessToken: raw.accessToken,
      refreshToken: raw.refreshToken,
      expiresAt: raw.expiresAt
    };

    if (typeof raw.accountId === "string" && raw.accountId) {
      credential.accountId = raw.accountId;
    }
    if (typeof raw.email === "string" && raw.email) {
      credential.email = raw.email;
    }

    return credential;
  }

  return null;
}

function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".");
  const payloadPart = parts[1];
  if (!payloadPart) {
    return null;
  }

  try {
    const payloadRaw = Buffer.from(payloadPart, "base64url").toString("utf8");
    const payload = JSON.parse(payloadRaw) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function extractAccountId(tokens: Record<string, unknown>): string | undefined {
  const candidates = [tokens.id_token, tokens.access_token];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) {
      continue;
    }

    try {
      const payloadRaw = Buffer.from(candidate.split(".")[1] ?? "", "base64url").toString("utf8");
      const claims = JSON.parse(payloadRaw) as Record<string, unknown>;
      if (typeof claims.chatgpt_account_id === "string" && claims.chatgpt_account_id) {
        return claims.chatgpt_account_id;
      }

      const nested = claims["https://api.openai.com/auth"];
      if (isRecord(nested) && typeof nested.chatgpt_account_id === "string" && nested.chatgpt_account_id) {
        return nested.chatgpt_account_id;
      }

      const organizations = claims.organizations;
      if (Array.isArray(organizations) && isRecord(organizations[0]) && typeof organizations[0].id === "string") {
        return organizations[0].id;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

async function readCodexHomeCredential(codexHomePath: string): Promise<ProviderOAuthCredential | null> {
  const authPath = path.join(codexHomePath, CODEX_AUTH_FILENAME);
  const raw = JSON.parse(await fs.readFile(authPath, "utf8")) as unknown;
  if (!isRecord(raw)) {
    return null;
  }

  const tokens = isRecord(raw.tokens) ? raw.tokens : raw;
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || !accessToken || !refreshToken) {
    return null;
  }

  const expiresAt = decodeJwtExpiryMs(accessToken) ?? Date.now() + 60 * 60 * 1000;
  const credential: ProviderOAuthCredential = {
    type: "oauth",
    provider: "openai-codex",
    accessToken,
    refreshToken,
    expiresAt
  };
  const accountId = extractAccountId(tokens);
  if (accountId) {
    credential.accountId = accountId;
  }
  if (typeof tokens.email === "string" && tokens.email) {
    credential.email = tokens.email;
  }
  return credential;
}

export class ProviderAuthService {
  public constructor(
    private readonly storage: SqliteStorage,
    private readonly config: AppConfig
  ) {}

  public get(providerId: ProviderId): ProviderCredential | null {
    return normalizeStoredCredential(providerId, this.storage.getProviderAuth(providerId));
  }

  public set(credential: ProviderCredential): void {
    this.storage.upsertProviderAuth(credential.provider, credential as unknown as Record<string, unknown>);
  }

  public clear(providerId: ProviderId): void {
    this.storage.clearProviderAuth(providerId);
  }

  public async importFromCodexHome(): Promise<void> {
    const imported = await readCodexHomeCredential(this.config.codexHomePath).catch(() => null);
    if (!imported) {
      return;
    }

    const existing = this.get("openai-codex");
    if (!existing || existing.type !== "oauth" || imported.expiresAt > existing.expiresAt) {
      this.set(imported);
    }
  }

  public async refreshIfNeeded(providerId: ProviderId): Promise<ProviderCredential | null> {
    const credential = this.get(providerId);
    if (!credential || credential.type !== "oauth") {
      return credential;
    }

    if (credential.expiresAt > Date.now() + 30_000) {
      return credential;
    }

    const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
        client_id: OPENAI_OAUTH_CLIENT_ID
      }).toString()
    });

    if (!response.ok) {
      throw new Error(`OAuth token refresh failed for ${providerId}: ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const refreshed: ProviderOAuthCredential = {
      type: "oauth",
      provider: providerId,
      accessToken: String(payload.access_token ?? ""),
      refreshToken: String(payload.refresh_token ?? credential.refreshToken),
      expiresAt:
        Date.now() +
        (typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600) * 1000
    };
    const accountId = extractAccountId(payload) ?? credential.accountId;
    if (accountId) {
      refreshed.accountId = accountId;
    }
    if (credential.email) {
      refreshed.email = credential.email;
    }
    this.set(refreshed);
    return refreshed;
  }

  public status(): Array<{ provider: ProviderId; authMode: "api-key" | "oauth"; expiresAt?: number; accountId?: string }> {
    const rows = this.storage.listProviderAuth();
    return rows
      .map(({ providerId, credential }) => normalizeStoredCredential(providerId as ProviderId, credential))
      .filter((credential): credential is ProviderCredential => credential !== null)
      .map((credential) => {
        if (credential.type === "api-key") {
          return { provider: credential.provider, authMode: "api-key" as const };
        }

        const status: { provider: ProviderId; authMode: "oauth"; expiresAt: number; accountId?: string } = {
          provider: credential.provider,
          authMode: "oauth",
          expiresAt: credential.expiresAt
        };
        if (credential.accountId) {
          status.accountId = credential.accountId;
        }
        return status;
      });
  }
}
