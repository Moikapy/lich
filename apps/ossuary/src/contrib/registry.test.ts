import { describe, expect, it, beforeEach } from "vitest";
import { ContribRegistry, type Contribution } from "./registry";

function stub_render(): null {
  return null;
}

function pane(
  id: string,
  placement: "main" | "left" | "right" | "bottom" = "main",
): Contribution {
  return {
    id,
    area: "panes",
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

  it("registers and lists by area", () => {
    registry.register(pane("lich.chat", "main"));
    registry.register(pane("lich.tool_log", "right"));
    registry.register({
      id: "other.commands",
      area: "commands",
      title: "Commands",
      data: {},
      render: stub_render,
    });

    const panes = registry.list("panes");
    expect(panes.map((item) => item.id)).toEqual(["lich.chat", "lich.tool_log"]);
    expect(panes[0]?.data).toEqual({ placement: "main" });
    expect(registry.list("commands")).toHaveLength(1);
    expect(registry.list("missing")).toEqual([]);
  });

  it("rejects duplicate contribution ids", () => {
    registry.register(pane("lich.chat"));
    expect(() => registry.register(pane("lich.chat", "left"))).toThrow(
      /duplicate_contribution: lich\.chat/,
    );
  });

  it("preserves registration order within an area", () => {
    registry.register(pane("a", "left"));
    registry.register(pane("b", "main"));
    registry.register(pane("c", "bottom"));
    expect(registry.list("panes").map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});
