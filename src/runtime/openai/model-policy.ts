import type { ModelRef, ProviderAuthMode, ProviderId } from "../../types/runtime.js";

const OPENAI_CODEX_MODELS = new Set([
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini"
]);

const OPENAI_API_KEY_MODELS = new Set([
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano"
]);

export const DEFAULT_CODEX_MODEL: ModelRef = {
  provider: "openai-codex",
  modelId: "gpt-5.4"
};

export function getDefaultModelRef(): ModelRef {
  return { ...DEFAULT_CODEX_MODEL };
}

export function parseModelRef(value: string): ModelRef | null {
  const [provider, ...rest] = value.trim().split("/");
  const modelId = rest.join("/").trim();
  if ((provider !== "openai" && provider !== "openai-codex") || !modelId) {
    return null;
  }

  return {
    provider,
    modelId
  };
}

export function supportsModelForAuthMode(model: ModelRef, authMode: ProviderAuthMode): boolean {
  if (authMode === "oauth") {
    return model.provider === "openai-codex" && OPENAI_CODEX_MODELS.has(model.modelId);
  }

  return model.provider === "openai" && OPENAI_API_KEY_MODELS.has(model.modelId);
}

export function getAllowedModels(provider: ProviderId, authMode: ProviderAuthMode): string[] {
  if (provider === "openai-codex" && authMode === "oauth") {
    return [...OPENAI_CODEX_MODELS].sort();
  }

  if (provider === "openai" && authMode === "api-key") {
    return [...OPENAI_API_KEY_MODELS].sort();
  }

  return [];
}
