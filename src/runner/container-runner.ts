import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import type { AppConfig } from "../config/index.js";
import type { ToolResponseEnvelope, RunnerTaskRequest, ToolRequestEnvelope, RuntimeEventEnvelope } from "../ipc/protocol.js";
import type { RuntimeEvent } from "../types/runtime.js";

export interface ContainerRunnerToolHandler {
  handleToolRequest(request: ToolRequestEnvelope): Promise<ToolResponseEnvelope>;
}

interface SpawnedRun {
  containerName?: string;
  child: ChildProcess;
}

export class ContainerRunner {
  private readonly activeRuns = new Map<string, SpawnedRun>();

  public constructor(
    private readonly config: AppConfig,
    private readonly toolHandler: ContainerRunnerToolHandler
  ) {}

  public async *run(request: RunnerTaskRequest): AsyncIterable<RuntimeEvent> {
    const runId = `${request.taskId}-${randomUUID()}`;
    const runDir = path.join(this.config.ipcRoot, runId);
    const requestFile = path.join(runDir, "request.json");
    const eventsFile = path.join(runDir, "events.jsonl");
    const toolRequestsDir = path.join(runDir, "tool-requests");
    const toolResponsesDir = path.join(runDir, "tool-responses");
    const doneFile = path.join(runDir, "done.json");

    await Promise.all([
      fs.mkdir(toolRequestsDir, { recursive: true }),
      fs.mkdir(toolResponsesDir, { recursive: true })
    ]);

    const child =
      this.config.containerExecutor === "engine"
        ? await this.spawnContainerizedRun(request, runDir, requestFile)
        : await this.spawnProcessRun(request, requestFile, runDir);
    this.activeRuns.set(request.taskId, child);
    this.activeRuns.set(request.sessionId, child);

    const seenToolRequests = new Set<string>();
    let lastOffset = 0;
    let done = false;
    let childExitCode: number | null = null;
    const stderrChunks: string[] = [];

    child.child.stdout?.on("data", () => undefined);
    child.child.stderr?.on("data", (chunk) => {
      stderrChunks.push(chunk.toString());
    });
    child.child?.on("close", (code) => {
      childExitCode = code;
    });

    while (!done && childExitCode === null) {
      const eventsContent = await fs.readFile(eventsFile, "utf8").catch(() => "");
      if (eventsContent.length > lastOffset) {
        const slice = eventsContent.slice(lastOffset);
        lastOffset = eventsContent.length;
        const lines = slice.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          const envelope = JSON.parse(line) as RuntimeEventEnvelope;
          yield envelope.event;
        }
      }

      const requestFiles = await fs.readdir(toolRequestsDir).catch(() => []);
      for (const file of requestFiles) {
        if (seenToolRequests.has(file)) {
          continue;
        }

        seenToolRequests.add(file);
        const requestPath = path.join(toolRequestsDir, file);
        const payload = JSON.parse(await fs.readFile(requestPath, "utf8")) as ToolRequestEnvelope;
        const response = await this.toolHandler.handleToolRequest(payload);
        await fs.writeFile(path.join(toolResponsesDir, `${payload.id}.json`), JSON.stringify(response, null, 2));
      }

      done = await fs
        .access(doneFile)
        .then(() => true)
        .catch(() => false);

      if (!done) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    if (childExitCode !== null && !done) {
      const stderr = stderrChunks.join("").trim();
      yield {
        type: "error",
        error: stderr || `Agent runner exited unexpectedly with code ${childExitCode}`
      };
      yield { type: "done", usage: { exitCode: childExitCode } };
    }

    if (childExitCode === null) {
      await new Promise<void>((resolve, reject) => {
        child.child?.on("error", reject);
        child.child?.on("close", () => resolve());
      });
    }

    this.activeRuns.delete(request.taskId);
    this.activeRuns.delete(request.sessionId);
    if (child.containerName) {
      await this.removeContainer(child.containerName).catch(() => undefined);
    }
  }

  public async cancel(taskId: string): Promise<void> {
    const active = this.activeRuns.get(taskId);
    if (!active) {
      return;
    }

    active.child?.kill("SIGTERM");
    if (active.containerName) {
      await this.removeContainer(active.containerName).catch(() => undefined);
    }
  }

