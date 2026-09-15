export function safe_json_parse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function safe_stringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, null, space) ?? String(value);
  } catch {
    return String(value);
  }
}

export function truncate_text(text: string, max_chars: number): string {
  if (text.length <= max_chars) {
    return text;
  }
  const omitted = text.length - max_chars;
  return `${text.slice(0, max_chars)}\n[... truncated, ${omitted} chars omitted ...]`;
}