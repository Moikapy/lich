/**
 * T-4: mock-provider finish_reason length and truncated / unparseable tool arguments.
 */
import { describe, expect, it } from "vitest";
import { OpenAICompatProvider } from "../src/providers/openai.js";
import type { ProviderConfig } from "../src/providers/types.js";

function openai_config(fetch_fn: typeof fetch): ProviderConfig {
  return {
    kind: "openai_compat",
    name: "mock",
    model: "mock-model",
    api_key: "sk-test",
    base_url: "http://mock.local/v1",
    fetch_fn,
  };
}

function fixed_fetch(body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

describe("OpenAICompatProvider finish_reason and tools", () => {
  it("maps finish_reason length from a truncated completion", async () => {
    const provider = new OpenAICompatProvider(
      openai_config(
        fixed_fetch({
          model: "mock-model",
          choices: [
            {
              message: { role: "assistant", content: "cut off mid" },
              finish_reason: "length",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      ),
    );
    const result = await provider.chat([{ role: "user", content: "go" }], []);
    expect(result.finish_reason).toBe("length");
    expect(result.message.content).toBe("cut off mid");
    expect(result.message.tool_calls).toBeUndefined();
  });

  it("omits tool calls when finish_reason is length (truncated tools)", async () => {
    const provider = new OpenAICompatProvider(
      openai_config(
        fixed_fetch({
          model: "mock-model",
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "partial_1",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"a' },
                  },
                ],
              },
              finish_reason: "length",
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
      ),
    );
    const result = await provider.chat([{ role: "user", content: "read" }], []);
    expect(result.finish_reason).toBe("length");
    expect(result.message.tool_calls).toBeUndefined();
    expect(result.message.content).toContain("[truncated tool call omitted]");
  });

  it("parses valid tool arguments when finish_reason is tool_calls", async () => {
    const provider = new OpenAICompatProvider(
      openai_config(
        fixed_fetch({
          model: "mock-model",
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "list_dir", arguments: '{"path":"."}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      ),
    );
    const result = await provider.chat([{ role: "user", content: "list" }], []);
    expect(result.finish_reason).toBe("tool_calls");
    expect(result.message.tool_calls?.[0]?.args).toEqual({ path: "." });
  });
});
