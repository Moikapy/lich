import { describe, expect, it } from "vitest";
import type { PaneContribution } from "../contrib/registry";
import { build_dock_components, plan_pane_layout } from "./pane_layout";

function stub_render(): null {
  return null;
}

function pane(
  id: string,
  placement: PaneContribution["data"]["placement"],
  closable?: boolean,
): PaneContribution {
  return {
    id,
    area: "panes",
    title: id,
    data: { placement, closable },
    render: stub_render,
  };
}

describe("plan_pane_layout", () => {
  it("puts main first and docks others relative to it", () => {
    const planned = plan_pane_layout([
      pane("lich.scratch", "right"),
      pane("lich.chat", "main", false),
      pane("lich.tool_log", "bottom"),
    ]);

    expect(planned.map((item) => item.id)).toEqual([
      "lich.chat",
      "lich.scratch",
      "lich.tool_log",
    ]);
    expect(planned[0]).toMatchObject({
      id: "lich.chat",
      closable: false,
      component: "lich.chat",
    });
    expect(planned[0]?.position).toBeUndefined();
    expect(planned[1]?.position).toEqual({
      referencePanel: "lich.chat",
      direction: "right",
    });
    expect(planned[2]?.position).toEqual({
      referencePanel: "lich.chat",
      direction: "below",
    });
  });

  it("treats main placement as uncloseable by default", () => {
    const [main] = plan_pane_layout([pane("lich.chat", "main")]);
    expect(main?.closable).toBe(false);
  });

  it("allows explicit closable override on main", () => {
    const [main] = plan_pane_layout([pane("lich.chat", "main", true)]);
    expect(main?.closable).toBe(true);
  });
});

describe("build_dock_components", () => {
  it("maps contribution ids to render components", () => {
    const panes = [pane("lich.chat", "main"), pane("lich.scratch", "right")];
    const components = build_dock_components(panes);
    expect(Object.keys(components)).toEqual(["lich.chat", "lich.scratch"]);
    expect(typeof components["lich.chat"]).toBe("function");
  });
});
