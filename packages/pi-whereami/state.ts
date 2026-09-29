import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const INTERVALS = [12, 8, 6, 4] as const;
export const REQUEST_TYPE = "pi-whereami-request";
export const SNAPSHOT_TYPE = "pi-whereami";
export const TOOL_NAME = "whereami_snapshot";

// Tools that do not advance the task. Other model-invoked tools count once per result.
const NON_ACTION_TOOLS = new Set([
  TOOL_NAME,
  "status",
  "get_status",
  "ui_status",
  "get_context_usage",
  "get_active_tools",
  "get_model",
  "list_models",
  "list_sessions",
]);

export function isAction(toolName: string): boolean {
  return !NON_ACTION_TOOLS.has(toolName);
}

export interface TriggerState {
  stage: number;
  actionsSinceCheck: number;
}

export function freshState(): TriggerState {
  return { stage: 0, actionsSinceCheck: 0 };
}

export function advance(state: TriggerState, count = 1): boolean {
  state.actionsSinceCheck += count;
  if (state.actionsSinceCheck < INTERVALS[state.stage]) return false;
  state.actionsSinceCheck = 0;
  state.stage = Math.min(state.stage + 1, INTERVALS.length - 1);
  return true;
}

/** Restore the active path only; abandoned branches never contribute to this counter. */
export function restoreState(branch: readonly SessionEntry[]): TriggerState {
  const state = freshState();
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "user") {
      state.stage = 0;
      state.actionsSinceCheck = 0;
    } else if (entry.type === "custom_message" && entry.customType === REQUEST_TYPE) {
      // A request consumes the interval whether or not the model produced a valid snapshot.
      state.stage = Math.min(state.stage + 1, INTERVALS.length - 1);
      state.actionsSinceCheck = 0;
    } else if (entry.type === "message" && entry.message.role === "toolResult" && isAction(entry.message.toolName)) {
      state.actionsSinceCheck++;
    }
  }
  return state;
}

export interface SnapshotFields {
  level?: string;
  scope?: string;
  state?: string;
  next?: string;
}

/** Never invent a missing field or persist an unbounded progress report. */
export function formatSnapshot(fields: SnapshotFields): string | undefined {
  const values = [fields.level, fields.scope, fields.state, fields.next];
  if (values.some((value) => typeof value !== "string" || !value.trim() || value.length > 160 || /[\r\n]/.test(value))) {
    return undefined;
  }
  const [level, scope, state, next] = values.map((value) => value!.trim());
  return `[whereami]\n\nLevel: ${level}\nScope: ${scope}\nState: ${state}\nNext: ${next}`;
}
