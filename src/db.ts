import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from "./config.js";
import { isValidGroupFolder } from "./group-folder.js";
import { logger } from "./logger.js";
import type { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from "./types.js";

let db: Database.Database;
let currentDbPath: string | null = null;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      reply_to_message_id TEXT,
      reply_to_message_content TEXT,
      reply_to_sender_name TEXT,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      script TEXT,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);
    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      runtime_config TEXT
    );
    CREATE TABLE IF NOT EXISTS provider_auth (
      provider_id TEXT PRIMARY KEY,
      credential_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS execution_tasks (
      id TEXT PRIMARY KEY,
      group_jid TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      session_id TEXT,
      scheduled_task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transcript_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_control_events (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`);
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`);
    database.prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`).run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`);
    database.exec(`UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`);
  } catch {
    /* column already exists */
  }

  // Add runtime_config column if it doesn't exist (Codex-specific migration)
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN runtime_config TEXT`);
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`);
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`);
    database.exec(`UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`);
    database.exec(`UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`);
  } catch {
    /* columns already exist */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`);
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(dbPathOverride?: string): void {
  const dbPath = dbPathOverride ? path.resolve(dbPathOverride) : path.join(STORE_DIR, "messages.db");
  if (db && currentDbPath === dbPath) {
    return;
  }
  if (db) {
    db.close();
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  currentDbPath = dbPath;
  createSchema(db);
  migrateJsonState();
}

export function _initTestDatabase(): void {
  db = new Database(":memory:");
  currentDbPath = ":memory:";
  createSchema(db);
}

export function _closeDatabase(): void {
  db.close();
  currentDbPath = null;
}

export function storeChatMetadata(chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;
  if (name) {
    db.prepare(`
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `).run(chatJid, name, timestamp, ch, group);
  } else {
    db.prepare(`
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `).run(chatJid, chatJid, timestamp, ch, group);
  }
}

export function updateChatName(chatJid: string, name: string): void {
  db.prepare(`
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

export function getAllChats(): ChatInfo[] {
  return db.prepare(`
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `).all() as ChatInfo[];
}

export function getLastGroupSync(): string | null {
  const row = db.prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`).get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`).run(now);
}

export function storeMessage(msg: NewMessage): void {
  db.prepare(`
    INSERT OR REPLACE INTO messages (
      id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message,
      reply_to_message_id, reply_to_message_content, reply_to_sender_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0
  );
}

export function getNewMessages(jids: string[], lastTimestamp: string, botPrefix: string, limit = 200): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };
  const placeholders = jids.map(() => "?").join(",");
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const rows = db.prepare(sql).all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];
  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }
  return { messages: rows, newTimestamp };
}

export function getMessagesSince(chatJid: string, sinceTimestamp: string, botPrefix: string, limit = 200): NewMessage[] {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function getChatHistory(chatJid: string, limit = 100): NewMessage[] {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ?
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid, limit) as NewMessage[];
}

