import { describe, expect, it } from "vitest";

import { MockRuntime } from "../src/runtime/mock/mock-runtime.js";

describe("runtime contracts", () => {
  it("mock runtime creates sessions and emits baseline events", async () => {
    const runtime = new MockRuntime();
    const session = await runtime.createSession({
      groupId: "group-a",
      workingDirectory: process.cwd(),
      memoryFiles: [],
      runtimeTimeoutMs: 1000
    });

    const events = [];
    for await (const event of runtime.runTurn({
      sessionId: session.id,
      workingDirectory: process.cwd(),
      memoryFiles: [],
      messages: [{ role: "user", content: "hello" }],
      runtimeTimeoutMs: 1000
    })) {
      events.push(event.type);
    }

    expect(events).toEqual(["status", "message", "done"]);
    expect(runtime.capabilities()).toEqual({
      executionMode: "host",
      structuredToolEvents: false,
      supportsSessionResume: false,
      supportsToolEvents: false,
      supportsHardCancel: false,
      streamingText: true
    });
  });
});
