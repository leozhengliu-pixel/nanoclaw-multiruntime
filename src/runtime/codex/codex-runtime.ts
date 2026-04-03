import { randomUUID } from "node:crypto";

import type { ProviderAuthService } from "../../auth/provider-auth-service.js";
import type { AgentRunnerMode } from "../../config/index.js";
import type { RunnerTaskRequest } from "../../ipc/protocol.js";
import { getDefaultModelRef, supportsModelForAuthMode } from "../openai/model-policy.js";
import type { ContainerRunner } from "../../runner/container-runner.js";
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
  RuntimeSessionInput,
  RuntimeTurnInput
} from "../../types/runtime.js";

export class CodexRuntime implements AgentRuntime {
  public readonly name = "codex";
  private readonly cancelled = new Set<string>();

  public constructor(
    private readonly binaryPath: string,
    private readonly defaultTimeoutMs: number,
    private readonly authService: ProviderAuthService,
    private readonly runnerMode: AgentRunnerMode,
    private runner?: ContainerRunner
  ) {}

  public attachRunner(runner: ContainerRunner): void {
    this.runner = runner;
  }

  public async createSession(input: RuntimeSessionInput): Promise<RuntimeSession> {
    const sessionId = randomUUID();
    const model = input.model ?? input.group?.runtimeConfig ?? getDefaultModelRef();
    const isMockMode = this.runnerMode === "mock";
    if (isMockMode) {
      return {
        id: sessionId,
        provider: model.provider,
        modelId: model.modelId,
        authMode: "oauth",
        metadata: { executionMode: "container", mockMode: true }
      };
    }

    const credential = await this.authService.refreshIfNeeded(model.provider);
    const authMode = credential?.type === "oauth" ? "oauth" : credential?.type === "api-key" ? "api-key" : undefined;
    if (!credential || !authMode || !supportsModelForAuthMode(model, authMode)) {
      throw new Error(
        !credential
          ? `Missing auth for ${model.provider}`
          : `Unsupported model for auth: ${model.provider}/${model.modelId} requires ${authMode === "oauth" ? "openai-codex OAuth" : "OpenAI API key"}`
      );
    }

    if (input.sessionHint?.externalSessionId) {
      return {
        id: sessionId,
        externalSessionId: input.sessionHint.externalSessionId,
        provider: model.provider,
        modelId: model.modelId,
        authMode,
        metadata: {
          resumedFromHint: true,
          accountId: credential.type === "oauth" ? credential.accountId : undefined
        }
      };
    }

    return {
      id: sessionId,
      provider: model.provider,
      modelId: model.modelId,
      authMode,
      metadata: {
        executionMode: "container",
        accountId: credential.type === "oauth" ? credential.accountId : undefined
      }
    };
  }

  public async *runTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    if (!input.group) {
      throw new Error("CodexRuntime requires group context for container execution");
    }
    if (!this.runner) {
      throw new Error("CodexRuntime runner is not attached");
    }

    const model = input.model ?? input.group.runtimeConfig ?? getDefaultModelRef();
    const resolvedCredential = this.runnerMode === "mock" ? undefined : await this.authService.refreshIfNeeded(model.provider);
    const credential = resolvedCredential ?? undefined;
    if (this.runnerMode !== "mock" && !credential) {
      throw new Error(`Missing auth for ${model.provider}`);
    }

    const request: RunnerTaskRequest = {
      taskId: input.taskId ?? input.sessionId,
      sessionId: input.sessionId,
      group: input.group,
      workingDirectory: input.workingDirectory,
      globalMemoryFile: input.memoryFiles[0] ?? "",
      groupMemoryFile: input.memoryFiles[1] ?? "",
      sessionsPath: input.sessionsPath ?? "",
      messages: input.messages,
      provider: model.provider,
      modelId: model.modelId,
      codexBinaryPath: this.binaryPath,
      runtimeTimeoutMs: input.runtimeTimeoutMs || this.defaultTimeoutMs,
      mode: this.runnerMode === "mock" ? "mock" : "codex",
      containerConfig: input.group.containerConfig,
      ...(credential ? { auth: credential } : {})
    };

    for await (const event of this.runner.run(request)) {
      if (this.cancelled.has(input.sessionId)) {
        yield { type: "error", error: "cancelled" };
        yield { type: "done" };
        return;
      }

      yield event;
    }
  }

  public async cancel(sessionId: string): Promise<void> {
    this.cancelled.add(sessionId);
    await this.runner?.cancel(sessionId);
  }

  public async close(sessionId: string): Promise<void> {
    this.cancelled.delete(sessionId);
  }

  public capabilities(): RuntimeCapabilities {
    return {
      executionMode: "container",
      structuredToolEvents: false,
      supportsSessionResume: false,
      supportsToolEvents: true,
      supportsHardCancel: false,
      streamingText: false
    };
  }
}
