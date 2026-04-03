import type { ContainerConfig, RegisteredGroup } from "../types/host.js";
import type { ProviderCredential, ProviderId, RuntimeEvent, RuntimeMessage } from "../types/runtime.js";

export interface RunnerTaskRequest {
  taskId: string;
  sessionId: string;
  group: RegisteredGroup;
  workingDirectory: string;
  globalMemoryFile: string;
  groupMemoryFile: string;
  sessionsPath: string;
  messages: RuntimeMessage[];
  provider: ProviderId;
  modelId: string;
  auth?: ProviderCredential;
  codexBinaryPath: string;
  runtimeTimeoutMs: number;
  mode: "codex" | "mock";
  containerConfig: ContainerConfig;
}

export interface ToolRequestPayload {
  name:
    | "schedule_task"
    | "list_tasks"
    | "get_task"
    | "pause_task"
    | "resume_task"
    | "cancel_task"
    | "send_message"
    | "register_group"
    | "list_groups"
    | "update_group_mounts";
  args: Record<string, unknown>;
}

export interface ToolRequestEnvelope {
  id: string;
  taskId: string;
  payload: ToolRequestPayload;
}

export interface ToolResponseEnvelope {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface RuntimeEventEnvelope {
  taskId: string;
  event: RuntimeEvent;
}
