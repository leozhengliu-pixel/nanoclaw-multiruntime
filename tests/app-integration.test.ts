import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { LocalDevChannel } from "../src/channels/local-dev-channel.js";
import { MainLocalChannel } from "../src/channels/main-local-channel.js";
import { createTempDir, createTestConfig } from "./test-utils.js";

describe("app integration", () => {
  it("routes a local-dev message through router and sends outbound reply", async () => {
    const root = await createTempDir("nanoclaw-v2-app-");
    const app = await createApp(
      createTestConfig(root, {
        agentRunnerMode: "mock"
      })
    );

    try {
      const channel = app.channels.get("local-dev");
      expect(channel).toBeInstanceOf(LocalDevChannel);
      await (channel as LocalDevChannel).emitInbound("local-dev:default", "@Andy hello");

      const sent = (channel as LocalDevChannel).getSentMessages();
      expect(sent.at(-1)?.text).toContain("mock-container:hello");
      expect(app.storage.listTasks().length).toBe(1);
    } finally {
      await app.stop();
    }
  });

  it("main-local can register a new group through control path", async () => {
    const root = await createTempDir("nanoclaw-v2-main-");
    const app = await createApp(createTestConfig(root));

    try {
      const channel = app.channels.get("main-local");
      expect(channel).toBeInstanceOf(MainLocalChannel);
      await (channel as MainLocalChannel).emitInbound(
        "main-local:control",
        "/register-group local-dev local-dev:team team-folder"
      );

      const registered = app.storage.getRegisteredGroupByAddress("local-dev", "local-dev:team");
      expect(registered?.folder).toBe("team-folder");
    } finally {
      await app.stop();
    }
  });
});
