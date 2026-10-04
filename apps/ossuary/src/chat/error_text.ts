/** Normalize unknown error payloads from wire AgentEvent.error. */
export function error_text(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  if (error !== null && typeof error === "object") {
    return "unknown error";
  }
  return String(error);
}
