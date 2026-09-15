# Library guide

> What you'll learn: how to install the package and embed the `Agent` class in TypeScript — basic runs, event subscription, multi-turn history, config, tool filtering, error handling, and session access.

## Install

From a checkout of this repository (or a published tarball):

```sh
npm install /path/to/lich-0.2.0.tgz    # after `npm run build` in the lich repo
# or point package.json at the git repo
npm install git+ssh://example.com/you/lich.git
```

The package ships ESM (`dist/index.js`, types at `dist/index.d.ts`, binary at `dist/cli.js`); `main`/`types`/`bin` are wired in `package.json`.

## Minimal example

`create_agent(raw_config)` validates the config (zod, defaults applied, frozen result) and returns an `Agent` with a `.run()` loop:

```ts
import { create_agent } from "lich";

const agent = create_agent({
  providers: [{ kind: "ollama", name: "local", model: "llama3.2:latest" }],
});

const result = await agent.run({ input: "Use list_dir to list the files, then summarize." });
console.log(result.outcome.final?.content);
console.log(`tokens: ${result.usage_total.total_tokens}`);
```

The one-liner `run_agent(config, input)` is equivalent when you only need a single run:

```ts
import { run_agent } from "lich";

const result = await run_agent(
  { providers: [{ kind: "ollama", name: "local", model: "llama3.2:latest" }] },
  "Reply with ok",
);
```

## Agent class

`new Agent(config)` (or `create_agent(raw)`) builds the provider router, registers the twelve builtin tools (filtered by `tools_enabled`), and exposes:

| Member | Type | Purpose |
| --- | --- | --- |
| `run(options)` | `(AgentRunOptions) => Promise<AgentRunResult>` | Run the loop to a final answer, budget exhaustion, or abort. |
| `events` | `AgentEmitter` | Subscribe with `events.on(handler)`; the returned function unsubscribes. |
| `config` | `AgentConfig` | Frozen, fully-resolved config (defaults filled in). |

`AgentRunOptions`:

| Field | Type | Meaning |
| --- | --- | --- |
| `input` | `string` | Required user message for this run. |
| `history` | `Message[]` | Prior conversation to continue (multi-turn). |
| `signal` | `AbortSignal` | Cooperative cancellation; the loop returns `outcome.stopped_reason: "aborted"`. |
| `label` | `string` | Origin tag for the session filename (e.g. `"tui"`, `"gw:webhook:default"`). |

`AgentRunResult`:

| Field | Type | Meaning |
| --- | --- | --- |
| `outcome.final` | `AssistantMessage \| undefined` | The final assistant reply (undefined on abort/budget without content). |
| `outcome.turns_used` | `number` | Turns consumed this run. |
| `outcome.stopped_reason` | `"final" \| "budget" \| "aborted"` | Why the loop ended. |
| `messages` | `Message[]` | Full transcript: your `history` plus the new exchange. |
| `usage_total` | `Usage` | Summed `{prompt_tokens, completion_tokens, total_tokens}`. |
| `session_path` | `string \| undefined` | Session JSONL path, or `undefined` if persistence failed (logged warning, never throws). |

## Events

Handlers receive a discriminated `AgentEvent` union; throwing handlers are logged, never fatal:

| Event | Payload |
| --- | --- |
| `turn_start` / `turn_end` | `{ turn }` |
| `llm_start` | `{ turn }` |
| `llm_end` | `{ turn, result: ChatResult }` — carries `usage` per call. |
| `tool_call_start` | `{ turn, call: ToolCall }` |
| `tool_call_end` | `{ turn, call, result: ToolResult }` |
| `compress_start` | `{ estimated_tokens }` |
| `compress_end` | `{ summary_chars }` |
| `final` | `{ message, result }` — the answer that ends the run. |
| `budget_exhausted` | `{ turns_used }` |
| `error` | `{ error }` — provider/loop errors; the run may still recover via failover. |

Print every tool call as it happens:

```ts
const agent = create_agent(config);
const unsubscribe = agent.events.on((event) => {
  if (event.type === "tool_call_end") {
    const status = event.result.ok ? "ok" : `error: ${event.result.error}`;
    console.log(`[tool] ${event.call.name}(${JSON.stringify(event.call.args)}) -> ${status}`);
  }
});
try {
  await agent.run({ input: "List the repo and find TODO comments" });
} finally {
  unsubscribe();
}
```

## Multi-turn conversations

Pass prior `result.messages` back in as `history`:

```ts
let history: Message[] = [];
for (const question of ["What files are in the repo?", "Which one is largest?"]) {
  const result = await agent.run({ input: question, history });
  console.log(result.outcome.final?.content);
  history = result.messages;
}
```

## Config reference

Same schema as the CLI config file — see the [config file reference](cli.md#config-file-reference) for the full field table. As a library caller you normally construct it directly:

```ts
const config = {
  providers: [
    { kind: "openai_compat", name: "openrouter", model: "meta-llama/llama-3.1-8b-instruct",
      base_url: "https://openrouter.ai/api/v1", api_key_env: "OPENROUTER_API_KEY" },
    { kind: "ollama", name: "local", model: "llama3.2" },  // failover target
  ],
  max_turns: 25,
  tools_enabled: ["read_file", "list_dir", "terminal", "web_search", "fetch_url"],
  session_dir: "./.lich/sessions",
};
```

Listed providers form a failover chain tried in order: `rate_limit`/`network` errors retry with backoff (3 attempts) on the current provider before failing over; `auth`, `overflow`, and `bad_request` fail over immediately. The last error is rethrown when all providers fail.

## Custom tool filtering

`tools_enabled` accepts `"all"` (default) or an array of builtin tool names to register; everything else stays unregistered and invisible to the model:

```ts
const agent = create_agent({
  providers: [{ kind: "ollama", name: "local", model: "llama3.2" }],
  tools_enabled: ["read_file", "grep_files", "list_dir"],
});
```

## Error handling

Provider failures throw `ProviderError`, an `Error` subclass with `kind`, `provider_name`, optional `status` and `retry_after_ms`:

| `kind` | Meaning | Failover behavior |
| --- | --- | --- |
| `auth` | 401/403 or bad credentials. | Immediate failover to the next provider. |
| `rate_limit` | 429 or 5xx (with `retry_after_ms` when the server sends it). | 3 attempts with backoff, then failover. |
| `network` | Fetch failed, timeout, or abort while connecting. | 3 attempts with backoff, then failover. |
| `overflow` | Request exceeded the model's context window. | Immediate failover. |
| `bad_request` | 400/422 or an unparseable success payload. | Immediate failover. |
| `unknown` | Non-provider errors (e.g. tool crashes surfaced as strings). | Treated as fatal for the provider. |

```ts
import { ProviderError } from "lich";

try {
  await agent.run({ input: "hello" });
} catch (error) {
  if (error instanceof ProviderError) {
    console.error(`${error.provider_name} failed: ${error.kind} — ${error.message}`);
  }
  throw error;
}
```

When every configured provider fails, the last `ProviderError` is thrown. Tool failures are *not* exceptions: they return `{ ok: false, output, error }` into the loop as tool messages for the model to react to. Cancellation via `signal` ends the run with `stopped_reason: "aborted"` rather than throwing.

## Session access

Each `run()` appends a transcript line-by-line under `config.session_dir` (default `<work_dir>/.lich/sessions`); `result.session_path` gives the exact file. Records carry `{ts, kind: "message"|"meta", message?, meta?}`; read them with `jq` or the exported `read_session_messages(path)` helper from `src/session/store.ts`. Persistence is best-effort: a write failure logs a warning, returns `session_path: undefined`, and never fails the run.