  private async spawnProcessRun(request: RunnerTaskRequest, requestFile: string, runDir: string): Promise<SpawnedRun> {
    await fs.writeFile(requestFile, JSON.stringify(request, null, 2));

    const child = spawn(
      process.execPath,
      ["--import", "tsx", this.config.containerRunnerEntrypoint, "--request", requestFile, "--ipc-dir", runDir],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NANOCLAW_AGENT_RUNNER_MODE: this.config.agentRunnerMode,
          NANOCLAW_OPENAI_API_BASE_URL: this.config.openaiApiBaseUrl,
          NANOCLAW_OPENAI_CODEX_BASE_URL: this.config.openaiCodexBaseUrl
        }
      }
    );

    return { child };
  }

  private async spawnContainerizedRun(
    request: RunnerTaskRequest,
    runDir: string,
    requestFile: string
  ): Promise<SpawnedRun> {
    const containerName = this.buildContainerName(request);
    const containerRequest = this.buildContainerRequest(request);

    await fs.writeFile(requestFile, JSON.stringify(containerRequest, null, 2));
    await this.startContainer(containerName, request, runDir);

    const child = spawn(
      this.config.containerEngineBinary,
      [
        "exec",
        "-i",
        "-w",
        "/app",
        containerName,
        "node",
        "--import",
        "tsx",
        this.config.containerRunnerPathInImage,
        "--request",
        "/ipc/request.json",
        "--ipc-dir",
        "/ipc"
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    return { containerName, child };
  }

  private buildContainerName(request: RunnerTaskRequest): string {
    const groupSlug = request.group.folder.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 32) || "group";
    return `nanoclaw-${groupSlug}-${randomUUID().slice(0, 8)}`;
  }

  private buildContainerRequest(request: RunnerTaskRequest): RunnerTaskRequest {
    return {
      ...request,
      workingDirectory: "/workspace",
      globalMemoryFile: "/memory/global/CLAUDE.md",
      groupMemoryFile: "/memory/group/CLAUDE.md",
      sessionsPath: "/sessions"
    };
  }

  private async startContainer(containerName: string, request: RunnerTaskRequest, runDir: string): Promise<void> {
    const mountArgs = await this.buildMountArgs(request, runDir);
    const args = [
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "--workdir",
      "/workspace",
      "-e",
      `CODEX_HOME=/root/.codex`,
      "-e",
      `HOME=/root`,
      "-e",
      `NANOCLAW_AGENT_RUNNER_MODE=${request.mode}`,
      "-e",
      `NANOCLAW_OPENAI_API_BASE_URL=${this.config.openaiApiBaseUrl}`,
      "-e",
      `NANOCLAW_OPENAI_CODEX_BASE_URL=${this.config.openaiCodexBaseUrl}`,
      ...mountArgs,
      this.config.containerImage,
      "sleep",
      "infinity"
    ];

    await this.runEngineCommand(args);
  }

  private async buildMountArgs(request: RunnerTaskRequest, runDir: string): Promise<string[]> {
    const args = [
      ...this.toMountArgs(runDir, "/ipc", false),
      ...this.toMountArgs(request.workingDirectory, "/workspace", false),
      ...this.toMountArgs(request.sessionsPath, "/sessions", false),
      ...this.toMountArgs(request.globalMemoryFile, "/memory/global/CLAUDE.md", false),
      ...this.toMountArgs(request.groupMemoryFile, "/memory/group/CLAUDE.md", false)
    ];

    const codexHomeExists = await fs
      .access(this.config.codexHomePath)
      .then(() => true)
      .catch(() => false);
    if (codexHomeExists) {
      args.push(...this.toMountArgs(this.config.codexHomePath, "/root/.codex", false));
    }

    for (const mount of request.containerConfig.additionalMounts) {
      args.push(...this.toMountArgs(path.resolve(mount.hostPath), mount.containerPath, mount.readonly));
    }

    return args;
  }

  private toMountArgs(hostPath: string, containerPath: string, readonly: boolean): string[] {
    const mountSpec = [`type=bind`, `src=${path.resolve(hostPath)}`, `dst=${containerPath}`];
    if (readonly) {
      mountSpec.push("readonly");
    }

    return ["--mount", mountSpec.join(",")];
  }

  private async runEngineCommand(args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.config.containerEngineBinary, args, {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stderr: string[] = [];
      child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderr.join("").trim() || `${this.config.containerEngineBinary} ${args[0]} failed with exit code ${code}`));
      });
    });
  }

  private async removeContainer(containerName: string): Promise<void> {
    await this.runEngineCommand(["rm", "-f", containerName]);
  }
}
