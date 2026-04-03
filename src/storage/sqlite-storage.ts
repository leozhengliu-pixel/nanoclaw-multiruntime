import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  ContainerConfig,
  GroupRuntimeConfig,
  GroupRecord,
  RegisteredGroup,
  RemoteControlEvent,
  ScheduledJob,
  ScheduledJobKind,
  TaskStatus,
  TranscriptRecord
} from "../types/host.js";
import type { PersistedRuntimeSession, RuntimeEvent } from "../types/runtime.js";

interface JobRow {
  id: string;
  group_id: string;
  prompt: string;
  kind: ScheduledJobKind;
  next_run_at: string;
  interval_ms: number | null;
  active: number;
  created_at: string;
  last_run_at: string | null;
}

interface RegisteredGroupRow {
  id: string;
  channel: string;
  external_id: string;
  folder: string;
  is_main: number;
  trigger: string;
  container_config_json: string | null;
  runtime_config_json: string | null;
  created_at: string;
}

interface ProviderAuthRow {
  provider_id: string;
  credential_json: string;
  created_at: string;
  updated_at: string;
}

export class SqliteStorage {
  private readonly db: Database.Database;

  public constructor(sqlitePath: string) {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    this.db = new Database(sqlitePath);
    this.db.pragma("journal_mode = WAL");
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        memory_path TEXT NOT NULL,
        sessions_path TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS registered_groups (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        external_id TEXT NOT NULL,
        folder TEXT NOT NULL,
        is_main INTEGER NOT NULL,
        trigger TEXT NOT NULL,
        container_config_json TEXT,
        runtime_config_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(channel, external_id)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        session_id TEXT,
        scheduled_job_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_sessions (
        id TEXT PRIMARY KEY,
        runtime_name TEXT NOT NULL,
        group_id TEXT NOT NULL,
        external_session_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transcript_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        kind TEXT NOT NULL,
        next_run_at TEXT NOT NULL,
        interval_ms INTEGER,
        active INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_run_at TEXT
      );

      CREATE TABLE IF NOT EXISTS remote_control_events (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_auth (
        provider_id TEXT PRIMARY KEY,
        credential_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  public upsertGroup(group: GroupRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO groups (id, created_at, workspace_path, memory_path, sessions_path)
          VALUES (@id, @createdAt, @workspacePath, @memoryPath, @sessionsPath)
          ON CONFLICT(id) DO UPDATE SET
            workspace_path = excluded.workspace_path,
            memory_path = excluded.memory_path,
            sessions_path = excluded.sessions_path
        `
      )
      .run(group);
  }

  public registerGroup(group: RegisteredGroup): void {
    this.db
      .prepare(
        `
          INSERT INTO registered_groups (
            id, channel, external_id, folder, is_main, trigger, container_config_json, runtime_config_json, created_at
          ) VALUES (
            @id, @channel, @externalId, @folder, @isMain, @trigger, @containerConfigJson, @runtimeConfigJson, @createdAt
          )
          ON CONFLICT(id) DO UPDATE SET
            channel = excluded.channel,
            external_id = excluded.external_id,
            folder = excluded.folder,
            is_main = excluded.is_main,
            trigger = excluded.trigger,
            container_config_json = excluded.container_config_json,
            runtime_config_json = excluded.runtime_config_json
        `
      )
      .run({
        id: group.id,
        channel: group.channel,
        externalId: group.externalId,
        folder: group.folder,
        isMain: group.isMain ? 1 : 0,
        trigger: group.trigger,
        containerConfigJson: JSON.stringify(group.containerConfig),
        runtimeConfigJson: JSON.stringify(group.runtimeConfig ?? null),
        createdAt: group.createdAt
      });
  }

  public getRegisteredGroupByAddress(channel: string, externalId: string): RegisteredGroup | null {
    const row = this.db
      .prepare("SELECT * FROM registered_groups WHERE channel = ? AND external_id = ?")
      .get(channel, externalId) as RegisteredGroupRow | undefined;

    return row ? this.mapRegisteredGroup(row) : null;
  }

  public getRegisteredGroup(groupId: string): RegisteredGroup | null {
    const row = this.db.prepare("SELECT * FROM registered_groups WHERE id = ?").get(groupId) as RegisteredGroupRow | undefined;
    return row ? this.mapRegisteredGroup(row) : null;
  }

  public listRegisteredGroups(): RegisteredGroup[] {
    const rows = this.db.prepare("SELECT * FROM registered_groups ORDER BY created_at ASC").all() as RegisteredGroupRow[];
    return rows.map((row) => this.mapRegisteredGroup(row));
  }

  public updateGroupMounts(groupId: string, containerConfig: ContainerConfig): void {
    this.db
      .prepare("UPDATE registered_groups SET container_config_json = ? WHERE id = ?")
      .run(JSON.stringify(containerConfig), groupId);
  }

  public updateGroupRuntime(groupId: string, runtimeConfig: GroupRuntimeConfig): void {
    this.db
      .prepare("UPDATE registered_groups SET runtime_config_json = ? WHERE id = ?")
      .run(JSON.stringify(runtimeConfig), groupId);
  }

  public upsertProviderAuth(providerId: string, credential: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
          INSERT INTO provider_auth (provider_id, credential_json, created_at, updated_at)
          VALUES (@providerId, @credentialJson, @createdAt, @updatedAt)
          ON CONFLICT(provider_id) DO UPDATE SET
            credential_json = excluded.credential_json,
            updated_at = excluded.updated_at
        `
      )
      .run({
        providerId,
        credentialJson: JSON.stringify(credential),
        createdAt: now,
        updatedAt: now
      });
  }

  public getProviderAuth(providerId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT * FROM provider_auth WHERE provider_id = ?")
      .get(providerId) as ProviderAuthRow | undefined;
    if (!row) {
      return null;
    }

    return JSON.parse(row.credential_json) as Record<string, unknown>;
  }

  public listProviderAuth(): Array<{ providerId: string; credential: Record<string, unknown> }> {
    const rows = this.db.prepare("SELECT * FROM provider_auth ORDER BY provider_id ASC").all() as ProviderAuthRow[];
    return rows.map((row) => ({
      providerId: row.provider_id,
      credential: JSON.parse(row.credential_json) as Record<string, unknown>
    }));
  }

  public clearProviderAuth(providerId: string): void {
    this.db.prepare("DELETE FROM provider_auth WHERE provider_id = ?").run(providerId);
  }

  public createTask(input: {
    id: string;
    groupId: string;
    kind: string;
    prompt: string;
    status: TaskStatus;
    scheduledJobId?: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO tasks (id, group_id, kind, prompt, status, scheduled_job_id, created_at, updated_at)
          VALUES (@id, @groupId, @kind, @prompt, @status, @scheduledJobId, @createdAt, @createdAt)
        `
      )
      .run({
        ...input,
        scheduledJobId: input.scheduledJobId ?? null
      });
  }

  public updateTaskStatus(taskId: string, status: TaskStatus, sessionId?: string): void {
    this.db
      .prepare(
        `
          UPDATE tasks
          SET status = @status, session_id = COALESCE(@sessionId, session_id), updated_at = @updatedAt
          WHERE id = @taskId
        `
      )
      .run({ taskId, status, sessionId: sessionId ?? null, updatedAt: new Date().toISOString() });
  }

  public listTasks(groupId?: string): Array<{
    id: string;
    groupId: string;
    kind: string;
    prompt: string;
    status: TaskStatus;
    sessionId?: string;
    scheduledJobId?: string;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = groupId
      ? (this.db.prepare("SELECT * FROM tasks WHERE group_id = ? ORDER BY created_at DESC").all(groupId) as Array<Record<string, unknown>>)
      : (this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as Array<Record<string, unknown>>);

    return rows.map((row) => this.mapTaskRow(row));
  }

  public getTask(taskId: string): ReturnType<SqliteStorage["listTasks"]>[number] | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    return this.mapTaskRow(row);
  }

  public upsertRuntimeSession(session: PersistedRuntimeSession): void {
    this.db
      .prepare(
        `
          INSERT INTO runtime_sessions (
            id, runtime_name, group_id, external_session_id, metadata_json, created_at, updated_at
          ) VALUES (
            @id, @runtimeName, @groupId, @externalSessionId, @metadataJson, @createdAt, @updatedAt
          )
          ON CONFLICT(id) DO UPDATE SET
            external_session_id = excluded.external_session_id,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `
      )
      .run({
        id: session.id,
        runtimeName: session.runtimeName,
        groupId: session.groupId,
        externalSessionId: session.externalSessionId ?? null,
        metadataJson: JSON.stringify(session.metadata ?? {}),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt
      });
  }

  public getLatestRuntimeSession(groupId: string, runtimeName: string): PersistedRuntimeSession | null {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM runtime_sessions
          WHERE group_id = ? AND runtime_name = ?
          ORDER BY updated_at DESC
          LIMIT 1
        `
      )
      .get(groupId, runtimeName) as
      | {
          id: string;
          runtime_name: string;
          group_id: string;
          external_session_id: string | null;
          metadata_json: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const session = {
      id: row.id,
      runtimeName: row.runtime_name,
      groupId: row.group_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    } as PersistedRuntimeSession;

    if (row.external_session_id) {
      session.externalSessionId = row.external_session_id;
    }

    session.metadata = row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {};
    return session;
  }

  public appendTranscript(record: TranscriptRecord): void {
    const event = record.event as RuntimeEvent;
    this.db
      .prepare(
        `
          INSERT INTO transcript_events (task_id, group_id, event_type, payload_json, created_at)
          VALUES (@taskId, @groupId, @eventType, @payloadJson, @createdAt)
        `
      )
      .run({
        taskId: record.taskId,
        groupId: record.groupId,
        eventType: event.type,
        payloadJson: JSON.stringify(event),
        createdAt: record.createdAt
      });
  }

  public listTranscriptEvents(taskId: string): RuntimeEvent[] {
    const rows = this.db
      .prepare("SELECT payload_json FROM transcript_events WHERE task_id = ? ORDER BY id ASC")
      .all(taskId) as Array<{ payload_json: string }>;

    return rows.map((row) => JSON.parse(row.payload_json) as RuntimeEvent);
  }

  public createScheduledJob(job: ScheduledJob): void {
    this.db
      .prepare(
        `
          INSERT INTO scheduled_jobs (
            id, group_id, prompt, kind, next_run_at, interval_ms, active, created_at, last_run_at
          ) VALUES (
            @id, @groupId, @prompt, @kind, @nextRunAt, @intervalMs, @active, @createdAt, @lastRunAt
          )
        `
      )
      .run({
        ...job,
        intervalMs: job.intervalMs ?? null,
        active: job.active ? 1 : 0,
        lastRunAt: job.lastRunAt ?? null
      });
  }

  public getDueScheduledJobs(now: string): ScheduledJob[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM scheduled_jobs
          WHERE active = 1 AND next_run_at <= ?
          ORDER BY next_run_at ASC
        `
      )
      .all(now) as JobRow[];

    return rows.map((row) => this.mapJob(row));
  }

  public markScheduledJobRun(jobId: string, nextRunAt: string | null, ranAt: string): void {
    this.db
      .prepare(
        `
          UPDATE scheduled_jobs
          SET next_run_at = COALESCE(@nextRunAt, next_run_at),
              last_run_at = @ranAt,
              active = CASE WHEN @nextRunAt IS NULL THEN 0 ELSE active END
          WHERE id = @jobId
        `
      )
      .run({ jobId, nextRunAt, ranAt });
  }

  public setScheduledJobActive(jobId: string, active: boolean): void {
    this.db.prepare("UPDATE scheduled_jobs SET active = ? WHERE id = ?").run(active ? 1 : 0, jobId);
  }

  public getScheduledJob(jobId: string): ScheduledJob | null {
    const row = this.db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    return row ? this.mapJob(row) : null;
  }

  public listScheduledJobs(groupId?: string): ScheduledJob[] {
    const rows = groupId
      ? (this.db.prepare("SELECT * FROM scheduled_jobs WHERE group_id = ? ORDER BY created_at DESC").all(groupId) as JobRow[])
      : (this.db.prepare("SELECT * FROM scheduled_jobs ORDER BY created_at DESC").all() as JobRow[]);

    return rows.map((row) => this.mapJob(row));
  }

  public appendRemoteControlEvent(event: RemoteControlEvent): void {
    this.db
      .prepare(
        `
          INSERT INTO remote_control_events (id, level, message, details_json, created_at)
          VALUES (@id, @level, @message, @detailsJson, @createdAt)
        `
      )
      .run({
        id: event.id,
        level: event.level,
        message: event.message,
        detailsJson: JSON.stringify(event.details ?? {}),
        createdAt: event.createdAt
      });
  }

  public listRemoteControlEvents(limit = 20): RemoteControlEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM remote_control_events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{
      id: string;
      level: "info" | "warn" | "error";
      message: string;
      details_json: string | null;
      created_at: string;
    }>;

    return rows.map((row) => {
      const event = {
        id: row.id,
        level: row.level,
        message: row.message,
        createdAt: row.created_at
      } as RemoteControlEvent;
      if (row.details_json) {
        event.details = JSON.parse(row.details_json) as Record<string, unknown>;
      }
      return event;
    });
  }

  public close(): void {
    this.db.close();
  }

  private mapRegisteredGroup(row: RegisteredGroupRow): RegisteredGroup {
    const group: RegisteredGroup = {
      id: row.id,
      channel: row.channel,
      externalId: row.external_id,
      folder: row.folder,
      isMain: row.is_main === 1,
      trigger: row.trigger,
      containerConfig: row.container_config_json
        ? (JSON.parse(row.container_config_json) as ContainerConfig)
        : { additionalMounts: [] },
      createdAt: row.created_at
    };
    if (row.runtime_config_json) {
      const runtimeConfig = JSON.parse(row.runtime_config_json) as GroupRuntimeConfig | null;
      if (runtimeConfig) {
        group.runtimeConfig = runtimeConfig;
      }
    }
    return group;
  }

  private mapTaskRow(row: Record<string, unknown>): {
    id: string;
    groupId: string;
    kind: string;
    prompt: string;
    status: TaskStatus;
    sessionId?: string;
    scheduledJobId?: string;
    createdAt: string;
    updatedAt: string;
  } {
    const task = {
      id: row.id as string,
      groupId: row.group_id as string,
      kind: row.kind as string,
      prompt: row.prompt as string,
      status: row.status as TaskStatus,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    } as {
      id: string;
      groupId: string;
      kind: string;
      prompt: string;
      status: TaskStatus;
      sessionId?: string;
      scheduledJobId?: string;
      createdAt: string;
      updatedAt: string;
    };

    if (row.session_id) {
      task.sessionId = row.session_id as string;
    }

    if (row.scheduled_job_id) {
      task.scheduledJobId = row.scheduled_job_id as string;
    }

    return task;
  }

  private mapJob(row: JobRow): ScheduledJob {
    const job = {
      id: row.id,
      groupId: row.group_id,
      prompt: row.prompt,
      kind: row.kind,
      nextRunAt: row.next_run_at,
      active: row.active === 1,
      createdAt: row.created_at
    } as ScheduledJob;

    if (row.interval_ms !== null) {
      job.intervalMs = row.interval_ms;
    }

    if (row.last_run_at) {
      job.lastRunAt = row.last_run_at;
    }

    return job;
  }
}
