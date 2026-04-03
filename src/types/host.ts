import type { ModelRef, RuntimeEvent, RuntimeMessage } from "./runtime.js";

export interface ChannelAddress {
  channel: string;
  externalId: string;
}

export interface InboundMessage extends ChannelAddress {
  text: string;
  senderId?: string;
  senderName?: string;
}

export interface AdditionalMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface ContainerConfig {
  additionalMounts: AdditionalMount[];
  timeoutMs?: number;
}

export type GroupRuntimeConfig = ModelRef;

export interface GroupRecord {
  id: string;
  createdAt: string;
  workspacePath: string;
  memoryPath: string;
  sessionsPath: string;
}

export interface RegisteredGroup extends ChannelAddress {
  id: string;
  folder: string;
  isMain: boolean;
  trigger: string;
  containerConfig: ContainerConfig;
  runtimeConfig?: GroupRuntimeConfig;
  createdAt: string;
}

export type TaskKind = "message" | "scheduled";
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "paused";

export interface HostTask {
  id: string;
  groupId: string;
  kind: TaskKind;
  prompt: string;
  messages: RuntimeMessage[];
  createdAt: string;
  scheduledJobId?: string;
}

export interface TranscriptRecord {
  taskId: string;
  groupId: string;
  createdAt: string;
  event: RuntimeEvent;
}

export type ScheduledJobKind = "one-shot" | "recurring";

export interface ScheduledJob {
  id: string;
  groupId: string;
  prompt: string;
  kind: ScheduledJobKind;
  nextRunAt: string;
  intervalMs?: number;
  active: boolean;
  createdAt: string;
  lastRunAt?: string;
}

export interface TaskExecutionResult {
  taskId: string;
  events: RuntimeEvent[];
  sessionId: string;
  status: TaskStatus;
}

export interface RemoteControlEvent {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  createdAt: string;
  details?: Record<string, unknown>;
}
