import { randomUUID } from "node:crypto";

import type { TaskScheduler } from "../scheduler/task-scheduler.js";
import type { SqliteStorage } from "../storage/sqlite-storage.js";
import type { ContainerConfig, GroupRuntimeConfig, RegisteredGroup } from "../types/host.js";

export interface OutboundMessageSender {
  sendToGroup(groupId: string, text: string): Promise<void>;
}

export class ControlPlane {
  public constructor(
    private readonly storage: SqliteStorage,
    private readonly scheduler: TaskScheduler,
    private readonly outboundSender: OutboundMessageSender,
    private readonly defaultTrigger: string
  ) {}

  public registerGroup(input: {
    channel: string;
    externalId: string;
    folder: string;
    isMain?: boolean;
    trigger?: string;
    containerConfig?: ContainerConfig;
    runtimeConfig?: GroupRuntimeConfig;
  }): RegisteredGroup {
    const group: RegisteredGroup = {
      id: randomUUID(),
      channel: input.channel,
      externalId: input.externalId,
      folder: input.folder,
      isMain: input.isMain ?? false,
      trigger: input.trigger ?? this.defaultTrigger,
      containerConfig: input.containerConfig ?? { additionalMounts: [] },
      createdAt: new Date().toISOString()
    };
    if (input.runtimeConfig) {
      group.runtimeConfig = input.runtimeConfig;
    }

    this.storage.registerGroup(group);
    return group;
  }

  public listGroups(): RegisteredGroup[] {
    return this.storage.listRegisteredGroups();
  }

  public updateGroupMounts(groupId: string, containerConfig: ContainerConfig): void {
    this.storage.updateGroupMounts(groupId, containerConfig);
  }

  public updateGroupRuntime(groupId: string, runtimeConfig: GroupRuntimeConfig): void {
    this.storage.updateGroupRuntime(groupId, runtimeConfig);
  }

  public scheduleTask(input: { groupId: string; prompt: string; intervalMs?: number; runAt?: string }): { jobId: string } {
    const job =
      input.intervalMs && input.intervalMs > 0
        ? this.scheduler.createRecurring(input.groupId, input.prompt, input.intervalMs)
        : this.scheduler.createOneShot(input.groupId, input.prompt, input.runAt ? new Date(input.runAt) : new Date());
    return { jobId: job.id };
  }

  public listTasks(groupId?: string): ReturnType<SqliteStorage["listTasks"]> {
    return this.storage.listTasks(groupId);
  }

  public getTask(taskId: string): ReturnType<SqliteStorage["getTask"]> {
    return this.storage.getTask(taskId);
  }

  public pauseTask(taskId: string): void {
    const task = this.storage.getTask(taskId);
    if (task?.scheduledJobId) {
      this.storage.setScheduledJobActive(task.scheduledJobId, false);
    }
    this.storage.updateTaskStatus(taskId, "paused");
  }

  public resumeTask(taskId: string): void {
    const task = this.storage.getTask(taskId);
    if (task?.scheduledJobId) {
      this.storage.setScheduledJobActive(task.scheduledJobId, true);
    }
    this.storage.updateTaskStatus(taskId, "queued");
  }

  public cancelTask(taskId: string): void {
    const task = this.storage.getTask(taskId);
    if (task?.scheduledJobId) {
      this.storage.setScheduledJobActive(task.scheduledJobId, false);
    }
    this.storage.updateTaskStatus(taskId, "cancelled");
  }

  public async sendMessage(groupId: string, text: string): Promise<void> {
    await this.outboundSender.sendToGroup(groupId, text);
  }
}
