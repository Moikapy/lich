/**
 * Cross-pane active serve session binding.
 * Dockview mounts panes without a shared React tree, so Chat and Sessions
 * sync through this module instead of context.
 */

export type SessionBindSource = "auto_create" | "create" | "resume" | "clear";

export interface SessionBinding {
  session_id: string;
  source: SessionBindSource;
  /** Transcript id selected for resume (banner label; may differ from bag id). */
  resume_id?: string;
  message_count?: number;
  seq: number;
}

type Listener = (binding: SessionBinding) => void;

let current: SessionBinding | undefined;
const listeners = new Set<Listener>();

export function get_active_session(): SessionBinding | undefined {
  return current;
}

/** Publish a new active session; bumps `seq` so subscribers can react once. */
export function bind_active_session(
  next: Omit<SessionBinding, "seq">,
): SessionBinding {
  const binding: SessionBinding = { ...next, seq: (current?.seq ?? 0) + 1 };
  current = binding;
  for (const listener of listeners) {
    listener(binding);
  }
  return binding;
}

export function subscribe_active_session(listener: Listener): () => void {
  listeners.add(listener);
  if (current !== undefined) {
    listener(current);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper — reset module state between cases. */
export function reset_active_session(): void {
  current = undefined;
  listeners.clear();
}
