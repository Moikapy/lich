import { run_with_retries } from "./failover.js";
import { AnthropicProvider } from "./anthropic.js";
import { create_ollama_provider } from "./ollama.js";
import { OpenAICompatProvider } from "./openai.js";
import { ProviderError } from "./types.js";
import type {
  ChatOptions,
  ChatResult,
  LLMProvider,
  Message,
  ProviderConfig,
  ProviderErrorKind,
  ToolDefinition,
} from "./types.js";
import { logger } from "../util/log.js";

const FAILOVER_MAX_ATTEMPTS = 3;

export class ProviderRouter {
  private readonly configs: ProviderConfig[];
  private readonly cache: Map<string, LLMProvider> = new Map();

  constructor(configs: ProviderConfig[]) {
    if (configs.length === 0) {
      throw new Error("at least one provider is required");
    }
    this.configs = [...configs];
  }

  get(name: string): LLMProvider | undefined {
    if (this.cache.has(name) === true) {
      return this.cache.get(name);
    }
    const config = this.find_config(name);
    if (config === undefined) {
      return undefined;
    }
    const provider = build_provider(config);
    this.cache.set(name, provider);
    return provider;
  }

  list(): LLMProvider[] {
    const providers: LLMProvider[] = [];
    for (const config of this.configs) {
      const provider = this.get(config.name);
      if (provider !== undefined) {
        providers.push(provider);
      }
    }
    return providers;
  }

  default_provider(): LLMProvider {
    const [first_config] = this.configs;
    if (first_config === undefined) {
      throw new Error("at least one provider is required");
    }
    const provider = this.get(first_config.name);
    if (provider === undefined) {
      throw new Error(`provider config "${first_config.name}" could not be built`);
    }
    return provider;
  }

  chat_with_failover(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
    options?: ChatOptions,
  ): Promise<ChatResult> {
    return chat_with_failover(this, messages, tools, options);
  }

  private find_config(name: string): ProviderConfig | undefined {
    for (const config of this.configs) {
      if (config.name === name) {
        return config;
      }
    }
    return undefined;
  }
}

function build_provider(config: ProviderConfig): LLMProvider {
  if (config.kind === "anthropic") {
    return new AnthropicProvider(config);
  }
  if (config.kind === "ollama") {
    return create_ollama_provider(config);
  }
  return new OpenAICompatProvider(config);
}

/**
 * Walk providers in config order: auth errors fail over immediately,
 * rate_limit/network get bounded retries on the current provider first,
 * overflow/bad_request fail over immediately. When every provider fails,
 * prefer the first non-transient (hard) error over a later network failure
 * so the root cause is not discarded.
 */
export async function chat_with_failover(
  router: ProviderRouter,
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
  options?: ChatOptions,
): Promise<ChatResult> {
  let last_error: ProviderError | undefined;
  let first_hard_error: ProviderError | undefined;
  for (const provider of router.list()) {
    if (options?.signal?.aborted === true) {
      throw first_hard_error ?? last_error ?? make_router_abort_error();
    }
    const result = await attempt_provider(provider, messages, tools, options);
    if (result.ok === true) {
      return result.value;
    }
    if (is_abort_failure(result.error, options?.signal) === true) {
      throw result.error;
    }
    last_error = result.error;
    if (first_hard_error === undefined && is_hard_error(result.error) === true) {
      first_hard_error = result.error;
    }
    log_fail_over(result.error);
  }
  throw first_hard_error ?? last_error ?? new Error("no providers configured for failover");
}

function is_hard_error(error: ProviderError): boolean {
  return error.kind === "auth" || error.kind === "overflow" || error.kind === "bad_request";
}

function log_fail_over(error: ProviderError): void {
  if (error.kind === "rate_limit" || error.kind === "network") {
    return; // retry delays were already logged via on_retry
  }
  const status_part = error.status !== undefined ? ` status=${error.status}` : "";
  logger.warn(
    `provider "${error.provider_name}" failed with ${error.kind}${status_part}: ${error.message}; failing over to next provider`,
  );
}

function make_router_abort_error(): ProviderError {
  return new ProviderError({
    kind: "unknown",
    provider_name: "router",
    message: "aborted before any provider succeeded",
  });
}

type ProviderAttempt = { ok: true; value: ChatResult } | { ok: false; error: ProviderError };

async function attempt_provider(
  provider: LLMProvider,
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
  options: ChatOptions | undefined,
): Promise<ProviderAttempt> {
  try {
    return {
      ok: true,
      value: await run_with_retries(() => provider.chat(messages, tools, options), {
        max_attempts: FAILOVER_MAX_ATTEMPTS,
        signal: options?.signal,
        on_retry: (kind, attempt, delay_ms) => {
          logger.warn(
            `provider "${provider.name}" ${kind} on attempt ${attempt}; retrying in ${delay_ms}ms`,
          );
        },
      }),
    };
  } catch (error) {
    if (is_abort_failure(error, options?.signal) === true) {
      throw error;
    }
    return { ok: false, error: to_provider_error(error, provider.name) };
  }
}

function is_abort_failure(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

function to_provider_error(error: unknown, fallback_name: string): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  return new ProviderError({
    kind: "unknown",
    provider_name: fallback_name,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}