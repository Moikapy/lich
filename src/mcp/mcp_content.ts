export function content_text(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    return "";
  }
  const body = result as { content?: unknown; isError?: unknown };
  const parts: string[] = [];
  if (Array.isArray(body.content) === true) {
    for (const item of body.content) {
      if (typeof item !== "object" || item === null) {
        continue;
      }
      const chunk = item as { type?: unknown; text?: unknown };
      if (chunk.type === "text" && typeof chunk.text === "string") {
        parts.push(chunk.text);
      }
      if (chunk.type === "image") {
        parts.push("[image omitted]");
      }
    }
  }
  const text = parts.join("\n");
  if (body.isError === true) {
    throw new Error(text.length > 0 ? text : "mcp tool failed");
  }
  return text;
}
