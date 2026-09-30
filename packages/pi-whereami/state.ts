import { stripVTControlCharacters } from "node:util";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const DEFAULT_INTERVALS = [20, 15, 10] as const;
export type IntervalSchedule = readonly number[];

export function intervalAt(intervals: IntervalSchedule, stage: number): number {
  return intervals[Math.min(stage, intervals.length - 1)];
}
export const REQUEST_TYPE = "pi-whereami-request"; // Legacy sessions only.
export const CHECK_TYPE = "pi-whereami-check";
export const CHECK_RESPONSE_TYPE = "pi-whereami-response";
export const CHECKPOINT_TYPE = "pi-whereami-checkpoint";
export const TOOL_NAME = "whereami_checkpoint";

type SessionMessage = Extract<SessionEntry, { type: "message" }>["message"];

export function hasTaskToolCall(message: SessionMessage): boolean {
  return message.role === "assistant" && message.content.some(
    (part) => part.type === "toolCall" && part.name !== TOOL_NAME,
  );
}

/** One completed main-task response is one decision, regardless of batch size. */
export function isDecision(message: SessionMessage, checkpointRequested = false): boolean {
  if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return false;
  if (hasTaskToolCall(message)) return true;
  // A requested collection response is not a task decision, even when the
  // checkpoint is missing/malformed. A spontaneous checkpoint-only response is
  // also observation rather than task progress and must not move the trigger.
  if (checkpointRequested) return false;
  return !message.content.some((part) => part.type === "toolCall" && part.name === TOOL_NAME);
}

export interface TriggerState {
  stage: number;
  decisionsSinceCheck: number;
}

export function freshState(): TriggerState {
  return { stage: 0, decisionsSinceCheck: 0 };
}

export interface HudProgress {
  decisions: number;
  checkpoints: number;
}

export function freshHudProgress(): HudProgress {
  return { decisions: 0, checkpoints: 0 };
}

export function advance(state: TriggerState, canCheck = true, intervals: IntervalSchedule = DEFAULT_INTERVALS): boolean {
  state.decisionsSinceCheck++;
  if (!canCheck || state.decisionsSinceCheck < intervalAt(intervals, state.stage)) return false;
  state.decisionsSinceCheck = 0;
  state.stage = Math.min(state.stage + 1, intervals.length - 1);
  return true;
}

/** Restore the active path only; abandoned branches never contribute to this counter. */
function restoreBranch(branch: readonly SessionEntry[], intervals: IntervalSchedule = DEFAULT_INTERVALS): { state: TriggerState; progress: HudProgress; checkpoint?: HudCheckpoint } {
  const state = freshState();
  let progress = freshHudProgress();
  let checkpoint: HudCheckpoint | undefined;
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
      progress = freshHudProgress();
      checkpoint = undefined;
      legacyRequest = false;
    } else if (entry.type === "custom" && entry.customType === CHECK_TYPE &&
      typeof (entry.data as { stage?: unknown } | undefined)?.stage === "number" &&
      Number.isInteger((entry.data as { stage: number }).stage) &&
      (entry.data as { stage: number }).stage >= 0) {
      // A check consumes the interval even when no valid checkpoint follows.
      // Old sessions may have used a longer schedule; clamp them to the current last stage.
      state.stage = Math.min((entry.data as { stage: number }).stage, intervals.length - 1);
      state.decisionsSinceCheck = 0;
      // Old checks lack response IDs. Keep their consumed stage and infer only
      // their immediate response; new checks use explicit response markers.
      legacyRequest = (entry.data as { unit?: unknown }).unit !== "decision";
    } else if (entry.type === "custom_message" && entry.customType === REQUEST_TYPE) {
      // Older sessions persisted requests instead of non-context trigger checks.
      state.stage = Math.min(state.stage + 1, intervals.length - 1);
      state.decisionsSinceCheck = 0;
      legacyRequest = true;
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      if (isDecision(entry.message, legacyRequest || requestedResponses.has(entry.id))) {
        state.decisionsSinceCheck++;
        progress.decisions++;
      }
      legacyRequest = false;
    } else if (entry.type === "custom_message" && entry.customType === CHECKPOINT_TYPE) {
      const fields = parseCheckpoint(entry.content);
      if (fields) {
        progress.checkpoints++;
        checkpoint = { fields, decision: progress.decisions };
      }
    }
  }
  return { state, progress, checkpoint };
}

export function restoreState(branch: readonly SessionEntry[], intervals: IntervalSchedule = DEFAULT_INTERVALS): TriggerState {
  return restoreBranch(branch, intervals).state;
}

export function restoreHudProgress(branch: readonly SessionEntry[], intervals: IntervalSchedule = DEFAULT_INTERVALS): HudProgress {
  return restoreBranch(branch, intervals).progress;
}

export interface CheckpointFields {
  level?: string;
  scope?: string;
  state?: string;
  next?: string;
}

export interface HudCheckpoint {
  fields: Required<CheckpointFields>;
  decision: number;
}

/** Read only the plugin's fixed durable format; malformed history is skipped. */
export function parseCheckpoint(content: unknown): Required<CheckpointFields> | undefined {
  if (typeof content !== "string") return undefined;
  const match = /^\[whereami checkpoint\]\n\nLevel: ([^\r\n]+)\nScope: ([^\r\n]+)\nState: ([^\r\n]+)\nNext: ([^\r\n]+)$/.exec(content);
  if (!match) return undefined;
  const fields = { level: match[1], scope: match[2], state: match[3], next: match[4] };
  return formatCheckpoint(fields) ? fields : undefined;
}

/** Read the latest valid checkpoint and the decision count at which it was recorded. */
export function restoreHudCheckpoint(branch: readonly SessionEntry[], intervals: IntervalSchedule = DEFAULT_INTERVALS): HudCheckpoint | undefined {
  return restoreBranch(branch, intervals).checkpoint;
}

/** The panel is a view of recorded state, not collection progress. */
export function formatHud(checkpoint: HudCheckpoint | undefined, triggerState: TriggerState, progress: HudProgress, intervals: IntervalSchedule = DEFAULT_INTERVALS): string[] {
  const target = progress.decisions - triggerState.decisionsSinceCheck + intervalAt(intervals, triggerState.stage);
  const status = checkpoint ? `Checkpoint at decision ${checkpoint.decision}` : "No checkpoint yet";
  const header = `whereami · Decisions: ${progress.decisions}/${target} · Checkpoints: ${progress.checkpoints} · ${status}`;
  if (!checkpoint) return [header];
  // Keep terminal control sequences out of the widget. The durable checkpoint
  // remains unchanged, and the host handles ordinary wrapping and styling.
  const plain = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  const { level, scope, state, next } = checkpoint.fields;
  return [
    header,
    `Level: ${plain(level)} · Scope: ${plain(scope)}`,
    `State: ${plain(state)}`,
    `Next: ${plain(next)}`,
  ];
}

/** Never invent a missing field or persist an unbounded progress report. */
export function formatCheckpoint(fields: CheckpointFields): string | undefined {
  const values = [fields.level, fields.scope, fields.state, fields.next];
  if (values.some((value) => typeof value !== "string" || !value.trim() || value.length > 160 || /[\r\n]/.test(value))) {
    return undefined;
  }
  const [level, scope, state, next] = values.map((value) => value!.trim());
  return `[whereami checkpoint]\n\nLevel: ${level}\nScope: ${scope}\nState: ${state}\nNext: ${next}`;
}