export function getLastBotMessageTimestamp(chatJid: string, botPrefix: string): string | undefined {
  const row = db
    .prepare(`SELECT MAX(timestamp) as ts FROM messages WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`)
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function createTask(task: Omit<ScheduledTask, "last_run" | "last_result">): void {
  db.prepare(`
    INSERT INTO scheduled_tasks (
      id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || "isolated",
    task.next_run,
    task.status,
    task.created_at
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as ScheduledTask | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db.prepare("SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC").all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db.prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC").all() as ScheduledTask[];
}

export interface ExecutionTaskRecord {
  id: string;
  groupJid: string;
  kind: "message" | "scheduled";
  prompt: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "paused";
  sessionId?: string;
  scheduledTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export function createExecutionTask(task: Omit<ExecutionTaskRecord, "updatedAt">): void {
  db.prepare(`
    INSERT INTO execution_tasks (
      id, group_jid, kind, prompt, status, session_id, scheduled_task_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.groupJid,
    task.kind,
    task.prompt,
    task.status,
    task.sessionId ?? null,
    task.scheduledTaskId ?? null,
    task.createdAt,
    task.createdAt
  );
}

export function updateExecutionTask(
  id: string,
  updates: Partial<Pick<ExecutionTaskRecord, "status" | "sessionId">>
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (updates.sessionId !== undefined) {
    fields.push("session_id = ?");
    values.push(updates.sessionId ?? null);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE execution_tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function listExecutionTasks(groupJid?: string): ExecutionTaskRecord[] {
  const rows = groupJid
    ? (db
        .prepare("SELECT * FROM execution_tasks WHERE group_jid = ? ORDER BY created_at DESC")
        .all(groupJid) as Array<Record<string, unknown>>)
    : (db.prepare("SELECT * FROM execution_tasks ORDER BY created_at DESC").all() as Array<Record<string, unknown>>);
  return rows.map(mapExecutionTaskRecord);
}

export function getExecutionTask(id: string): ExecutionTaskRecord | undefined {
  const row = db.prepare("SELECT * FROM execution_tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapExecutionTaskRecord(row) : undefined;
}

export function updateTask(id: string, updates: Partial<Pick<ScheduledTask, "prompt" | "script" | "schedule_type" | "schedule_value" | "next_run" | "status">>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.prompt !== undefined) {
    fields.push("prompt = ?");
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push("script = ?");
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push("schedule_type = ?");
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push("schedule_value = ?");
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push("next_run = ?");
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteTask(id: string): void {
  db.prepare("DELETE FROM task_run_logs WHERE task_id = ?").run(id);
  db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `).all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(log.task_id, log.run_at, log.duration_ms, log.status, log.result, log.error);
}

export function getRouterState(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM router_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)").run(key, value);
}

export function getSession(groupFolder: string): string | undefined {
  const row = db.prepare("SELECT session_id FROM sessions WHERE group_folder = ?").get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare("INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)").run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare("DELETE FROM sessions WHERE group_folder = ?").run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db.prepare("SELECT group_folder, session_id FROM sessions").all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[row.group_folder] = row.session_id;
  return result;
}

export function getRegisteredGroup(jid: string): (RegisteredGroup & { jid: string }) | undefined {
  const row = db.prepare("SELECT * FROM registered_groups WHERE jid = ?").get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        runtime_config: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn({ jid, folder: row.folder }, "Invalid stored group folder");
    return undefined;
  }
  const group: RegisteredGroup & { jid: string } = {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    requiresTrigger: row.requires_trigger !== 0,
    isMain: row.is_main === 1
  };
  if (row.container_config) {
    const containerConfig = JSON.parse(row.container_config) as RegisteredGroup["containerConfig"];
    if (containerConfig) {
      group.containerConfig = containerConfig;
    }
  }
  if (row.runtime_config) {
    const runtimeConfig = JSON.parse(row.runtime_config) as RegisteredGroup["runtimeConfig"];
    if (runtimeConfig) {
      group.runtimeConfig = runtimeConfig;
    }
  }
  return group;
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  db.prepare(`
    INSERT OR REPLACE INTO registered_groups (
      jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, runtime_config
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === false ? 0 : 1,
    group.isMain ? 1 : 0,
    group.runtimeConfig ? JSON.stringify(group.runtimeConfig) : null
  );
}

export function updateRegisteredGroupRuntime(jid: string, runtimeConfig: RegisteredGroup["runtimeConfig"]): void {
  const existing = getRegisteredGroup(jid);
  if (!existing) {
    throw new Error(`Unknown group: ${jid}`);
  }
  setRegisteredGroup(jid, {
    ...existing,
    ...(runtimeConfig ? { runtimeConfig } : {})
  });
}

export function updateRegisteredGroupMounts(jid: string, containerConfig: RegisteredGroup["containerConfig"]): void {
  const existing = getRegisteredGroup(jid);
  if (!existing) {
    throw new Error(`Unknown group: ${jid}`);
  }
  setRegisteredGroup(jid, {
    ...existing,
    ...(containerConfig ? { containerConfig } : {})
  });
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare("SELECT jid FROM registered_groups").all() as Array<{ jid: string }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    const group = getRegisteredGroup(row.jid);
    if (group) result[row.jid] = group;
  }
  return result;
}

export function upsertProviderAuth(providerId: string, credential: Record<string, unknown>): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO provider_auth (provider_id, credential_json, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(provider_id) DO UPDATE SET
      credential_json = excluded.credential_json,
      updated_at = excluded.updated_at
  `).run(providerId, JSON.stringify(credential), now, now);
}

export function getProviderAuth(providerId: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT credential_json FROM provider_auth WHERE provider_id = ?").get(providerId) as { credential_json: string } | undefined;
  return row ? (JSON.parse(row.credential_json) as Record<string, unknown>) : null;
}

export function listProviderAuth(): Array<{ providerId: string; credential: Record<string, unknown> }> {
  const rows = db
    .prepare("SELECT provider_id, credential_json FROM provider_auth ORDER BY provider_id ASC")
    .all() as Array<{ provider_id: string; credential_json: string }>;
  return rows.map((row) => ({
    providerId: row.provider_id,
    credential: JSON.parse(row.credential_json) as Record<string, unknown>
  }));
}

export function clearProviderAuth(providerId: string): void {
  db.prepare("DELETE FROM provider_auth WHERE provider_id = ?").run(providerId);
}

export interface RemoteControlEventRecord {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export function appendRemoteControlEvent(event: RemoteControlEventRecord): void {
  db.prepare(`
    INSERT INTO remote_control_events (id, level, message, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(event.id, event.level, event.message, JSON.stringify(event.details ?? {}), event.createdAt);
}

export function listRemoteControlEvents(limit = 20): RemoteControlEventRecord[] {
  const rows = db
    .prepare("SELECT * FROM remote_control_events ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Array<{
      id: string;
      level: "info" | "warn" | "error";
      message: string;
      details_json: string | null;
      created_at: string;
    }>;
  return rows.map((row) => ({
    id: row.id,
    level: row.level,
    message: row.message,
    createdAt: row.created_at,
    ...(row.details_json ? { details: JSON.parse(row.details_json) as Record<string, unknown> } : {})
  }));
}

export function appendTranscriptEvent(taskId: string, groupFolder: string, payload: Record<string, unknown>): void {
  db.prepare(`
    INSERT INTO transcript_events (task_id, group_folder, payload_json, created_at)
    VALUES (?, ?, ?, ?)
  `).run(taskId, groupFolder, JSON.stringify(payload), new Date().toISOString());
}

function mapExecutionTaskRecord(row: Record<string, unknown>): ExecutionTaskRecord {
  return {
    id: String(row.id),
    groupJid: String(row.group_jid),
    kind: row.kind === "scheduled" ? "scheduled" : "message",
    prompt: String(row.prompt),
    status:
      row.status === "running" ||
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "cancelled" ||
      row.status === "paused"
        ? (row.status as ExecutionTaskRecord["status"])
        : "queued",
    ...(typeof row.session_id === "string" && row.session_id ? { sessionId: row.session_id } : {}),
    ...(typeof row.scheduled_task_id === "string" && row.scheduled_task_id ? { scheduledTaskId: row.scheduled_task_id } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  const routerState = migrateFile("router_state.json") as
    | {
        last_timestamp?: string;
        last_agent_timestamp?: Record<string, string>;
      }
    | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState("last_timestamp", routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState("last_agent_timestamp", JSON.stringify(routerState.last_agent_timestamp));
    }
  }

  const sessions = migrateFile("sessions.json") as Record<string, string> | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  const groups = migrateFile("registered_groups.json") as Record<string, RegisteredGroup> | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn({ jid, folder: group.folder, err }, "Skipping migrated registered group with invalid folder");
      }
    }
  }
}
