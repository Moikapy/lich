/**
 * Controllers armed before a submit frame runs must leave the in-flight set
 * when that frame never becomes a run.
 */
import { describe, expect, it } from "vitest";
import type { Agent } from "../src/agent/agent.js";
import { create_serve_prompt_service } from "../src/serve/prompts.js";
import type { ServeSessionStore } from "../src/serve/sessions.js";

function idle_agent(): Agent {
  return {
    run: async () => {
      throw new Error("agent should not run");
    },
  } as unknown as Agent;
}

function empty_store(): ServeSessionStore {
  return {
    create: async () => {
      throw new Error("create");
    },
    clear: () => {
      throw new Error("clear");
    },
    list: async () => {
      throw new Error("list");
    },
    resume: async () => {
      throw new Error("resume");
    },
    get: () => undefined,
    pin: () => {
      throw new Error("pin");
    },
    unpin: () => undefined,
    dispose: () => undefined,
  };
}

describe("prepared submit controllers", () => {
  it("forgets a prepared controller when the session is already gone", () => {
    const prompts = create_serve_prompt_service(idle_agent(), empty_store());
    const session_id = "missing";
    const controller = prompts.prepare_submit!(session_id);
    expect(() => {
      prompts.submit({ session_id, text: "hi" }, () => undefined, controller);
    }).toThrow("session not found: missing");
    expect(controller.signal.aborted).toBe(false);
    expect(prompts.abort({ session_id })).toEqual({ session_id, aborted: false });
  });

  it("drops an aborted prepared controller that submit never claimed", () => {
    const prompts = create_serve_prompt_service(idle_agent(), empty_store());
    const session_id = "queued";
    const controller = prompts.prepare_submit!(session_id);
    expect(prompts.abort({ session_id })).toEqual({ session_id, aborted: true });
    expect(controller.signal.aborted).toBe(true);
    prompts.release_submit!(session_id, controller);
    expect(prompts.abort({ session_id })).toEqual({ session_id, aborted: false });
  });
});
