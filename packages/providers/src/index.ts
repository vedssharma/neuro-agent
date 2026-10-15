import type { Provider } from "@neuro-agent/core";
import { AnthropicProvider, type AnthropicProviderOptions } from "./anthropic.js";
import { ollamaProvider, OpenAICompatibleProvider } from "./openai.js";

export { ScriptedProvider } from "./mock.js";
export type { Script, ScriptedTurn } from "./mock.js";
export { AnthropicProvider, toAnthropicMessages } from "./anthropic.js";
export type { AnthropicProviderOptions } from "./anthropic.js";
export { ollamaProvider, OpenAICompatibleProvider, toChatMessages } from "./openai.js";
export type { OllamaOptions, OpenAICompatibleOptions } from "./openai.js";
export { sseData } from "./sse.js";

export const PROVIDERS = ["anthropic", "openai", "ollama"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const DEFAULT_MODELS: Record<ProviderName, string | undefined> = {
  anthropic: "claude-opus-5-5",
  openai: undefined,
  ollama: "llama3.1",
};

export interface CreateProviderOptions {
  apiKey?: string;
  baseURL?: string;
  effort?: AnthropicProviderOptions["effort"];
}

/** Builds a provider by name, reading credentials from the environment when not given. */
export function createProvider(name: ProviderName, options: CreateProviderOptions = {}): Provider {
  switch (name) {
    case "anthropic":
      return new AnthropicProvider({
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
        ...(options.effort !== undefined ? { effort: options.effort } : {}),
      });
    case "openai": {
      const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
      return new OpenAICompatibleProvider({
        baseURL: options.baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        ...(apiKey !== undefined ? { apiKey } : {}),
        name: "openai",
      });
    }
    case "ollama":
      return ollamaProvider(options.baseURL !== undefined ? { host: options.baseURL } : {});
  }
}
