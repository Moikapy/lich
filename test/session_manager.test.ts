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

  it("drops idle session tails after release", async () => {
    const manager = create_session_manager();
    for (const id of ["s1", "s2", "s3"]) {
      await manager.enqueue(id, async () => "done");
    }
    expect(manager.pending_count()).toBe(0);

    let release_hold!: () => void;
    const hold = new Promise<void>((resolve) => {
      release_hold = resolve;
    });
    const pending = manager.enqueue("live", async () => {
      await hold;
      return "ok";
    });
    expect(manager.pending_count()).toBe(1);
    release_hold();
    await pending;
    expect(manager.pending_count()).toBe(0);
  });

  it("runs the next task on the same session after a rejection", async () => {
    const manager = create_session_manager();
    const first = manager.enqueue("s1", async () => {
      throw new Error("boom");
    });
    const second = manager.enqueue("s1", async () => "ok");
    const settled = await Promise.allSettled([first, second]);

    expect(settled[0]).toMatchObject({ status: "rejected" });
    if (settled[0].status === "rejected") {
      expect(settled[0].reason).toMatchObject({ message: "boom" });
    }
    expect(settled[1]).toEqual({ status: "fulfilled", value: "ok" });
    expect(manager.pending_count()).toBe(0);
  });

  it("keeps a follower queued so a later task cannot overlap it", async () => {
    const manager = create_session_manager();
    let release_holder!: () => void;
    const hold_holder = new Promise<void>((resolve) => {
      release_holder = resolve;
    });
    let release_follower!: () => void;
    const hold_follower = new Promise<void>((resolve) => {
      release_follower = resolve;
    });
    let mark_follower_started!: () => void;
    const follower_started = new Promise<void>((resolve) => {
      mark_follower_started = resolve;
    });
    let third_started = false;

    const holder = manager.enqueue("s1", async () => {
      await hold_holder;
      return "holder";
    });
    const follower = manager.enqueue("s1", async () => {
      mark_follower_started();
      await hold_follower;
      return "follower";
    });

    release_holder();
    await holder;
    await follower_started;
    expect(manager.pending_count()).toBe(1);

    const third = manager.enqueue("s1", async () => {
      third_started = true;
      return "third";
    });
    expect(third_started).toBe(false);

    release_follower();
    await expect(Promise.all([follower, third])).resolves.toEqual(["follower", "third"]);
    expect(third_started).toBe(true);
    expect(manager.pending_count()).toBe(0);
  });
});