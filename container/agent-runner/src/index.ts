import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { RunnerTaskRequest, RuntimeEventEnvelope, ToolRequestEnvelope, ToolResponseEnvelope } from "../../../src/ipc/protocol.js";
import type { ProviderCredential } from "../../../src/types/runtime.js";

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function appendEvent(eventsFile: string, taskId: string, event: RuntimeEventEnvelope["event"]): Promise<void> {
  const envelope: RuntimeEventEnvelope = { taskId, event };
  await fs.appendFile(eventsFile, `${JSON.stringify(envelope)}\n`);
}

async function requestTool(ipcDir: string, taskId: string, payload: ToolRequestEnvelope["payload"]): Promise<unknown> {
  const id = randomUUID();
  const requestPath = path.join(ipcDir, "tool-requests", `${id}.json`);
  const responsePath = path.join(ipcDir, "tool-responses", `${id}.json`);
  const request: ToolRequestEnvelope = { id, taskId, payload };
  await fs.writeFile(requestPath, JSON.stringify(request, null, 2));

  while (true) {
    const exists = await fs
      .access(responsePath)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      const response = JSON.parse(await fs.readFile(responsePath, "utf8")) as ToolResponseEnvelope;
      if (!response.ok) {
        throw new Error(response.error ?? "Tool request failed");
      }
      return response.result;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runMock(request: RunnerTaskRequest, ipcDir: string, eventsFile: string): Promise<void> {
  const lastMessage = request.messages.at(-1)?.content ?? "";
  const markerPath = path.join(request.workingDirectory, ".nanoclaw-runner-touch");
  await fs.writeFile(markerPath, `task=${request.taskId}\nsession=${request.sessionId}\n`, "utf8");
  await appendEvent(eventsFile, request.taskId, { type: "status", value: "mock-started" });

  if (lastMessage.startsWith("/tool list_tasks")) {
    const result = await requestTool(ipcDir, request.taskId, {
      name: "list_tasks",
      args: { groupId: request.group.id }
    });
    await appendEvent(eventsFile, request.taskId, { type: "tool_result", name: "list_tasks", payload: result });
    await appendEvent(eventsFile, request.taskId, { type: "message", text: JSON.stringify(result) });
  } else {
    await appendEvent(eventsFile, request.taskId, {
      type: "message",
      text: `mock-container:${lastMessage}`
    });
  }

  await appendEvent(eventsFile, request.taskId, { type: "done" });
}

function buildOpenAIEndpoint(request: RunnerTaskRequest): string {
  const baseUrl =
    request.provider === "openai-codex"
      ? process.env.NANOCLAW_OPENAI_CODEX_BASE_URL ?? "https://chatgpt.com/backend-api/codex"
      : process.env.NANOCLAW_OPENAI_API_BASE_URL ?? "https://api.openai.com/v1";
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

function buildAuthHeaders(request: RunnerTaskRequest, credential: ProviderCredential): Headers {
  const headers = new Headers({
    "Content-Type": "application/json"
  });

  if (credential.type === "api-key") {
    headers.set("Authorization", `Bearer ${credential.apiKey}`);
    return headers;
  }

  headers.set("Authorization", `Bearer ${credential.accessToken}`);
  if (credential.accountId && request.provider === "openai-codex") {
    headers.set("ChatGPT-Account-Id", credential.accountId);
  }
  return headers;
}

function buildInput(request: RunnerTaskRequest): Array<Record<string, unknown>> {
  return request.messages.map((message) => ({
    role: message.role,
    content: [{ type: "input_text", text: message.content }]
  }));
}

function extractResponseText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = payload.output;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        continue;
      }

      for (const part of content) {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          texts.push((part as { text: string }).text);
        }
      }
    }

    if (texts.length > 0) {
      return texts.join("\n").trim();
    }
  }

  return "";
}

