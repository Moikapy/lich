/**
 * T-4 (A-2): compression pairing invariant — recent window never starts on orphan tools.
 */
import { describe, expect, it } from "vitest";
import { compress_messages, type ChatFn } from "../src/context/compressor.js";
import type { ChatResult, Message } from "../src/providers/types.js";

function fixed_chat(content: string): ChatFn {
  return async (): Promise<ChatResult> => ({
    message: { role: "assistant", content },
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    finish_reason: "stop",
    model: "mock-model",
    provider_name: "mock",
  });
}

function assert_no_orphan_tools(messages: readonly Message[]): void {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls !== undefined) {
      for (const call of message.tool_calls) {
        pending.add(call.id);
      }
    }
    if (message.role === "tool") {
      expect(pending.has(message.tool_call_id), `orphan tool ${message.tool_call_id}`).toBe(true);
      pending.delete(message.tool_call_id);
    }
  }
}

describe("compression pairing (A-2)", () => {
  it("never leaves a tool message without its parent assistant in the kept window", async () => {
    const input: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u0" },
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", name: "read_file", args: { path: "a" } },
          { id: "b", name: "read_file", args: { path: "b" } },
        ],
      },
      { role: "tool", tool_call_id: "a", name: "read_file", content: "A" },
      { role: "tool", tool_call_id: "b", name: "read_file", content: "B" },
      { role: "user", content: "u2" },
      { role: "user", content: "u3" },
    ];
    // keep_recent=3 would otherwise start on the second tool result.
    const outcome = await compress_messages({ chat: fixed_chat("SUMMARY") }, input, {
      budget_tokens: 1000,
      keep_recent: 3,
    });
    expect(outcome.messages[0]?.role).toBe("system");
    const non_system = outcome.messages.filter((message) => message.role !== "system");
    expect(non_system[0]?.role).toBe("user");
    if (non_system[0]?.role === "user") {
      expect(non_system[0].content).toContain("SUMMARY");
    }
    assert_no_orphan_tools(outcome.messages);
    expect(non_system.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
      "user",
    ]);
  });

  it("pairs when the cut lands exactly on the first of two tool results", async () => {
    const input: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "older" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", name: "noop", args: {} },
          { id: "c2", name: "noop", args: {} },
        ],
      },
      { role: "tool", tool_call_id: "c1", name: "noop", content: "1" },
      { role: "tool", tool_call_id: "c2", name: "noop", content: "2" },
      { role: "user", content: "after" },
    ];
    const outcome = await compress_messages({ chat: fixed_chat("S") }, input, {
      budget_tokens: 1000,
      keep_recent: 3,
    });
    assert_no_orphan_tools(outcome.messages);
    const roles = outcome.messages.map((message) => message.role);
    expect(roles).toContain("assistant");
    expect(roles.filter((role) => role === "tool")).toHaveLength(2);
  });
});
