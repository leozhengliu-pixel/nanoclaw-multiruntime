import type { ProviderAuthService } from "../auth/provider-auth-service.js";
import type { Channel } from "../channels/registry.js";
import type { ControlPlane } from "../host/control-plane.js";
import type { HostService } from "../host/host-service.js";
import type { RemoteControlService } from "../remote-control/remote-control.js";
import { parseModelRef } from "../runtime/openai/model-policy.js";
import type { SqliteStorage } from "../storage/sqlite-storage.js";
import type { InboundMessage, RegisteredGroup, TaskExecutionResult } from "../types/host.js";

export class Router {
  private readonly channels = new Map<string, Channel>();

  public constructor(
    private readonly storage: SqliteStorage,
    private readonly host: HostService,
    private readonly controlPlane: ControlPlane,
    private readonly remoteControl: RemoteControlService,
    private readonly providerAuth: ProviderAuthService
  ) {}

  public registerChannel(channel: Channel): void {
    this.channels.set(channel.name, channel);
  }

  public async handleInbound(message: InboundMessage): Promise<TaskExecutionResult | null> {
    const group = this.storage.getRegisteredGroupByAddress(message.channel, message.externalId);
    if (!group) {
      this.remoteControl.record("warn", "Ignoring message from unregistered group", {
        channel: message.channel,
        externalId: message.externalId
      });
      return null;
    }

    if (group.isMain && message.text.startsWith("/")) {
      await this.handleMainCommand(group, message.text);
      return null;
    }

    const normalized = this.normalizeTriggeredText(group, message.text);
    if (!normalized) {
      return null;
    }

    const result = await this.host.handleInboundMessage({
      ...message,
      text: normalized
    });

    const finalMessage = [...result.events].reverse().find((event) => event.type === "message");
    if (finalMessage && finalMessage.type === "message") {
      await this.sendToGroup(group.id, finalMessage.text);
    }

    return result;
  }

  public async sendToGroup(groupId: string, text: string): Promise<void> {
    const group = this.storage.getRegisteredGroup(groupId);
    if (!group) {
      throw new Error(`Unknown group: ${groupId}`);
    }

    const channel = this.channels.get(group.channel);
    if (!channel) {
      throw new Error(`No channel registered for ${group.channel}`);
    }

    await channel.sendMessage(group.externalId, text);
  }

  private normalizeTriggeredText(group: RegisteredGroup, text: string): string | null {
    const trimmed = text.trim();
    const trigger = group.trigger.trim();
    if (group.isMain) {
      return trimmed;
    }

    if (!trimmed.toLowerCase().startsWith(trigger.toLowerCase())) {
      return null;
    }

    return trimmed.slice(trigger.length).trim() || trimmed;
  }

  private async handleMainCommand(group: RegisteredGroup, text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "/list-groups") {
      const groups = this.controlPlane.listGroups();
      await this.sendToGroup(group.id, groups.map((item) => `${item.channel}:${item.externalId} -> ${item.folder}`).join("\n"));
      return;
    }

    if (trimmed === "/remote-status") {
      const status = this.remoteControl.status();
      const message = status.recentEvents.map((event) => `[${event.level}] ${event.message}`).join("\n") || "No events";
      await this.sendToGroup(group.id, message);
      return;
    }

    if (trimmed === "/auth-status") {
      const rows = this.providerAuth.status();
      const message =
        rows.length === 0
          ? "No provider auth configured"
          : rows
              .map((row) =>
                row.authMode === "oauth"
                  ? `${row.provider}: oauth expires=${new Date(row.expiresAt ?? 0).toISOString()} account=${row.accountId ?? "n/a"}`
                  : `${row.provider}: api-key`
              )
              .join("\n");
      await this.sendToGroup(group.id, message);
      return;
    }

    if (trimmed.startsWith("/register-group ")) {
      const [, channel, externalId, folder] = trimmed.split(/\s+/, 4);
      if (!channel || !externalId || !folder) {
        await this.sendToGroup(group.id, "Usage: /register-group <channel> <externalId> <folder>");
        return;
      }

      const registered = this.controlPlane.registerGroup({
        channel,
        externalId,
        folder
      });
      this.remoteControl.record("info", "Registered group via main-local command", {
        groupId: registered.id
      });
      await this.sendToGroup(group.id, `Registered ${registered.channel}:${registered.externalId} as ${registered.folder}`);
      return;
    }

    if (trimmed.startsWith("/set-model ")) {
      const [, groupId, modelText] = trimmed.split(/\s+/, 3);
      const model = modelText ? parseModelRef(modelText) : null;
      if (!groupId || !model) {
        await this.sendToGroup(group.id, "Usage: /set-model <groupId> <openai|openai-codex/model>");
        return;
      }

      this.controlPlane.updateGroupRuntime(groupId, model);
      await this.sendToGroup(group.id, `Updated ${groupId} model to ${model.provider}/${model.modelId}`);
      return;
    }

    if (trimmed.startsWith("/get-model ")) {
      const [, groupId] = trimmed.split(/\s+/, 2);
      const registered = groupId ? this.storage.getRegisteredGroup(groupId) : null;
      if (!registered) {
        await this.sendToGroup(group.id, "Unknown group");
        return;
      }

      const current = registered.runtimeConfig;
      await this.sendToGroup(
        group.id,
        current ? `${registered.id}: ${current.provider}/${current.modelId}` : `${registered.id}: default model`
      );
      return;
    }

    await this.sendToGroup(group.id, `Unknown main command: ${trimmed}`);
  }
}
