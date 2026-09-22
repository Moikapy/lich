import { describe, expect, it } from "vitest";
import {
  COMPRESSION_SYSTEM_PROMPT,
  compress_messages,
  should_compress,
  transcript_char_budget,
  truncate_head_tail,
  type ChatFn,
} from "../src/context/compressor.js";
import { estimate_text_tokens } from "../src/context/tokens.js";
import type { ChatResult, Message, SystemMessage, UserMessage } from "../src/providers/types.js";
import { ProviderError } from "../src/providers/types.js";

function user_message(content: string): UserMessage {
  return { role: "user", content };
}

function system_message(content: string): SystemMessage {
  return { role: "system", content };
}

function fixed_chat_result(content: string): ChatResult {
  return {
    message: { role: "assistant", content },
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    finish_reason: "stop",
    model: "mock-model",
    provider_name: "mock",
  };
}

describe("estimate_text_tokens", () => {
  it("uses the 4-chars-per-token heuristic", () => {
    expect(estimate_text_tokens("abcdefgh")).toBe(2);
    expect(estimate_text_tokens("abcdefg")).toBe(2);
    expect(estimate_text_tokens("")).toBe(0);
  });
});

describe("should_compress", () => {
  it("fires only at or above budget * threshold", () => {
    const under = [user_message("a".repeat(316))];
    const at_threshold = [user_message("a".repeat(320))];
    expect(should_compress(under, 100, 0.8)).toBe(false);
    expect(should_compress(at_threshold, 100, 0.8)).toBe(true);
  });
});

describe("compress_messages", () => {
  it("partitions history: system kept, older summarized, recent verbatim", async () => {
    const requests: Message[][] = [];
    const chat: ChatFn = async (messages) => {
      requests.push([...messages]);
      return fixed_chat_result("GOALS: finish tests");
    };
    const system = system_message("system rules");
    const users = Array.from({ length: 10 }, (_unused, index) => user_message(`user turn ${index}`.repeat(2)));
    const outcome = await compress_messages({ chat }, [system, ...users], { budget_tokens: 1000, keep_recent: 3 });

    expect(outcome.summary_chars).toBe("GOALS: finish tests".length);
    expect(outcome.messages).toHaveLength(5);
    expect(outcome.messages[0]).toBe(system);

    const summary = outcome.messages[1];
    expect(summary?.role).toBe("user");
    if (summary?.role === "user") {
      expect(summary.content).toContain("[context summary of earlier turns]");
      expect(summary.content).toContain("GOALS: finish tests");
      expect(summary.content).toContain("[end summary]");
    }
    expect(outcome.messages.slice(2)).toEqual(users.slice(7));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveLength(2);
    expect(requests[0]?.[0]).toEqual({ role: "system", content: COMPRESSION_SYSTEM_PROMPT });
    const request_user = requests[0]?.[1];
    expect(request_user?.role).toBe("user");
    if (request_user?.role === "user") {
      expect(request_user.content).toContain("user turn 0");
      expect(request_user.content).not.toContain("user turn 9");
    }
  });

  it("scales transcript budget and keeps head+tail of long older turns", async () => {
    expect(transcript_char_budget(100000)).toBe(24000);
    expect(transcript_char_budget(1000)).toBe(8000);
    expect(truncate_head_tail("abcdefghij", 6).length).toBeLessThanOrEqual(6);

    const requests: Message[][] = [];
    const chat: ChatFn = async (messages) => {
      requests.push([...messages]);
      return fixed_chat_result("ok");
    };
    const early = user_message(`START_GOAL ${"a".repeat(12000)}`);
    const mid = user_message(`MIDDLE ${"b".repeat(12000)}`);
    const late = user_message(`LATE_OPEN ${"c".repeat(12000)}`);
    const recent = [user_message("r0"), user_message("r1")];
    await compress_messages({ chat }, [early, mid, late, ...recent], {
      budget_tokens: 1000,
      keep_recent: 2,
      model_hint: "mock-model",
    });

    const request_user = requests[0]?.[1];
    expect(request_user?.role).toBe("user");
    if (request_user?.role === "user") {
      expect(request_user.content).toContain("START_GOAL");
      expect(request_user.content).toContain("LATE_OPEN");
      expect(request_user.content).toContain("[...");
      expect(request_user.content).toContain("(Continuing agent run as model: mock-model)");
      expect(request_user.content.length).toBeLessThan(9000);
    }
  });

  it("returns messages unchanged when the chat call fails (best-effort)", async () => {
    const chat: ChatFn = async () => {
      throw new ProviderError({ kind: "network", provider_name: "mock", message: "provider down" });
    };
    const input = [system_message("sys"), user_message("u0"), user_message("u1"), user_message("u2")];
    const outcome = await compress_messages({ chat }, input, { budget_tokens: 10, keep_recent: 1 });
    expect(outcome.messages).toEqual(input);
    expect(outcome.summary_chars).toBe(0);
  });

  it("does not call chat when there is nothing older than the recent window", async () => {
    const state = { called: false };
    const chat: ChatFn = async () => {
      state.called = true;
      return fixed_chat_result("never");
    };
    const input = [system_message("sys"), user_message("u0"), user_message("u1")];
    const outcome = await compress_messages({ chat }, input, { budget_tokens: 10, keep_recent: 5 });
    expect(state.called).toBe(false);
    expect(outcome.messages).toEqual(input);
    expect(outcome.summary_chars).toBe(0);
  });

  it("moves the keep-recent cut back so recent never starts on a tool message", async () => {
    const chat: ChatFn = async () => fixed_chat_result("SUMMARY");
    const input: Message[] = [
      system_message("sys"),
      user_message("u0"),
      user_message("u1"),
      { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "read_file", args: { path: "a" } }] },
      { role: "tool", tool_call_id: "c1", name: "read_file", content: "file-a" },
      user_message("u2"),
      user_message("u3"),
    ];
    // keep_recent=3 would otherwise start on the orphan tool result.
    const outcome = await compress_messages({ chat }, input, { budget_tokens: 1000, keep_recent: 3 });
    const recent = outcome.messages.filter((message) => message.role !== "system");
    const summary = recent[0];
    expect(summary?.role).toBe("user");
    if (summary?.role === "user") {
      expect(summary.content).toContain("SUMMARY");
    }
    expect(recent[1]?.role).toBe("assistant");
    expect(recent[2]?.role).toBe("tool");
    expect(recent.slice(1).map((message) => message.role)).toEqual(["assistant", "tool", "user", "user"]);
  });
});