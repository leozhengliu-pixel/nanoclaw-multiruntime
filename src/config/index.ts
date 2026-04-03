import path from "node:path";

export type GroupWorkspacePolicy = "group-scoped";
export type SandboxProviderMode = "container" | "local";
export type AgentRunnerMode = "codex" | "mock";
export type ContainerExecutorMode = "engine" | "process";

export interface AppConfig {
  dataRoot: string;
  groupsRoot: string;
  sqlitePath: string;
  sessionsRoot: string;
  ipcRoot: string;
  logsRoot: string;
  maxConcurrency: number;
  schedulerPollIntervalMs: number;
  codexBinaryPath: string;
  runtimeTimeoutMs: number;
  groupWorkspacePolicy: GroupWorkspacePolicy;
  sandboxProvider: SandboxProviderMode;
  containerExecutor: ContainerExecutorMode;
  containerEngineBinary: string;
  containerImage: string;
  containerRunnerEntrypoint: string;
  containerRunnerPathInImage: string;
  agentRunnerMode: AgentRunnerMode;
  assistantName: string;
  defaultTrigger: string;
  mountAllowlistPath: string;
  codexHomePath: string;
  openaiApiBaseUrl: string;
  openaiCodexBaseUrl: string;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseWorkspacePolicy(value: string | undefined): GroupWorkspacePolicy {
  if (!value || value === "group-scoped") {
    return "group-scoped";
  }

  throw new Error(`Unsupported group workspace policy: ${value}`);
}

function parseSandboxProvider(value: string | undefined): SandboxProviderMode {
  if (!value || value === "container") {
    return "container";
  }

  if (value === "local") {
    return "local";
  }

  throw new Error(`Unsupported sandbox provider: ${value}`);
}

function parseAgentRunnerMode(value: string | undefined): AgentRunnerMode {
  if (!value || value === "codex") {
    return "codex";
  }

  if (value === "mock") {
    return "mock";
  }

  throw new Error(`Unsupported agent runner mode: ${value}`);
}

function parseContainerExecutor(value: string | undefined): ContainerExecutorMode {
  if (!value || value === "engine") {
    return "engine";
  }

  if (value === "process") {
    return "process";
  }

  throw new Error(`Unsupported container executor: ${value}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  const dataRoot = path.resolve(cwd, env.NANOCLAW_DATA_ROOT ?? "data");
  const groupsRoot = path.resolve(cwd, env.NANOCLAW_GROUPS_ROOT ?? "groups");
  const sqlitePath = path.resolve(cwd, env.NANOCLAW_SQLITE_PATH ?? path.join("data", "db.sqlite"));
  const sessionsRoot = path.resolve(cwd, env.NANOCLAW_SESSIONS_ROOT ?? path.join("data", "sessions"));
  const ipcRoot = path.resolve(cwd, env.NANOCLAW_IPC_ROOT ?? path.join("data", "ipc"));
  const logsRoot = path.resolve(cwd, env.NANOCLAW_LOGS_ROOT ?? "logs");

  return {
    dataRoot,
    groupsRoot,
    sqlitePath,
    sessionsRoot,
    ipcRoot,
    logsRoot,
    maxConcurrency: parsePositiveInteger(env.NANOCLAW_MAX_CONCURRENCY, 2),
    schedulerPollIntervalMs: parsePositiveInteger(env.NANOCLAW_SCHEDULER_POLL_INTERVAL_MS, 1000),
    codexBinaryPath: env.NANOCLAW_CODEX_BINARY_PATH ?? "codex",
    runtimeTimeoutMs: parsePositiveInteger(env.NANOCLAW_RUNTIME_TIMEOUT_MS, 300_000),
    groupWorkspacePolicy: parseWorkspacePolicy(env.NANOCLAW_GROUP_WORKSPACE_POLICY),
    sandboxProvider: parseSandboxProvider(env.NANOCLAW_SANDBOX_PROVIDER),
    containerExecutor: parseContainerExecutor(env.NANOCLAW_CONTAINER_EXECUTOR),
    containerEngineBinary: env.NANOCLAW_CONTAINER_ENGINE_BINARY ?? "docker",
    containerImage: env.NANOCLAW_CONTAINER_IMAGE ?? "nanoclaw-multiruntime-agent:latest",
    containerRunnerEntrypoint:
      env.NANOCLAW_CONTAINER_RUNNER_ENTRYPOINT ??
      path.resolve(cwd, "container", "agent-runner", "src", "index.ts"),
    containerRunnerPathInImage:
      env.NANOCLAW_CONTAINER_RUNNER_PATH_IN_IMAGE ?? "/app/container/agent-runner/src/index.ts",
    agentRunnerMode: parseAgentRunnerMode(env.NANOCLAW_AGENT_RUNNER_MODE),
    assistantName: env.NANOCLAW_ASSISTANT_NAME ?? "Andy",
    defaultTrigger: env.NANOCLAW_DEFAULT_TRIGGER ?? "@Andy",
    mountAllowlistPath:
      env.NANOCLAW_MOUNT_ALLOWLIST_PATH ??
      path.resolve(cwd, "config-examples", "mount-allowlist.json"),
    codexHomePath: path.resolve(cwd, env.NANOCLAW_CODEX_HOME_PATH ?? path.join("contexts", "codex-home")),
    openaiApiBaseUrl: env.NANOCLAW_OPENAI_API_BASE_URL ?? "https://api.openai.com/v1",
    openaiCodexBaseUrl: env.NANOCLAW_OPENAI_CODEX_BASE_URL ?? "https://chatgpt.com/backend-api/codex"
  };
}
