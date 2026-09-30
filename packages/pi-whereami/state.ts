import { stripVTControlCharacters } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const INTERVALS = [12, 8, 6, 4] as const;
export const REQUEST_TYPE = "pi-whereami-request"; // Legacy sessions only.
export const CHECK_TYPE = "pi-whereami-check";
export const CHECK_RESPONSE_TYPE = "pi-whereami-response";
export const SNAPSHOT_TYPE = "pi-whereami";
export const TOOL_NAME = "whereami_snapshot";

type SessionMessage = Extract<SessionEntry, { type: "message" }>["message"];

export function hasTaskToolCall(message: SessionMessage): boolean {
  return message.role === "assistant" && message.content.some(
    (part) => part.type === "toolCall" && part.name !== TOOL_NAME,
  );
}

/** One completed main-task response is one decision, regardless of batch size. */
export function isDecision(message: SessionMessage, snapshotRequested = false): boolean {
  if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return false;
  // A requested response with no task tools is collection only, even when the
  // snapshot is missing/malformed or the model includes text/thinking.
  return !snapshotRequested || hasTaskToolCall(message);
}

export interface TriggerState {
  stage: number;
  decisionsSinceCheck: number;
}

export function freshState(): TriggerState {
  return { stage: 0, decisionsSinceCheck: 0 };
}

export function advance(state: TriggerState, canCheck = true): boolean {
  state.decisionsSinceCheck++;
  if (!canCheck || state.decisionsSinceCheck < INTERVALS[state.stage]) return false;
  state.decisionsSinceCheck = 0;
  state.stage = Math.min(state.stage + 1, INTERVALS.length - 1);
  return true;
}

/** Restore the active path only; abandoned branches never contribute to this counter. */
export function restoreState(branch: readonly SessionEntry[]): TriggerState {
  const state = freshState();
  // These entries follow the response at its safe boundary. Resolve them first
  // so an interrupted request does not exempt unrelated work after resume.
  const requestedResponses = new Set<string>();
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === CHECK_RESPONSE_TYPE &&
      typeof (entry.data as { messageEntryId?: unknown } | undefined)?.messageEntryId === "string") {
      requestedResponses.add((entry.data as { messageEntryId: string }).messageEntryId);
    }
  }
  let legacyRequest = false;
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "user") {
      state.stage = 0;
      state.decisionsSinceCheck = 0;
      legacyRequest = false;
    } else if (entry.type === "custom" && entry.customType === CHECK_TYPE &&
      typeof (entry.data as { stage?: unknown } | undefined)?.stage === "number" &&
      Number.isInteger((entry.data as { stage: number }).stage) &&
      (entry.data as { stage: number }).stage >= 0 && (entry.data as { stage: number }).stage < INTERVALS.length) {
      // A check consumes the interval even when no valid snapshot follows.
      state.stage = (entry.data as { stage: number }).stage;
      state.decisionsSinceCheck = 0;
      // Old checks lack response IDs. Keep their consumed stage and infer only
      // their immediate response; new checks use explicit response markers.
      legacyRequest = (entry.data as { unit?: unknown }).unit !== "decision";
    } else if (entry.type === "custom_message" && entry.customType === REQUEST_TYPE) {
      // Older sessions persisted requests instead of non-context checkpoints.
      state.stage = Math.min(state.stage + 1, INTERVALS.length - 1);
      state.decisionsSinceCheck = 0;
      legacyRequest = true;
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      if (isDecision(entry.message, legacyRequest || requestedResponses.has(entry.id))) state.decisionsSinceCheck++;
      legacyRequest = false;
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

export interface HudSnapshot {
  fields: Required<SnapshotFields>;
  previousInput: boolean;
}

/** Read only the plugin's fixed durable format; malformed history is skipped. */
export function parseSnapshot(content: unknown): Required<SnapshotFields> | undefined {
  if (typeof content !== "string") return undefined;
  const match = /^\[whereami\]\n\nLevel: ([^\r\n]+)\nScope: ([^\r\n]+)\nState: ([^\r\n]+)\nNext: ([^\r\n]+)$/.exec(content);
  if (!match) return undefined;
  const fields = { level: match[1], scope: match[2], state: match[3], next: match[4] };
  return formatSnapshot(fields) ? fields : undefined;
}

/** The HUD follows the current branch, never a snapshot from a sibling path. */
export function restoreHudSnapshot(branch: readonly SessionEntry[]): HudSnapshot | undefined {
  let snapshot: HudSnapshot | undefined;
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "user") {
      if (snapshot) snapshot.previousInput = true;
    } else if (entry.type === "custom_message" && entry.customType === SNAPSHOT_TYPE) {
      const fields = parseSnapshot(entry.content);
      if (fields) snapshot = { fields, previousInput: false };
    }
  }
  return snapshot;
}

/** The panel is a view of the last snapshot, not another model-context message. */
export function formatHud(snapshot: HudSnapshot | undefined, triggerState: TriggerState, updating: boolean): string[] {
  const title = updating ? "Updating snapshot" : !snapshot || snapshot.previousInput
    ? `Awaiting ${snapshot ? "current" : "first"} snapshot · Decisions ${triggerState.decisionsSinceCheck}/${INTERVALS[triggerState.stage]}`
    : "Latest snapshot";
  if (!snapshot) return [`whereami · ${title}`];
  // Keep terminal control sequences out of the widget. The durable snapshot
  // remains unchanged, and the host handles ordinary wrapping and styling.
  const plain = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  const { level, scope, state, next } = snapshot.fields;
  return [
    `whereami · ${title}`,
    `${snapshot.previousInput ? "History · " : ""}Level: ${plain(level)} · Scope: ${plain(scope)}`,
    `State: ${plain(state)}`,
    `Next: ${plain(next)}`,
  ];
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
