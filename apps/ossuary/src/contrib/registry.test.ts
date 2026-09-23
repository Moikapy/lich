import { beforeEach, describe, expect, it } from "vitest";
import {
  ContribRegistry,
  contrib_registry,
  register_pane,
  list_panes,
  type PaneContributionInput,
} from "./registry";
import { register_core_contributions } from "./register_core";

function stub_render(): null {
  return null;
}

function pane(
  id: string,
  placement: "main" | "left" | "right" | "bottom" = "main",
): PaneContributionInput {
  return {
    id,
    title: id,
    data: { placement },
    render: stub_render,
  };
}

describe("contrib registry", () => {
  let registry: ContribRegistry;

  beforeEach(() => {
    registry = new ContribRegistry();
  });

  it("registers and lists panes in registration order", () => {
    registry.register_pane(pane("lich.chat", "main"));
    registry.register_pane(pane("lich.tool_log", "right"));
    registry.register({
      id: "other.commands",
      area: "commands",
      title: "Commands",
      data: {},
      render: stub_render,
    });

    const panes = registry.list_panes();
    expect(panes.map((item) => item.id)).toEqual(["lich.chat", "lich.tool_log"]);
    expect(panes[0]?.area).toBe("panes");
    expect(panes[0]?.data).toEqual({ placement: "main" });
    expect(registry.list("panes")).toHaveLength(2);
    expect(registry.list("commands")).toHaveLength(1);
    expect(registry.list("missing")).toEqual([]);
  });

  it("rejects duplicate contribution ids", () => {
    registry.register_pane(pane("lich.chat"));
    expect(() => registry.register_pane(pane("lich.chat", "left"))).toThrow(
      /duplicate_contribution: lich\.chat/,
    );
  });

  it("preserves registration order within an area", () => {
    registry.register_pane(pane("a", "left"));
    registry.register_pane(pane("b", "main"));
    registry.register_pane(pane("c", "bottom"));
    expect(registry.list_panes().map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("directs panes area registrations to the typed pair", () => {
    expect(() =>
      registry.register({
        id: "lich.chat",
        area: "panes",
        title: "Chat",
        data: { placement: "main" },
        render: stub_render,
      }),
    ).toThrow(/panes must register via register_pane\(\)/);
    expect(registry.get("lich.chat")).toBeUndefined();
  });

  it("keeps panes and other areas in one id namespace", () => {
    registry.register_pane(pane("lich.chat"));
    expect(() =>
      registry.register({
        id: "lich.chat",
        area: "commands",
        title: "Chat",
        data: {},
        render: stub_render,
      }),
    ).toThrow(/duplicate_contribution: lich\.chat/);
  });
});

describe("core contributions", () => {
  beforeEach(() => {
    contrib_registry.clear();
  });

  it("registers lich.chat as the main pane", () => {
    register_core_contributions();
    const panes = list_panes();
    expect(panes.map((item) => item.id)).toEqual(["lich.chat"]);
    expect(panes[0]?.data.placement).toBe("main");
  });

  it("is idempotent under HMR-style re-registration", () => {
    register_core_contributions();
    expect(() => register_core_contributions()).not.toThrow();
    expect(list_panes()).toHaveLength(1);
  });

  it("re-registers after clear()", () => {
    register_core_contributions();
    contrib_registry.clear();
    expect(list_panes()).toEqual([]);
    register_core_contributions();
    expect(list_panes()).toHaveLength(1);
  });
});
