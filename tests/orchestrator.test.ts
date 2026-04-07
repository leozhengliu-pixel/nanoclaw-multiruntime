import { describe, expect, it } from "vitest";

import { LocalDevChannel } from "../src/channels/local-dev-channel.js";
import { createOrchestrator } from "../src/orchestrator.js";
import { setRegisteredGroup } from "../src/db.js";
import { MockRuntime } from "../src/runtime/mock/mock-runtime.js";
import { createTempDir, createTestConfig } from "./test-utils.js";

async function waitForSentMessage(
  channel: LocalDevChannel,
  expectedText: string
): Promise<Array<{ externalId: string; text: string }>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const sent = channel.getSentMessages();
    if (sent.some((entry) => entry.text.includes(expectedText))) {
      return sent;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return channel.getSentMessages();
}

describe("orchestrator", () => {
  it("processes local-dev messages through the root orchestrator path", async () => {
    const root = await createTempDir("nanoclaw-orchestrator-");
    const orchestrator = await createOrchestrator(
      createTestConfig(root, { agentRunnerMode: "mock" }),
      new MockRuntime({ messagePrefix: "orchestrator" })
    );

    try {
      orchestrator.start();
      const channel = orchestrator.channels.get("local-dev");
      expect(channel).toBeInstanceOf(LocalDevChannel);

      await (channel as LocalDevChannel).emitInbound("local-dev:default", "@Andy hello");
      const sent = await waitForSentMessage(channel as LocalDevChannel, "orchestrator:hello");
      expect(sent.at(-1)?.text).toContain("orchestrator:hello");
    } finally {
      await orchestrator.stop();
    }
  });

  it("includes recent chat history in runtime turn input", async () => {
    const root = await createTempDir("nanoclaw-orchestrator-history-");
    const turnInputs: string[][] = [];
    const orchestrator = await createOrchestrator(
      createTestConfig(root, { agentRunnerMode: "mock" }),
      new MockRuntime({
        messagePrefix: "history",
        onTurnInput(input) {
          turnInputs.push(input.messages.map((message) => `${message.role}:${message.content}`));
        }
      })
    );

    try {
      orchestrator.start();
      const channel = orchestrator.channels.get("local-dev");
      expect(channel).toBeInstanceOf(LocalDevChannel);

      await (channel as LocalDevChannel).emitInbound("local-dev:default", "@Andy first");
      await waitForSentMessage(channel as LocalDevChannel, "history:first");

      await (channel as LocalDevChannel).emitInbound("local-dev:default", "@Andy second");
      await waitForSentMessage(channel as LocalDevChannel, "history:second");

      expect(turnInputs.at(-1)).toEqual(["user:first", "assistant:history:first", "user:second"]);
    } finally {
      await orchestrator.stop();
    }
  });

  it("loads registered groups from the database into the orchestrator view", async () => {
    const root = await createTempDir("nanoclaw-orchestrator-groups-");
    const config = createTestConfig(root, { agentRunnerMode: "mock" });
    const groupId = "local-dev:db-only";
    const orchestrator = await createOrchestrator(config, new MockRuntime({ messagePrefix: "db" }));

    setRegisteredGroup(groupId, {
      name: "db-only",
      folder: "db-only",
      trigger: "@Andy",
      added_at: new Date().toISOString(),
      channel: "local-dev",
      externalId: groupId
    });

    try {
      orchestrator.start();
      const registered = orchestrator.app.storage.getRegisteredGroup(groupId);
      expect(registered).not.toBeNull();
      expect(registered?.folder).toBe("db-only");
      const groups = orchestrator.app.controlPlane.listGroups(groupId) as Array<{ id: string }>;
      expect(groups.some((group) => group.id === groupId)).toBe(true);
    } finally {
      await orchestrator.stop();
    }
  });
});
