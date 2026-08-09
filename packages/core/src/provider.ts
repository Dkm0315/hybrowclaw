import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChatMessage, ModelRoute, ProviderConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ChatCompletionRequest {
  readonly provider: ProviderConfig;
  readonly route: ModelRoute;
  readonly messages: ChatMessage[];
  readonly timeoutMs?: number;
}

/** A classified provider failure lets routing distinguish safe rejection from an uncertain dispatched request. */
export class ProviderCompletionError extends Error {
  constructor(message: string, readonly fallbackEligible: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderCompletionError";
  }
}

export async function completeChat(request: ChatCompletionRequest): Promise<string> {
  const { provider, route, messages, timeoutMs } = request;
  if (provider.kind === "codex-cli") {
    return completeWithCodexCli(provider, route, messages, timeoutMs);
  }
  if (provider.kind === "anthropic") {
    return completeWithAnthropic(provider, route, messages, timeoutMs);
  }
  if (provider.kind !== "openai-compatible" && provider.kind !== "openai") {
    throw new ProviderCompletionError(`Provider kind is not implemented in v0: ${provider.kind}`, true);
  }
  const baseUrl = provider.baseUrl ?? "https://api.openai.com/v1";
  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : process.env.OPENAI_API_KEY;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: route.model,
        messages,
        stream: false
      }),
      signal: AbortSignal.timeout(timeoutMs ?? provider.timeoutMs ?? 120_000)
    });
  } catch (error) {
    throw new ProviderCompletionError(
      error instanceof Error ? error.message : String(error),
      false,
      { cause: error },
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ProviderCompletionError(`Provider request failed (${response.status}): ${body.slice(0, 500)}`, true);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return payload.choices?.[0]?.message?.content?.trim() ?? "";
}

async function completeWithAnthropic(
  provider: ProviderConfig,
  route: ModelRoute,
  messages: ChatMessage[],
  timeoutMs?: number,
): Promise<string> {
  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ProviderCompletionError(`Anthropic API key missing. Set ${provider.apiKeyEnv ?? "ANTHROPIC_API_KEY"}, or use --runtime claude-code to reuse your local Claude login.`, true);
  }
  const baseUrl = (provider.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const conversation = messages.filter((message) => message.role !== "system");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: route.model || provider.defaultModel,
        max_tokens: route.maxOutputTokens ?? 4096,
        ...(system ? { system } : {}),
        messages: conversation.map((message) => ({ role: message.role, content: message.content })),
      }),
      signal: AbortSignal.timeout(timeoutMs ?? provider.timeoutMs ?? 120_000),
    });
  } catch (error) {
    throw new ProviderCompletionError(
      error instanceof Error ? error.message : String(error),
      false,
      { cause: error },
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ProviderCompletionError(`Anthropic request failed (${response.status}): ${body.slice(0, 500)}`, true);
  }
  const payload = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  return (payload.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("").trim();
}

async function completeWithCodexCli(provider: ProviderConfig, route: ModelRoute, messages: ChatMessage[], timeoutMs?: number): Promise<string> {
  const prompt = messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n");
  const { stdout } = await execFileAsync("codex", ["-q", "-m", route.model || provider.defaultModel, prompt], {
    timeout: timeoutMs ?? provider.timeoutMs ?? 120_000,
    maxBuffer: 1024 * 1024
  });
  return stdout.trim();
}
