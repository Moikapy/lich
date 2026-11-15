import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { build_serve_schema, serve_schema_path } from "../scripts/serve_schema.js";
import { SERVE_METHODS } from "../src/serve/protocol.js";

describe("serve protocol JSON Schema", () => {
  it("checked-in schema matches src/serve/protocol.ts (run `bun scripts/serve_schema.ts`)", () => {
    expect(readFileSync(serve_schema_path, "utf8")).toBe(build_serve_schema());
  }, 60_000);

  it("pins each request method to that method's params and result", () => {
    const { definitions } = JSON.parse(readFileSync(serve_schema_path, "utf8"));
    const map = definitions.ServeMethodMap.properties;
    for (const method of SERVE_METHODS) {
      const request = definitions.ServeRequest.anyOf.find(
        (entry: { properties: { method: { const: string } } }) => entry.properties.method.const === method,
      );
      expect(request.properties.params).toEqual(map[method].properties.params);
      expect(request.required).toEqual(["jsonrpc", "id", "method", "params"]);
      expect(request.additionalProperties).toBe(false);
    }
    expect(
      definitions.ServeSuccess.anyOf.map((entry: { properties: { result: unknown } }) => entry.properties.result),
    ).toEqual(SERVE_METHODS.map((method) => map[method].properties.result));
  });

  it("covers every method and the event notification", () => {
    const { definitions } = JSON.parse(readFileSync(serve_schema_path, "utf8"));
    expect(definitions.ServeMethod.enum).toEqual([...SERVE_METHODS]);
    expect(Object.keys(definitions.ServeMethodMap.properties)).toEqual([...SERVE_METHODS]);
    expect(definitions).toHaveProperty("ServeEventNotification");
    expect(definitions).toHaveProperty("AgentEvent");
    expect(definitions.ServeRequest.anyOf.map((r: any) => r.properties.method.const)).toEqual([...SERVE_METHODS]);
    expect(definitions.ServeSuccess.anyOf).toHaveLength(SERVE_METHODS.length);
  });

  it("constrains the root to a serve frame", () => {
    const schema = JSON.parse(readFileSync(serve_schema_path, "utf8"));
    expect(schema.$ref).toBe("#/definitions/ServeFrame");
    expect(schema.definitions.ServeFrame.anyOf.map((r: any) => r.$ref)).toEqual([
      "#/definitions/ServeRequest",
      "#/definitions/ServeSuccess",
      "#/definitions/JsonRpcError",
      "#/definitions/ServeEventNotification",
    ]);
  });
});
