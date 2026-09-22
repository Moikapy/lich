import { describe, expect, it } from "vitest";
import { AgentEmitter, type AgentEvent } from "../src/agent/events.js";
import type { ChatFn } from "../src/context/compressor.js";
import { run_conversation, type LoopDeps, type ToolRunner } from "../src/agent/loop.js";
import type { ChatResult, Message, ToolCall } from "../src/providers/types.js";

function result(content: string, calls?: ToolCall[]): ChatResult {
  return {
    message: { role: "assistant", content, ...(calls === undefined ? {} : { tool_calls: calls }) },
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    finish_reason: calls === undefined ? "stop" : "tool_calls",
    model: "mock-model",
    provider_name: "mock",
  };
}

function make_chat_queue(results: ChatResult[]): ChatFn {
  return async () => {
    const next = results.shift();
    if (next === undefined) {
      throw new Error("chat queue exhausted");
    }
    return next;
  };
}

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
}

function make_tool_runner(output: string): { runner: ToolRunner; calls: ToolCallRecord[] } {
  const calls: ToolCallRecord[] = [];
  const runner: ToolRunner = {
    execute: async (name, args) => {
      calls.push({ name, args });
      return { ok: true, output };
    },
  };
  return { runner, calls };
}

function event_types(events: AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

const tool_call_t1: ToolCall = { id: "t1", name: "read_file", args: { path: "a.txt" } };

describe("run_conversation", () => {
  it("scenario A: tool turn then final answer, events in order", async () => {
    const emitter = new AgentEmitter();
    const events: AgentEvent[] = [];
    emitter.on((event) => events.push(event));
    const chat = make_chat_queue([result("", [tool_call_t1]), result("all done")]);
    const { runner, calls } = make_tool_runner("file contents here");
    const deps: LoopDeps = { chat, tools: runner, definitions: () => [], emitter };
    const seed: Message[] = [{ role: "user", content: "read a.txt" }];

    const outcome = await run_conversation(deps, seed, { max_turns: 5 });

    expect(outcome.stopped_reason).toBe("final");
    expect(outcome.turns_used).toBe(2);
    expect(outcome.final?.content).toBe("all done");
    expect(calls).toEqual([{ name: "read_file", args: { path: "a.txt" } }]);

    const tool_message = outcome.messages.find((message) => message.role === "tool");
    expect(tool_message).toBeDefined();
    if (tool_message?.role === "tool") {
      expect(tool_message.tool_call_id).toBe("t1");
      expect(tool_message.name).toBe("read_file");
      expect(tool_message.content).toBe("file contents here");
      expect(tool_message.is_error).toBeUndefined();
    }
    expect(outcome.messages[0]?.role).toBe("user");
    expect(outcome.messages.at(-1)?.role).toBe("assistant");

    expect(event_types(events)).toEqual([
      "turn_start",
      "llm_start",
      "llm_end",
      "tool_call_start",
      "tool_call_end",
      "turn_end",
      "turn_start",
      "llm_start",
      "llm_end",
      "final",
      "turn_end",
    ]);
    const final_event = events.find((event) => event.type === "final");
    expect(final_event).toBeDefined();
    if (final_event?.type === "final") {
      expect(final_event.message.content).toBe("all done");
    }
    expect(outcome.messages).not.toBe(seed);
    expect(seed).toHaveLength(1);
  });

  it("scenario B: endless tool calls stop at max_turns with budget_exhausted", async () => {
    const emitter = new AgentEmitter();
    const events: AgentEvent[] = [];
    emitter.on((event) => events.push(event));
    const chat: ChatFn = async () => result("", [{ id: "loop", name: "noop", args: {} }]);
    const { runner } = make_tool_runner("noop output");
    const deps: LoopDeps = { chat, tools: runner, definitions: () => [], emitter };

    const outcome = await run_conversation(deps, [{ role: "user", content: "go" }], { max_turns: 3 });

    expect(outcome.stopped_reason).toBe("budget");
    expect(outcome.turns_used).toBe(3);
    expect(outcome.final?.tool_calls).toHaveLength(1);
    expect(event_types(events).filter((type) => type === "turn_start")).toHaveLength(3);
    expect(event_types(events).filter((type) => type === "turn_end")).toHaveLength(3);
    expect(events.at(-2)?.type).toBe("budget_exhausted");
    expect(events.at(-1)?.type).toBe("turn_end");
  });

  it("scenario C: abort signal stops the loop before the next LLM call", async () => {
    const controller = new AbortController();
    const emitter = new AgentEmitter();
    const events: AgentEvent[] = [];
    emitter.on((event) => events.push(event));
    let chat_calls = 0;
    const chat: ChatFn = async () => {
      chat_calls += 1;
      controller.abort();
      return result("", [{ id: "t1", name: "read_file", args: { path: "a.txt" } }]);
    };
    const { runner, calls } = make_tool_runner("ok");
    const deps: LoopDeps = { chat, tools: runner, definitions: () => [], emitter };

    const outcome = await run_conversation(deps, [{ role: "user", content: "go" }], {
      max_turns: 5,
      signal: controller.signal,
    });

    expect(outcome.stopped_reason).toBe("aborted");
    expect(chat_calls).toBe(1);
    expect(calls).toHaveLength(0);
    expect(outcome.turns_used).toBe(1);
    const cancelled = outcome.messages.find((message) => message.role === "tool");
    expect(cancelled?.role).toBe("tool");
    if (cancelled?.role === "tool") {
      expect(cancelled.content).toContain("cancelled");
      expect(cancelled.is_error).toBe(true);
    }
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(event_types(events).at(-1)).toBe("error");
    expect(event_types(events).filter((type) => type === "tool_call_end")).toHaveLength(1);
    expect(events.some((event) => event.type === "tool_call_end" && event.cancelled === true)).toBe(true);
  });

  it("returns aborted when chat throws after the signal aborts mid-call", async () => {
    const controller = new AbortController();
    const emitter = new AgentEmitter();
    const events: AgentEvent[] = [];
    emitter.on((event) => events.push(event));
    const chat: ChatFn = async () => {
      controller.abort();
      const error = new Error("fetch aborted");
      error.name = "AbortError";
      throw error;
    };
    const { runner } = make_tool_runner("ok");
    const deps: LoopDeps = { chat, tools: runner, definitions: () => [], emitter };

    const outcome = await run_conversation(deps, [{ role: "user", content: "go" }], {
      max_turns: 3,
      signal: controller.signal,
    });

    expect(outcome.stopped_reason).toBe("aborted");
    expect(outcome.turns_used).toBe(0);
    expect(outcome.messages).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("skips remaining tool calls when the signal aborts between them", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const runner: ToolRunner = {
      execute: async (name) => {
        calls.push(name);
        controller.abort();
        return { ok: true, output: "done" };
      },
    };
    const chat = make_chat_queue([
      result("", [
        { id: "t1", name: "first", args: {} },
        { id: "t2", name: "second", args: {} },
      ]),
    ]);
    const deps: LoopDeps = {
      chat,
      tools: runner,
      definitions: () => [],
      tool_context: { work_dir: ".", env: {}, signal: controller.signal },
    };

    const outcome = await run_conversation(deps, [{ role: "user", content: "go" }], {
      max_turns: 3,
      signal: controller.signal,
    });

    expect(outcome.stopped_reason).toBe("aborted");
    expect(calls).toEqual(["first"]);
    const tool_messages = outcome.messages.filter((message) => message.role === "tool");
    expect(tool_messages).toHaveLength(2);
    expect(tool_messages[1]?.role).toBe("tool");
    if (tool_messages[1]?.role === "tool") {
      expect(tool_messages[1].content).toContain("cancelled");
      expect(tool_messages[1].tool_call_id).toBe("t2");
    }
  });

  it("emits cancelled tool_call_end for skipped tool calls so persistence stays paired", async () => {
    const controller = new AbortController();
    const emitter = new AgentEmitter();
    const events: AgentEvent[] = [];
    emitter.on((event) => events.push(event));
    const runner: ToolRunner = {
      execute: async () => {
        controller.abort();
        return { ok: true, output: "done" };
      },
    };
    const chat = make_chat_queue([
      result("", [
        { id: "t1", name: "first", args: {} },
        { id: "t2", name: "second", args: {} },
      ]),
    ]);
    const deps: LoopDeps = {
      chat,
      tools: runner,
      definitions: () => [],
      emitter,
      tool_context: { work_dir: ".", env: {}, signal: controller.signal },
    };

    await run_conversation(deps, [{ role: "user", content: "go" }], {
      max_turns: 3,
      signal: controller.signal,
    });

    const ends = events.filter((event) => event.type === "tool_call_end");
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({ call: { id: "t1" }, result: { ok: true } });
    expect(ends[0] && "cancelled" in ends[0] ? ends[0].cancelled : undefined).toBeUndefined();
    expect(ends[1]).toMatchObject({ call: { id: "t2" }, cancelled: true, result: { error: "cancelled" } });
  });

  it("scenario D: compresses history when the context budget is exceeded", async () => {
    const emitter = new AgentEmitter();
    const events: AgentEvent[] = [];
    emitter.on((event) => events.push(event));
    const pad = "x".repeat(400);
    const seed: Message[] = [
      { role: "user", content: pad },
      ...Array.from({ length: 10 }, (_unused, index) => ({ role: "user" as const, content: `note ${index} ${pad}` })),
    ];
    const chat: ChatFn = async (messages) => {
      const system_message = messages[0];
      if (system_message?.role === "system" && system_message.content.includes("compress")) {
        return {
          ...result("TERSE SUMMARY CONTENT"),
          usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
          finish_reason: "stop",
        };
      }
      return result("thinking again", [{ id: "t2", name: "noop", args: {} }]);
    };
    const { runner } = make_tool_runner("ok");
    const deps: LoopDeps = { chat, tools: runner, definitions: () => [], emitter };

    const outcome = await run_conversation(deps, seed, {
      max_turns: 5,
      context_budget_tokens: 100,
      compress_threshold: 0.8,
    });

    expect(outcome.stopped_reason).toBe("budget");
    expect(events.some((event) => event.type === "compress_start")).toBe(true);
    expect(events.some((event) => event.type === "compress_end")).toBe(true);
    const compress_usage = events.find(
      (event) =>
        event.type === "llm_end" && event.result.message.content === "TERSE SUMMARY CONTENT",
    );
    expect(compress_usage?.type).toBe("llm_end");
    if (compress_usage?.type === "llm_end") {
      expect(compress_usage.result.usage.total_tokens).toBe(50);
    }
    const summary_message = outcome.messages.find(
      (message) => message.role === "user" && message.content.includes("[context summary"),
    );
    expect(summary_message).toBeDefined();
    if (summary_message?.role === "user") {
      expect(summary_message.content).toContain("TERSE SUMMARY CONTENT");
    }
  });

  it("backs off when compression cannot get under the threshold", async () => {
    const pad = "y".repeat(2000);
    const seed: Message[] = Array.from({ length: 12 }, (_unused, index) => ({
      role: "user" as const,
      content: `keep-${index} ${pad}`,
    }));
    let compress_calls = 0;
    const chat: ChatFn = async (messages) => {
      const system_message = messages[0];
      if (system_message?.role === "system" && system_message.content.includes("compress")) {
        compress_calls += 1;
        return result("tiny");
      }
      return result("again", [{ id: `c${compress_calls}`, name: "noop", args: {} }]);
    };
    const deps: LoopDeps = {
      chat,
      tools: make_tool_runner("ok").runner,
      definitions: () => [],
    };

    await run_conversation(deps, seed, {
      max_turns: 4,
      context_budget_tokens: 50,
      compress_threshold: 0.5,
    });

    expect(compress_calls).toBe(1);
  });

  it("seeds system prompt only when missing, replaces when different", async () => {
    const seen: Message[][] = [];
    const chat: ChatFn = async (messages) => {
      seen.push([...messages]);
      return result("done");
    };
    const deps: LoopDeps = { chat, tools: make_tool_runner("ok").runner, definitions: () => [] };

    await run_conversation(deps, [{ role: "user", content: "hi" }], { max_turns: 2, system_prompt: "be terse" });
    await run_conversation(
      deps,
      [{ role: "system", content: "old rules" }, { role: "user", content: "hi" }],
      { max_turns: 2, system_prompt: "new rules" },
    );
    await run_conversation(
      deps,
      [{ role: "system", content: "keep me" }, { role: "user", content: "hi" }],
      { max_turns: 2, system_prompt: "keep me" },
    );

    expect(seen[0]?.[0]?.content).toBe("be terse");
    expect(seen[1]?.[0]?.content).toBe("new rules");
    expect(seen[2]?.[0]?.content).toBe("keep me");
    expect(seen[0]).toHaveLength(2);
    expect(seen[1]).toHaveLength(2);
  });

  it("wraps failing tool results in is_error tool messages", async () => {
    const runner: ToolRunner = {
      execute: async () => ({ ok: false, output: "partial", error: "boom" }),
    };
    const chat = make_chat_queue([
      result("", [{ id: "t9", name: "shell", args: {} }]),
      result("recovered"),
    ]);
    const deps: LoopDeps = { chat, tools: runner, definitions: () => [] };

    const outcome = await run_conversation(deps, [{ role: "user", content: "try" }], { max_turns: 3 });

    const tool_message = outcome.messages.find((message) => message.role === "tool");
    expect(tool_message).toBeDefined();
    if (tool_message?.role === "tool") {
      expect(tool_message.is_error).toBe(true);
      const parsed = JSON.parse(tool_message.content) as { ok: boolean; output: string; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.output).toBe("partial");
      expect(parsed.error).toBe("boom");
    }
    expect(outcome.stopped_reason).toBe("final");
  });

  it("does not consume extra turns for tool execution", async () => {
    const emitter = new AgentEmitter();
    const events: AgentEvent[] = [];
    emitter.on((event) => events.push(event));
    const chat = make_chat_queue([
      result("", [{ id: "t1", name: "read_file", args: { path: "a.txt" } }]),
      result("ok"),
    ]);
    const { runner, calls } = make_tool_runner("data");
    const deps: LoopDeps = { chat, tools: runner, definitions: () => [], emitter };

    const outcome = await run_conversation(deps, [{ role: "user", content: "go" }], { max_turns: 2 });

    expect(outcome.stopped_reason).toBe("final");
    expect(outcome.turns_used).toBe(2);
    expect(calls).toHaveLength(1);
    expect(event_types(events).filter((type) => type === "tool_call_end")).toHaveLength(1);
  });

  it("rethrows provider errors from chat", async () => {
    const emitter = new AgentEmitter();
    const events: AgentEvent[] = [];
    emitter.on((event) => events.push(event));
    const chat: ChatFn = async () => {
      throw new Error("provider exploded");
    };
    const deps: LoopDeps = { chat, tools: make_tool_runner("ok").runner, definitions: () => [], emitter };

    await expect(
      run_conversation(deps, [{ role: "user", content: "go" }], { max_turns: 2 }),
    ).rejects.toThrow("provider exploded");
    expect(events.some((event) => event.type === "error")).toBe(true);
  });
});