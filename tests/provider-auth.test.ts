import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ProviderAuthService } from "../src/auth/provider-auth-service.js";
import { SqliteStorage } from "../src/storage/sqlite-storage.js";
import { createTempDir, createTestConfig } from "./test-utils.js";

describe("provider auth service", () => {
  it("imports fresher codex oauth credentials from CODEX_HOME", async () => {
    const root = await createTempDir("nanoclaw-auth-");
    const config = createTestConfig(root);
    const storage = new SqliteStorage(config.sqlitePath);
    const service = new ProviderAuthService(storage, config);

    try {
      await fs.mkdir(config.codexHomePath, { recursive: true });
      const accessPayload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }), "utf8").toString(
        "base64url"
      );
      const token = `header.${accessPayload}.sig`;
      await fs.writeFile(
        path.join(config.codexHomePath, "auth.json"),
        JSON.stringify({
          access_token: token,
          refresh_token: "refresh-token"
        })
      );

      await service.importFromCodexHome();

      const credential = service.get("openai-codex");
      expect(credential?.type).toBe("oauth");
      expect(credential && credential.type === "oauth" ? credential.refreshToken : "").toBe("refresh-token");
    } finally {
      storage.close();
    }
  });
});
