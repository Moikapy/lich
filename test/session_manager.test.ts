import { describe, expect, it } from "vitest";
import { create_session_manager } from "../src/session/manager.js";

describe("session_manager", () => {
  it("serializes tasks for the same session id", async () => {
    const manager = create_session_manager();
    const order: string[] = [];

    const first = manager.enqueue("s1", async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("a-end");
      return "a";
    });
    const second = manager.enqueue("s1", async () => {
      order.push("b-start");
      order.push("b-end");
      return "b";
    });

    expect(await Promise.all([first, second])).toEqual(["a", "b"]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("runs different session ids concurrently", async () => {
    const manager = create_session_manager();
    let concurrent = 0;
    let peak = 0;

    const work = (id: string) =>
      manager.enqueue(id, async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 40));
        concurrent -= 1;
        return id;
      });

    const results = await Promise.all([work("a"), work("b"), work("c")]);
    expect(results.sort()).toEqual(["a", "b", "c"]);
    expect(peak).toBeGreaterThan(1);
  });
});
