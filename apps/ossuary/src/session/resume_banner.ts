/** Mirror TUI `resume_banner_line` for the sessions / chat panes. */
export function resume_banner_line(id: string, message_count: number): string {
  return `resumed ${id} (${message_count} messages)`;
}

/** Meta transcript block after a successful session.resume. */
export function resume_banner_block(
  id: string,
  message_count: number,
): { role: "meta"; lines: readonly string[] } {
  return { role: "meta", lines: [`\u00b7 ${resume_banner_line(id, message_count)}`] };
}
