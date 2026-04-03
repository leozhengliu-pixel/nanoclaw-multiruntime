import { randomUUID } from "node:crypto";

import type { SqliteStorage } from "../storage/sqlite-storage.js";
import type { HostTask, InboundMessage, TaskExecutionResult } from "../types/host.js";
import type { AgentRuntime, PersistedRuntimeSession, RuntimeEvent, RuntimeMessage } from "../types/runtime.js";
import { getDefaultModelRef } from "../runtime/openai/model-policy.js";
import { GroupManager } from "./group-manager.js";
import { HostQueue } from "./host-queue.js";

export class HostService {
  private readonly cancelledTaskIds = new Set<string>();

  public constructor(
    private readonly runtime: AgentRuntime,
    private readonly storage: SqliteStorage,
    private readonly groupManager: GroupManager,
    private readonly queue: HostQueue,
    private readonly runtimeTimeoutMs: number
  ) {}

  public async handleInboundMessage(message: InboundMessage): Promise<TaskExecutionResult> {
    const group = this.storage.getRegisteredGroupByAddress(message.channel, message.externalId);
    if (!group) {
      throw new Error(`Unregistered group for ${message.channel}:${message.externalId}`);
    }

    return this.enqueueTask({
      groupId: group.id,
      kind: "message",
      prompt: message.text,
      messages: [{ role: "user", content: message.text }]
    });
  }

  public async enqueueScheduledPrompt(groupId: string, prompt: string, scheduledJobId?: string): Promise<TaskExecutionResult> {
    const taskInput = {
      groupId,
      kind: "scheduled",
      prompt,
      messages: [{ role: "user", content: prompt }]
    } as {
      groupId: string;
      kind: HostTask["kind"];
      prompt: string;
      messages: RuntimeMessage[];
      scheduledJobId?: string;
    };

    if (scheduledJobId) {
      taskInput.scheduledJobId = scheduledJobId;
    }

    return this.enqueueTask(taskInput);
  }

  public async cancelTask(taskId: string): Promise<void> {
    this.cancelledTaskIds.add(taskId);
    this.storage.updateTaskStatus(taskId, "cancelled");
  }

  private async enqueueTask(input: {
    groupId: string;
    kind: HostTask["kind"];
    prompt: string;
    messages: RuntimeMessage[];
    scheduledJobId?: string;
  }): Promise<TaskExecutionResult> {
    const task = {
      id: randomUUID(),
      groupId: input.groupId,
      kind: input.kind,
      prompt: input.prompt,
      messages: input.messages,
      createdAt: new Date().toISOString()
    } as HostTask;

    if (input.scheduledJobId) {
      task.scheduledJobId = input.scheduledJobId;
    }

    const taskRecord = {
      id: task.id,
      groupId: task.groupId,
      kind: task.kind,
      prompt: task.prompt,
      status: "queued",
      createdAt: task.createdAt
    } as Parameters<SqliteStorage["createTask"]>[0];

    if (task.scheduledJobId) {
      taskRecord.scheduledJobId = task.scheduledJobId;
    }

    this.storage.createTask(taskRecord);
    return this.queue.enqueue(task, async () => this.executeTask(task));
  }

  private async executeTask(task: HostTask): Promise<TaskExecutionResult> {
    const registeredGroup = this.storage.getRegisteredGroup(task.groupId);
    if (!registeredGroup) {
      throw new Error(`Unknown registered group: ${task.groupId}`);
    }

    const group = await this.groupManager.ensureGroup(registeredGroup);
    this.storage.upsertGroup(group);
    this.storage.updateTaskStatus(task.id, "running");

    const previousSession = this.storage.getLatestRuntimeSession(task.groupId, this.runtime.name);
    const memoryFiles = [group.globalMemoryFile, group.groupMemoryFile];
    const model = registeredGroup.runtimeConfig ?? getDefaultModelRef();
    const runtimeTimeoutMs = registeredGroup.containerConfig.timeoutMs ?? this.runtimeTimeoutMs;

    const session = await this.runtime.createSession({
      groupId: task.groupId,
      group: registeredGroup,
      workingDirectory: group.workspacePath,
      memoryFiles,
      runtimeTimeoutMs,
      model,
      sessionHint: previousSession
    });

    const persistedSession = {
      id: session.id,
      runtimeName: this.runtime.name,
      groupId: task.groupId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } as PersistedRuntimeSession;

    if (session.externalSessionId) {
      persistedSession.externalSessionId = session.externalSessionId;
    }
    if (session.provider) {
      persistedSession.provider = session.provider;
    }
    if (session.modelId) {
      persistedSession.modelId = session.modelId;
    }
    if (session.authMode) {
      persistedSession.authMode = session.authMode;
    }
    if (session.metadata?.accountId && typeof session.metadata.accountId === "string") {
      persistedSession.accountId = session.metadata.accountId;
    }

    if (session.metadata) {
      persistedSession.metadata = session.metadata;
    }

    this.storage.upsertRuntimeSession(persistedSession);

    const events: RuntimeEvent[] = [];
    let finalStatus: TaskExecutionResult["status"] = "completed";

    for await (const event of this.runtime.runTurn({
      taskId: task.id,
      sessionId: session.id,
      group: registeredGroup,
      workingDirectory: group.workspacePath,
      messages: task.messages,
      memoryFiles,
      sessionsPath: group.sessionsPath,
      model,
      runtimeTimeoutMs
    })) {
      if (this.cancelledTaskIds.has(task.id)) {
        finalStatus = "cancelled";
        break;
      }

      if (event.type === "error") {
        finalStatus = "failed";
      }

      events.push(event);
      this.storage.appendTranscript({
        taskId: task.id,
        groupId: task.groupId,
        createdAt: new Date().toISOString(),
        event
      });
    }

    this.storage.updateTaskStatus(task.id, finalStatus, session.id);
    if (finalStatus !== "cancelled") {
      await this.runtime.close(session.id);
    }

    return {
      taskId: task.id,
      events,
      sessionId: session.id,
      status: finalStatus
    };
  }
}
