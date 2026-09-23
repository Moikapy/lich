import { describe, expect, it } from "vitest";
import {
  can_restore_layout,
  layout_component_ids,
  missing_registered_ids,
} from "./layout_persist";

const sample = {
  grid: { root: {}, height: 100, width: 200, orientation: "HORIZONTAL" },
  panels: {
    "lich.chat": { id: "lich.chat", contentComponent: "lich.chat", title: "Chat" },
    "lich.scratch": { id: "lich.scratch", contentComponent: "lich.scratch" },
  },
};

describe("layout_component_ids", () => {
  it("reads contentComponent values from panels", () => {
    expect(layout_component_ids(sample)).toEqual(["lich.chat", "lich.scratch"]);
  });

  it("returns null for corrupt shapes", () => {
    expect(layout_component_ids(null)).toBeNull();
    expect(layout_component_ids({ panels: {} })).toBeNull();
    expect(layout_component_ids({ grid: {}, panels: { a: "bad" } })).toBeNull();
  });
});

describe("can_restore_layout", () => {
  it("accepts layouts whose panels are all registered", () => {
    const registered = new Set(["lich.chat", "lich.scratch", "lich.tool_log"]);
    expect(can_restore_layout(sample, registered)).toBe(true);
  });

  it("accepts layouts that include Dockview popoutGroups (#93)", () => {
    const with_popout = {
      ...sample,
      popoutGroups: [
        {
          data: { id: "g1", views: ["lich.scratch"], activeView: "lich.scratch" },
          position: { left: 10, top: 10, width: 400, height: 300 },
          url: "/popout.html",
        },
      ],
    };
    const registered = new Set(["lich.chat", "lich.scratch"]);
    expect(can_restore_layout(with_popout, registered)).toBe(true);
  });

  it("rejects unknown panel ids so #90/#91 panes stay opt-in", () => {
    const registered = new Set(["lich.chat"]);
    expect(can_restore_layout(sample, registered)).toBe(false);
  });

  it("rejects empty or corrupt payloads", () => {
    const registered = new Set(["lich.chat"]);
    expect(can_restore_layout({ grid: {}, panels: {} }, registered)).toBe(false);
    expect(can_restore_layout("{broken", registered)).toBe(false);
  });
});

describe("missing_registered_ids", () => {
  it("lists registered panes absent from a saved layout", () => {
    const registered = new Set(["lich.chat", "lich.scratch", "lich.tool_log"]);
    expect(missing_registered_ids(sample, registered)).toEqual(["lich.tool_log"]);
  });

  it("returns null for corrupt payloads", () => {
    expect(missing_registered_ids(null, new Set(["lich.chat"]))).toBeNull();
  });
});
