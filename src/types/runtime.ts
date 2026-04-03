import type { RegisteredGroup } from "./host.js";

export type RuntimeMessageRole = "system" | "user" | "assistant";
export type RuntimeExecutionMode = "host" | "container";
export type ProviderId = "openai" | "openai-codex";
export type ProviderAuthMode = "api-key" | "oauth";

export interface ModelRef {
  provider: ProviderId;
  modelId: string;
}

export interface ProviderOAuthCredential {
  type: "oauth";
  provider: ProviderId;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
}

export interface ProviderApiKeyCredential {
  type: "api-key";
  provider: ProviderId;
  apiKey: string;
}

export type ProviderCredential = ProviderOAuthCredential | ProviderApiKeyCredential;

export interface RuntimeMessage {
  role: RuntimeMessageRole;
  content: string;
}

export interface RuntimeToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface PersistedRuntimeSession {
  id: string;
  runtimeName: string;
  groupId: string;
  externalSessionId?: string;
  provider?: ProviderId;
  modelId?: string;
  authMode?: ProviderAuthMode;
  accountId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSessionInput {
  groupId: string;
  group?: RegisteredGroup;
  workingDirectory: string;
  memoryFiles: string[];
  runtimeTimeoutMs: number;
  model?: ModelRef;
  systemInstructions?: string;
  sessionHint?: PersistedRuntimeSession | null;
}

export interface RuntimeSession {
  id: string;
  externalSessionId?: string;
  provider?: ProviderId;
  modelId?: string;
  authMode?: ProviderAuthMode;
  metadata?: Record<string, unknown>;
}

export interface RuntimeTurnInput {
  taskId?: string;
  sessionId: string;
  group?: RegisteredGroup;
  workingDirectory: string;
  messages: RuntimeMessage[];
  memoryFiles: string[];
  sessionsPath?: string;
  model?: ModelRef;
  runtimeTimeoutMs: number;
  tools?: RuntimeToolSpec[];
}

export interface RuntimeCapabilities {
  executionMode: RuntimeExecutionMode;
  structuredToolEvents: boolean;
  supportsSessionResume: boolean;
  supportsToolEvents: boolean;
  supportsHardCancel: boolean;
  streamingText: boolean;
}

export type RuntimeEvent =
  | { type: "status"; value: string }
  | { type: "message"; text: string }
  | { type: "tool_call"; name: string; payload: unknown }
  | { type: "tool_result"; name: string; payload: unknown }
  | { type: "error"; error: string }
  | {
      type: "done";
      usage?: {
        provider?: ProviderId;
        modelId?: string;
        finishReason?: string;
        tokenUsage?: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        };
        exitCode?: number | null;
      };
    };

export interface AgentRuntime {
  readonly name: string;
  createSession(input: RuntimeSessionInput): Promise<RuntimeSession>;
  runTurn(input: RuntimeTurnInput): AsyncIterable<RuntimeEvent>;
  cancel(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  capabilities(): RuntimeCapabilities;
}
