import { randomUUID } from "node:crypto";

import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionInput,
  RuntimeTurnInput
} from "../../types/runtime.js";

export interface MockRuntimeOptions {
  delayMs?: number;
  messagePrefix?: string;
  onRunStart?: () => void;
  onRunFinish?: () => void;
  onTurnInput?: (input: RuntimeTurnInput) => void;
}

export class MockRuntime implements AgentRuntime {
  public readonly name = "mock";
  private readonly options: MockRuntimeOptions;
  private readonly cancelled = new Set<string>();

  public constructor(options: MockRuntimeOptions = {}) {
    this.options = options;
  }

  public async createSession(input: RuntimeSessionInput): Promise<RuntimeSession> {
    if (input.sessionHint?.id) {
      return {
        id: input.sessionHint.id
      };
    }

    return {
      id: randomUUID()
    };
  }

  public async *runTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    this.options.onRunStart?.();
    this.options.onTurnInput?.(input);
    yield { type: "status", value: "running" };

    if (this.options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }

    if (this.cancelled.has(input.sessionId)) {
      yield { type: "error", error: "cancelled" };
      yield { type: "done" };
      this.options.onRunFinish?.();
      return;
    }

    const text = input.messages[input.messages.length - 1]?.content ?? "";
    yield {
      type: "message",
      text: `${this.options.messagePrefix ?? "mock"}:${text}`
    };
    yield { type: "done" };
    this.options.onRunFinish?.();
  }

  public async cancel(sessionId: string): Promise<void> {
    this.cancelled.add(sessionId);
  }

  public async close(sessionId: string): Promise<void> {
    void sessionId;
    return;
  }

  public capabilities(): RuntimeCapabilities {
    return {
      executionMode: "host",
      structuredToolEvents: false,
      supportsSessionResume: false,
      supportsToolEvents: false,
      supportsHardCancel: false,
      streamingText: true
    };
  }
}
