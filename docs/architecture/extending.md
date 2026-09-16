# Extending Lich

Hands-on recipes for the three extension axes: builtin tools, providers, and
gateway platforms - plus the TUI internals, the conventions that hold the
codebase together, and how the test suite is organized. Everything on this
page assumes a clone of the repository — the `@moikapy/lich` npm package is
the artifact this source builds (see
[development install](../getting-started.md#development-install-from-source)).
Read [tools](./tools.md) and [providers](./providers.md) first for the contracts.

## Add a builtin tool

A builtin is one file in `src/tools/builtin/` following the
[`terminal.ts`](../../src/tools/builtin/terminal.ts) shape, plus one line in
`src/tools/builtin/index.ts`. Walkthrough with a complete, useful example:
a `hash_text` tool (SHA-256 through Node's `crypto`).

**Step 1 - create `src/tools/builtin/hash_text.ts`:**

```ts
import { createHash } from "node:crypto";
import type { JsonSchemaObject } from "../../util/json_schema.js";
import { capture_errors, require_string_arg } from "../guard.js";
import type { Tool } from "../types.js";

const parameters: JsonSchemaObject = {
  type: "object",
  properties: {
    text: { type: "string", description: "Text to hash with sha256" },
    algorithm: { type: "string", description: "sha256 (default) or sha1 or md5" },
  },
  required: ["text"],
  additionalProperties: false,
};

const ALGORITHMS = new Set(["sha256", "sha1", "md5"]);

async function hash_text(args: Record<string, unknown>): Promise<string> {
  const text = require_string_arg(args, "text");
  const algorithm = ALGORITHMS.has(String(args.algorithm)) === true
    ? String(args.algorithm)
    : "sha256";
  return createHash(algorithm).update(text, "utf8").digest("hex");
}

export const hash_text_tool: Tool = {
  name: "hash_text",
  description: "Hash text with sha256 (default), sha1, or md5.",
  parameters,
  execute: async (args) => capture_errors(async () => ({ ok: true, output: await hash_text(args) })),
};
```

Note the conventions this mirrors from `terminal.ts`: module-level
`parameters` constant, argument reads through the guard coercion helpers,
one pure `hash_text` function the test can target, and `execute` wrapped in
`capture_errors` so the never-throw contract holds even if a guard throws.

**Step 2 - register in `src/tools/builtin/index.ts`:** add the import and add
`hash_text_tool` to the `builtin_tools` array. `register_builtin_tools`
registers the whole set via `builtin_toolset`; nothing else changes.

**Step 3 - test it** in `test/tools.test.ts` (or a sibling), following the
existing pattern of calling the tool directly with a hand-built context:

```ts
import { hash_text_tool } from "../src/tools/builtin/hash_text.js";

it("hash_text returns the sha256 hex digest", async () => {
  const result = await hash_text_tool.execute(
    { text: "lich" },
    { work_dir: "/tmp", env: {} },
  );
  expect(result.ok).toBe(true);
  expect(result.output).toBe(
    "1e3c2f5c4ba9d476a3b93e2c1a7f2b8d9e0c1a2b3c4d5e6f708192a3b4c5d6e7",
  );
});
```

(The digest literal is illustrative - compute the real one once and freeze it
into the test.) The executor-level suite in `test/tools.test.ts` covers the
shared machinery (timeout, unknown tool, clamping), so a new builtin only
needs mapping and behavior tests like the one above.

If the tool needs the LLM-side wiring exercised too, reuse the loop test
fakes: a `ToolRunner` stub in `test/loop.test.ts` style, or run the full
public API with the mock-provider pattern from `test/e2e.test.ts`.

## Add a provider

Implement `LLMProvider` (see [providers](./providers.md#the-llmprovider-contract))
and register it in exactly **three touch points** - the same three that
adding ollama required:

1. **The client file.** Use [`ollama.ts`](../../src/providers/ollama.ts) as
   the template. Its structure:

   - Typed wire DTOs (request/response), never `any`.
   - Small pure mapping helpers: `to_*_messages` (our `Message` -> wire),
     `assistant_to_wire` / `tool_to_wire`, `to_*_tools`, `build_request_body`.
   - The fetch skeleton shared by all clients: resolve auth, `build_endpoint`,
     `do_fetch` (fetch throws -> `network`), `to_http_error` (non-OK ->
     classified kind + `Retry-After`), `read_success_json` (unparseable 2xx ->
     `bad_request`).
   - An error mapper: a `status_to_error_kind` function implementing the
     taxonomy table from [providers](./providers.md#error-taxonomy), plus a
     body-sniffing regex for `overflow` on 400s.
   - A factory export (`create_ollama_provider`) if construction may grow.

2. **The `ProviderConfig` union.** Add the kind string to the `kind` union in
   `src/providers/types.ts` (ProviderConfig), and any kind-specific fields
   next to `think` / `keep_alive` (ollama-only fields are documented as such).

3. **The router kind map.** One branch in `build_provider`
   (src/providers/router.ts):

```ts
function build_provider(config: ProviderConfig): LLMProvider {
  if (config.kind === "anthropic") {
    return new AnthropicProvider(config);
  }
  if (config.kind === "ollama") {
    return create_ollama_provider(config);
  }
  return new OpenAICompatProvider(config);
}
```

   (src/providers/router.ts)

4. **The zod config enum.** `kind: z.enum(["openai_compat", "anthropic",
   "ollama"])` in `src/agent/config.ts` must accept the new string or config
   parsing rejects it before the router ever sees it.

   (Strictly that is four small edits across three files plus the client -
   client file, `ProviderConfig` union, router kind map, zod enum. Ollama
   needed no other changes: failover, retry classification, sessions, and the
   loop all work against the interface, not the client.)

**Testing via `fetch_fn`.** Copy the `mock_fetch` helper from
`test/providers.test.ts` (shown in [providers](./providers.md#testing-pattern)):
feed your client canned `Response` bodies, assert the captured request's URL,
headers, and JSON body, then assert the parsed `ChatResult`. Cover at minimum:
the message/tool wire mapping, one error status per taxonomy kind, and any
provider quirk you discovered (ollama's tests do exactly this for
`done_reason` and 200-with-error).

## Add a gateway platform

A platform adapter is an implementation of the `PlatformAdapter` contract
([`src/gateway/types.ts`](../../src/gateway/types.ts)):

```ts
export interface PlatformAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Inbound flow: the adapter normalizes a platform event into
`(platform, chat_id, user_id, text)` and calls `run_inbound_message` with the
shared `InboundHandler`; the handler is the bus's `handle`, which resolves to
the reply text; the adapter then sends the reply through the platform's send
API. The bus owns history, serialization, and error sanitization - adapters
stay thin.

Recipe (mirroring [`telegram.ts`](../../src/gateway/telegram.ts), the
simplest real adapter):

1. **Write `src/gateway/<platform>.ts`** exporting
   `create_<platform>_adapter(params: AdapterParams): PlatformAdapter`.
   Inside, receive messages however the platform delivers them (polling,
   WebSocket, HTTP push), normalize them, then:

```ts
const reply = await run_inbound_message(
  params.handle_message, "platform-name", chat_id, user_id, text,
);
await send_reply(reply);
```

2. **Register it in the runner.** Add the platform to `is_known_platform` and
   to the `create_platform_adapter` switch in `src/gateway/runner.ts`. That is
   the only registration point; `build_adapters` handles the rest.

3. **Handle missing credentials with the idle-adapter pattern.** When the
   platform's token env var is absent, return
   `create_idle_adapter("platform", "ENV_VAR not set")` instead of throwing.
   The adapter logs once why it is idle and no-ops on start/stop, so the
   gateway keeps serving the platforms that *do* have credentials -
   `run_gateway` only needs one valid platform.

4. **Reuse the shared helpers**: `open_socket` for WebSocket platforms (the
   structural `RawSocket` type works on both Bun and Node runtimes),
   `sanitize_agent_error` for reply strings on failure, and the whitespace
   splitter `split_text` from `src/gateway/format.ts` for size-capped
   transports (telegram caps at 4096, discord at 2000, twitch at 512).

**Testing.** `test/gateway.test.ts` covers the webhook adapter over a real
`node:http` server (a `on_listening` test hook reports the bound port), the
bus with a fake agent factory, and pure parsers (`split_text`, Twitch IRC
line parsing). For a socket platform, inject a fake `RawSocket`
implementation exercising `onopen`/`onmessage`, or extract a pure parse
function (like `parse_irc_line`) and unit-test it directly - the twitch
adapter does exactly that.

## TUI internals

The TUI splits cleanly in two:

- **`src/tui/state.ts`** - pure logic, zero ink/react imports: the `UiState`
  shape, the `apply_event` reducer, slash-command parsing
  (`parse_command`), and transcript formatters. Unit-tested without a TTY in
  `test/tui.test.ts`.
- **`src/tui/app.tsx`** (+ `message_view.tsx`, `command_bar.tsx`,
  `status_bar.tsx`) - ink components that hold the only mutable React state,
  feed agent events into `apply_event`, and render blocks.

Why: ink components need a TTY and make tests slow and brittle; the reducer
needs neither. The event -> state table is the whole behavioral contract:

| Event | State change |
| --- | --- |
| `llm_start` | `phase: "thinking"`, `active_tool: undefined` |
| `llm_end` | Accumulates `usage` from the result |
| `tool_call_start` | `phase: "tool"`, `active_tool` set |
| `tool_call_end` | `phase: "thinking"`, `active_tool` cleared; failed results set `last_error` |
| `turn_end` | `turns_used: event.turn` |
| `compress_start` | `compress_count` increments |
| `budget_exhausted` | `budget_exhausted: true` |
| `error` | `last_error` set from the error text |

`apply_run_result` folds the finished `AgentRunResult` back in (phase back to
`idle`, session path, abort notice). Design trade-off: state updates are
event-coarse - there is **no token streaming in the TUI**; users see phase
changes and completed tool rows rather than streaming text.

## Design constraints

These are architecture decisions, not style rules; they are what keeps the
codebase extensible:

- **No recursion.** Tree-shaped work (directory walking in `list_dir`,
  `grep_files`; the retry loop in `failover.ts`) uses explicit stacks, queues,
  and `while` loops. Deep directories and long retry chains cannot overflow
  the stack.
- **Helpers and hooks stay under 60 lines.** Long functions are split into
  small pure mapping helpers (see the provider clients: every mapping step is
  a named, testable function).
- **Narrow structural interfaces at every seam.** `ChatFn`, `ToolRunner`,
  `LLMProvider`, `PlatformAdapter`, `Tool` - consumers depend on shapes, not
  concrete classes, so every piece is fake-able in tests.
- **Zero-dependency core.** Only `zod` (config) and `ink` (TUI) are runtime
  dependencies. Network calls use the global `fetch`; HTTP serving uses
  `node:http`; JSON handling is hand-rolled in `src/util/json.ts`. Nothing to
  audit, nothing to break on upgrade.
- **Determinism where tests need it.** Backoff jitter is a fixed formula, not
  `Math.random`; time-derived values (session ids, ollama tool-call ids) are
  formatted, not sampled.

## Testing the harness

The suite runs with `bun test` (or `bun x vitest run`); it is fully offline -
every provider call, gateway socket, and HTTP exchange is mocked. Live
smokes (real OpenAI/Anthropic/Ollama calls, real platform bots) are manual,
by design.

| Test file | Covers |
| --- | --- |
| `test/loop.test.ts` | Loop scenarios A/B/C: tool turn then final, budget stop, abort; event ordering; history non-mutation. |
| `test/agent_config.test.ts` | Zod config parsing, defaults, derived `session_dir`. |
| `test/compressor.test.ts` | Token estimator, `should_compress` threshold math, summary partitioning. |
| `test/providers.test.ts` | OpenAI + Anthropic wire mapping, error taxonomy via `fetch_fn` injection. |
| `test/providers_ollama.test.ts` | Ollama quirks (tool-call presence vs `done_reason`, 200-with-error) and ollama failover. |
| `test/failover.test.ts` | Error classification, backoff formula, retry loop, router walk, failover ordering. |
| `test/tools.test.ts` | Guard helpers, registry, executor, and the filesystem builtins. |
| `test/tools_extra.test.ts` | HTTP tools, `process_list`, `disk_usage`, `env_get`. |
| `test/gateway.test.ts` | Bus serialization/history caps, webhook server, reply formatting, telegram/twitch splitting and parsing. |
| `test/tui.test.ts` | The pure TUI state machine: reducer, commands, formatters. |
| `test/cli_config.test.ts` | Config discovery, loading, flag overrides, template. |
| `test/e2e.test.ts` | Full runs through the public API (`run_agent`) with mock providers. |

When you extend the harness, add the test next to the seam you extended and
keep the network out of it - see the `fetch_fn` pattern in
[providers](./providers.md#testing-pattern) and the mock-socket notes above.