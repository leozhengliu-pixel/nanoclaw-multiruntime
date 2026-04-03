import { ProviderAuthService } from "./auth/provider-auth-service.js";
import { getChannelFactory, getRegisteredChannelNames, type Channel } from "./channels/registry.js";
import "./channels/index.js";
import { loadConfig, type AppConfig } from "./config/index.js";
import { ControlPlane } from "./host/control-plane.js";
import { GroupManager } from "./host/group-manager.js";
import { HostQueue } from "./host/host-queue.js";
import { HostService } from "./host/host-service.js";
import { RemoteControlService } from "./remote-control/remote-control.js";
import { ContainerRunner } from "./runner/container-runner.js";
import { RunnerToolHandler } from "./runner/tool-handler.js";
import { Router } from "./router/router.js";
import { CodexRuntime } from "./runtime/codex/codex-runtime.js";
import { TaskScheduler } from "./scheduler/task-scheduler.js";
import { MountSecurity } from "./security/mount-security.js";
import { SqliteStorage } from "./storage/sqlite-storage.js";
import type { AgentRuntime } from "./types/runtime.js";

export interface AppServices {
  config: AppConfig;
  runtime: AgentRuntime;
  storage: SqliteStorage;
  providerAuth: ProviderAuthService;
  groupManager: GroupManager;
  queue: HostQueue;
  host: HostService;
  scheduler: TaskScheduler;
  router: Router;
  remoteControl: RemoteControlService;
  controlPlane: ControlPlane;
  channels: Map<string, Channel>;
  stop: () => Promise<void>;
}

async function connectChannels(router: Router): Promise<Map<string, Channel>> {
  const channels = new Map<string, Channel>();
  for (const name of getRegisteredChannelNames()) {
    const factory = getChannelFactory(name);
    const instance = factory?.({
      onMessage: async (message) => {
        await router.handleInbound(message);
      }
    });

    if (!instance) {
      continue;
    }

    await instance.connect();
    router.registerChannel(instance);
    channels.set(name, instance);
  }

  return channels;
}

export async function createApp(config = loadConfig(), runtime?: AgentRuntime): Promise<AppServices> {
  const storage = new SqliteStorage(config.sqlitePath);
  const providerAuth = new ProviderAuthService(storage, config);
  await providerAuth.importFromCodexHome();
  const groupManager = new GroupManager(config.groupsRoot, config.sessionsRoot, config.logsRoot);
  const queue = new HostQueue(config.maxConcurrency);
  const remoteControl = new RemoteControlService(storage);
  const mountSecurity = new MountSecurity(config.mountAllowlistPath);
  const routerRef: { current?: Router } = {};

  // Force allowlist load on startup so config errors fail fast.
  mountSecurity.validateMounts([]);
  const resolvedRuntime = runtime ?? new CodexRuntime(config.codexBinaryPath, config.runtimeTimeoutMs, providerAuth, config.agentRunnerMode);

  const host = new HostService(resolvedRuntime, storage, groupManager, queue, config.runtimeTimeoutMs);
  const scheduler = new TaskScheduler(storage, host, config.schedulerPollIntervalMs);
  const controlPlane = new ControlPlane(
    storage,
    scheduler,
    { sendToGroup: async (groupId, text) => routerRef.current!.sendToGroup(groupId, text) },
    config.defaultTrigger
  );
  const router = new Router(storage, host, controlPlane, remoteControl, providerAuth);
  routerRef.current = router;

  if (resolvedRuntime instanceof CodexRuntime) {
    resolvedRuntime.attachRunner(new ContainerRunner(config, new RunnerToolHandler(controlPlane, remoteControl)));
  }

  const channels = await connectChannels(router);

  // Seed built-in groups.
  if (!storage.getRegisteredGroupByAddress("local-dev", "local-dev:default")) {
    controlPlane.registerGroup({
      channel: "local-dev",
      externalId: "local-dev:default",
      folder: "local-dev_default"
    });
  }

  if (!storage.getRegisteredGroupByAddress("main-local", "main-local:control")) {
    controlPlane.registerGroup({
      channel: "main-local",
      externalId: "main-local:control",
      folder: "main-local_control",
      isMain: true,
      trigger: config.defaultTrigger
    });
  }

  return {
    config,
    runtime: resolvedRuntime,
      storage,
      providerAuth,
      groupManager,
    queue,
    host,
    scheduler,
    router,
    remoteControl,
    controlPlane,
    channels,
    stop: async () => {
      scheduler.stop();
      await Promise.all([...channels.values()].map((channel) => channel.disconnect()));
      storage.close();
    }
  };
}
