/** Decode serve `event` notification params into a WireAgentEvent. */
import { parse_wire_event } from "./parse_wire_event";
import { as_record } from "./wire_guards";
import type { WireAgentEvent } from "./types";

export interface ServeEventParams {
  session_id: string;
  event: WireAgentEvent;
}

/** Returns undefined when the notification is not a usable serve event. */
export function parse_serve_event_params(params: unknown): ServeEventParams | undefined {
  const record = as_record(params);
  if (record === undefined || typeof record.session_id !== "string") {
    return undefined;
  }
  const event = parse_wire_event(record.event);
  if (event === undefined) {
    return undefined;
  }
  return { session_id: record.session_id, event };
}
