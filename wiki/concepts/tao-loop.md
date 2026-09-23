---
title: Think-Act-Observe (TAO) loop
created: 2026-09-23
updated: 2026-09-23
type: concept
tags: [core, research]
sources: [raw/audits/2026-09-23-core-engine-audit.md, raw/audits/2026-09-23-hermes-vs-lich.md]
confidence: high
---

# Think-Act-Observe loop

An LLM is effectively a pure function: messages go in, one message comes out. An **agent** is the loop you wrap around that function:

```
history = [system, user]
repeat up to max_turns:
    reply = model(history, tool_schemas)          # THINK
    history.append(reply)
    if no reply.tool_calls: return reply          # done
    for call in reply.tool_calls:                 # ACT
        history.append(tool_result(call, run(call)))   # OBSERVE
```

Lich implements this in about 245 lines ([[lich-agent-loop]]). Everything else in a harness supports this loop:
- provider adapters and failover
- a tool registry and an executor
- hooks and guards
- compression
- persistence
- the surfaces people use it through

## Invariants every harness has to keep

1. **Every tool call gets exactly one result message,** including cancelled calls. Providers reject histories with unpaired calls.
2. **Never split a tool call from its result.** This holds for compression, truncation, resume and trajectory export. Lich fixed a violation of this as A-2, and Hermes' trajectory compressor enforces the same rule.
3. **Tool failures are data, not exceptions.** Returning `{ok:false, error}` lets the model recover; a throw ends the run.
4. **The loop depends on interfaces, not implementations.** Lich's loop sees only `ChatFn` and `ToolRunner`, which makes it testable and lets the same code serve different purposes.

## Variation for games

Coding agents optimize for correctness over many turns. Game agents optimize for **latency per decision**, which changes the loop's stop rule; see [[action-terminal-mode]]. They also need observations that are more than text (images, typed state).

Related: [[event-envelope]], [[lich-vs-hermes]].
