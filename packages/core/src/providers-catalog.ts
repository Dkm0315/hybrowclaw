import type { ProviderConfig, ProviderKind } from "./types.js";

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderKind;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
  readonly defaultModel: string;
  readonly category: "cloud" | "local" | "cli" | "aggregator";
  readonly notes?: string;
}

/**
 * Provider presets so no API or AI provider is ever a bottleneck. Anything
 * speaking the OpenAI-compatible chat protocol works out of the box; CLI
 * runtimes (Claude Code, Codex, Pi) and self-hosted servers are first-class too.
 * Add any unlisted provider with: provider add-openai-compatible <id> <base-url> <model>.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // Cloud, native protocols
  { id: "openai", label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", defaultModel: "gpt-5.6", category: "cloud" },
  { id: "anthropic", label: "Anthropic Claude (API)", kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-fable-5", category: "cloud", notes: "Fable 5: 1M context, adaptive thinking via effort param." },
  // Cloud, OpenAI-compatible
  { id: "xai", label: "xAI Grok", kind: "openai-compatible", baseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY", defaultModel: "grok-4", category: "cloud" },
  { id: "kimi", label: "Moonshot Kimi", kind: "openai-compatible", baseUrl: "https://api.moonshot.ai/v1", apiKeyEnv: "MOONSHOT_API_KEY", defaultModel: "kimi-k2-0905-preview", category: "cloud" },
  { id: "deepseek", label: "DeepSeek", kind: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat", category: "cloud" },
  { id: "mistral", label: "Mistral", kind: "openai-compatible", baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY", defaultModel: "mistral-large-latest", category: "cloud" },
  { id: "gemini", label: "Google Gemini (OpenAI-compatible endpoint)", kind: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKeyEnv: "GEMINI_API_KEY", defaultModel: "gemini-2.5-pro", category: "cloud" },
  { id: "qwen", label: "Alibaba Qwen (DashScope)", kind: "openai-compatible", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", apiKeyEnv: "DASHSCOPE_API_KEY", defaultModel: "qwen-max", category: "cloud" },
  { id: "zhipu", label: "Zhipu GLM", kind: "openai-compatible", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKeyEnv: "ZHIPU_API_KEY", defaultModel: "glm-4.6", category: "cloud" },
  { id: "perplexity", label: "Perplexity", kind: "openai-compatible", baseUrl: "https://api.perplexity.ai", apiKeyEnv: "PERPLEXITY_API_KEY", defaultModel: "sonar-pro", category: "cloud" },
  // Fast-inference clouds
  { id: "groq", label: "Groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile", category: "cloud" },
  { id: "cerebras", label: "Cerebras", kind: "openai-compatible", baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY", defaultModel: "llama-3.3-70b", category: "cloud" },
  // Aggregators (one key, hundreds of models)
  { id: "openrouter", label: "OpenRouter (aggregator)", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", defaultModel: "anthropic/claude-sonnet-4.6", category: "aggregator" },
  { id: "together", label: "Together AI", kind: "openai-compatible", baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo", category: "aggregator" },
  { id: "fireworks", label: "Fireworks AI", kind: "openai-compatible", baseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY", defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct", category: "aggregator" },
  // Local / self-hosted (open source, air-gap friendly)
  { id: "lmstudio", label: "LM Studio (local)", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", defaultModel: "local-model", category: "local", notes: "No API key. Start the LM Studio server first." },
  { id: "vllm", label: "vLLM (self-hosted)", kind: "openai-compatible", baseUrl: "http://localhost:8000/v1", defaultModel: "served-model", category: "local", notes: "Point --base-url at your vLLM server." },
  { id: "sglang", label: "SGLang (self-hosted)", kind: "openai-compatible", baseUrl: "http://localhost:30000/v1", defaultModel: "served-model", category: "local", notes: "Point --base-url at your SGLang server." },
  // CLI-auth runtimes (subscription auth, no raw API key needed)
  { id: "codex-cli", label: "OpenAI Codex CLI (subscription auth)", kind: "codex-cli", defaultModel: "gpt-5.6-sol", category: "cli", notes: "Uses your local `codex` login; gpt-5.5 remains selectable for profiles pinned to it." },
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function presetToProviderConfig(
  preset: ProviderPreset,
  overrides: { model?: string; baseUrl?: string; apiKeyEnv?: string } = {},
): ProviderConfig {
  return {
    id: preset.id,
    kind: preset.kind,
    baseUrl: overrides.baseUrl ?? preset.baseUrl,
    apiKeyEnv: overrides.apiKeyEnv ?? preset.apiKeyEnv,
    defaultModel: overrides.model ?? preset.defaultModel,
  };
}

export function renderProviderPresets(): string {
  const lines: string[] = [];
  const categories: Array<[ProviderPreset["category"], string]> = [
    ["cloud", "Cloud providers"],
    ["aggregator", "Aggregators (one key, many models)"],
    ["local", "Local / self-hosted (open source, air-gap friendly)"],
    ["cli", "CLI-auth runtimes"],
  ];
  for (const [category, title] of categories) {
    lines.push(title + ":");
    for (const preset of PROVIDER_PRESETS.filter((entry) => entry.category === category)) {
      const key = preset.apiKeyEnv ? `key=${preset.apiKeyEnv}` : "no key";
      lines.push(`  ${preset.id.padEnd(12)} ${preset.label.padEnd(44)} ${key.padEnd(24)} default=${preset.defaultModel}`);
      if (preset.notes) lines.push(`  ${"".padEnd(12)} ${preset.notes}`);
    }
    lines.push("");
  }
  lines.push("Also available without presets:");
  lines.push("  any OpenAI-compatible endpoint:  provider add-openai-compatible <id> <base-url> <model> [--api-key-env VAR]");
  lines.push("  Claude Code CLI runtime:         muster run \"...\" --runtime claude-code (uses your local `claude` login)");
  lines.push("  Pi-managed providers:            muster run \"...\" --runtime pi --provider anthropic (uses Pi auth)");
  return lines.join("\n");
}
