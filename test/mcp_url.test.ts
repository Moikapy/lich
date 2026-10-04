/**
 * MCP HTTP entry guard: loopback allowlist, credential refusal, and non-HTTP schemes.
 */
import { describe, expect, it } from "vitest";
import { refuse_http_url } from "../src/mcp/mcp_url.js";

describe("refuse_http_url", () => {
  it("allows http and https on localhost and 127.0.0.1", () => {
    expect(refuse_http_url("http://127.0.0.1:9/mcp")).toBeUndefined();
    expect(refuse_http_url("https://127.0.0.1/mcp")).toBeUndefined();
    expect(refuse_http_url("http://localhost:3000/mcp")).toBeUndefined();
    expect(refuse_http_url("https://localhost/mcp")).toBeUndefined();
  });

  it("refuses credentials, remote hosts, and non-http schemes", () => {
    expect(refuse_http_url("http://user:secret@127.0.0.1/mcp")).toBe("refused mcp url credentials");
    expect(refuse_http_url("http://user@localhost/mcp")).toBe("refused mcp url credentials");
    expect(refuse_http_url("http://10.1.2.3/mcp")).toBe("refused mcp url; loopback only");
    expect(refuse_http_url("http://0.0.0.0/mcp")).toBe("refused mcp url; loopback only");
    expect(refuse_http_url("http://127.0.0.1.evil.example/mcp")).toBe("refused mcp url; loopback only");
    expect(refuse_http_url("http://[::1]/mcp")).toBe("refused mcp url; loopback only");
    expect(refuse_http_url("file:///tmp/mcp")).toBe("refused mcp url");
    expect(refuse_http_url("ws://127.0.0.1/mcp")).toBe("refused mcp url");
    expect(refuse_http_url("not a url")).toBe("refused mcp url");
  });
});