async function runProviderRequest(request: RunnerTaskRequest, eventsFile: string): Promise<void> {
  if (!request.auth) {
    throw new Error(`Missing auth for ${request.provider}`);
  }

  const endpoint = buildOpenAIEndpoint(request);
  const headers = buildAuthHeaders(request, request.auth);
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: request.modelId,
      input: buildInput(request),
      stream: false
    })
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const errorText =
      typeof payload.error === "string"
        ? payload.error
        : typeof (payload.error as { message?: unknown } | undefined)?.message === "string"
          ? String((payload.error as { message: string }).message)
          : `Provider request failed with ${response.status}`;
    throw new Error(errorText);
  }

  const text = extractResponseText(payload);
  if (text) {
    await appendEvent(eventsFile, request.taskId, { type: "message", text });
  }

  const usage = payload.usage as Record<string, unknown> | undefined;
  await appendEvent(eventsFile, request.taskId, {
    type: "done",
    usage: {
      provider: request.provider,
      modelId: request.modelId,
      finishReason: typeof payload.status === "string" ? payload.status : "completed",
      tokenUsage: usage
        ? {
            inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
            outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
            totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined
          }
        : undefined
    }
  });
}

async function runCodex(request: RunnerTaskRequest, eventsFile: string): Promise<void> {
  if (request.auth) {
    await runProviderRequest(request, eventsFile);
    return;
  }

  const outputPath = path.join(path.dirname(eventsFile), "codex-last-message.txt");
  const sessionStatePath = path.join(request.sessionsPath, `${request.sessionId}.json`);
  const prompt = request.messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n");
  const child = spawn(
    request.codexBinaryPath,
    [
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-a",
      "never",
      "-C",
      request.workingDirectory,
      "-o",
      outputPath,
      prompt
    ],
    {
      cwd: request.workingDirectory,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CODEX_HOME: process.env.CODEX_HOME ?? "/root/.codex",
        HOME: process.env.HOME ?? "/root"
      }
    }
  );

  await appendEvent(eventsFile, request.taskId, { type: "status", value: "codex-started" });
  const stderrChunks: string[] = [];
  let timedOut = false;
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString()));
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, request.runtimeTimeoutMs);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  clearTimeout(timeout);

  await fs.mkdir(request.sessionsPath, { recursive: true });
  await fs.writeFile(
    sessionStatePath,
    JSON.stringify(
      {
        sessionId: request.sessionId,
        taskId: request.taskId,
        exitCode,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    )
  );

  const output = await fs.readFile(outputPath, "utf8").catch(() => "");
  if (output.trim()) {
    await appendEvent(eventsFile, request.taskId, { type: "message", text: output.trim() });
  }

  if (timedOut) {
    await appendEvent(eventsFile, request.taskId, { type: "error", error: "codex execution timed out" });
  } else if (exitCode !== 0 && stderrChunks.length > 0) {
    await appendEvent(eventsFile, request.taskId, { type: "error", error: stderrChunks.join("").trim() });
  }

  await appendEvent(eventsFile, request.taskId, {
    type: "done",
    usage: {
      provider: request.provider,
      modelId: request.modelId,
      exitCode,
      finishReason: exitCode === 0 ? "completed" : "failed"
    }
  });
}

async function main(): Promise<void> {
  const requestPath = getArg("--request");
  const ipcDir = getArg("--ipc-dir");
  if (!requestPath || !ipcDir) {
    throw new Error("Both --request and --ipc-dir are required");
  }

  const request = JSON.parse(await fs.readFile(requestPath, "utf8")) as RunnerTaskRequest;
  const eventsFile = path.join(ipcDir, "events.jsonl");
  const doneFile = path.join(ipcDir, "done.json");

  await fs.mkdir(path.dirname(eventsFile), { recursive: true });
  if (request.mode === "mock" || process.env.NANOCLAW_AGENT_RUNNER_MODE === "mock") {
    await runMock(request, ipcDir, eventsFile);
  } else {
    await runCodex(request, eventsFile);
  }

  await fs.writeFile(doneFile, JSON.stringify({ ok: true }, null, 2));
}

void main();
