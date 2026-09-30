import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  advance,
  formatSnapshot,
  formatHud,
  freshState,
  hasTaskToolCall,
  isDecision,
  CHECK_TYPE,
  CHECK_RESPONSE_TYPE,
  restoreState,
  restoreHudSnapshot,
  parseSnapshot,
  type HudSnapshot,
  SNAPSHOT_TYPE,
  TOOL_NAME,
} from "./state.ts";

const DEFAULT_REORIENTATION_PROMPT = `Re-orient before continuing.

Review your current position in the task:
- What abstraction level and scope are you operating in?
- What is the main uncertainty or hypothesis currently driving the work?
- Has the recent work materially reduced that uncertainty or changed your understanding?
- Is the current path still the most informative way forward, or is it continuing mainly from momentum, local adjacency, or an outdated assumption?
- If a different abstraction level, competing hypothesis, or evidence source would resolve the important uncertainty more directly, prefer it.

If the current path remains the best path, keep it.
Do not change direction merely because this check occurred.`;

const SNAPSHOT_PROTOCOL = `After re-orienting, call ${TOOL_NAME} exactly once.
Record the position you now hold, not your reasoning process.
Use one short sentence per field: Level (repo/subsystem/module/call-chain/file/symbol), Scope, State, Next.
Do not report the re-orientation analysis separately. Continue the original task after the snapshot.`;

function loadReorientationPrompt(): string {
  try {
    const prompt = readFileSync(join(getAgentDir(), "whereami", "reorient.md"), "utf8");
    if (prompt.trim()) return prompt;
  } catch {
    // Missing or unreadable configuration must not interrupt the agent.
  }
  return DEFAULT_REORIENTATION_PROMPT;
}

export default function (pi: ExtensionAPI) {
  const request = `${loadReorientationPrompt().trimEnd()}\n\n${SNAPSHOT_PROTOCOL}`;
  let state = freshState();
  let awaitingSnapshot = false;
  let injectSnapshotRequest = false;
  let hudSnapshot: HudSnapshot | undefined;

  const updateHud = (ctx: ExtensionContext, clear = false) => {
    if (!ctx.hasUI) return;
    try {
      const lines = clear ? undefined : formatHud(hudSnapshot, state, awaitingSnapshot);
      if (lines && hudSnapshot?.previousInput) {
        for (let i = 1; i < lines.length; i++) lines[i] = ctx.ui.theme.fg("muted", lines[i]);
      }
      ctx.ui.setWidget("pi-whereami", lines, { placement: "aboveEditor" });
    } catch {
      // UI rendering must never prevent a trigger or snapshot from persisting.
    }
  };

  const clearRequest = () => {
    awaitingSnapshot = false;
    injectSnapshotRequest = false;
  };
  const reset = () => {
    state = freshState();
    clearRequest();
  };
  const restore = (branch: Parameters<typeof restoreState>[0]) => {
    state = restoreState(branch);
    // An interrupted request must not become a new autonomous run on resume.
    clearRequest();
  };

  const onSessionPath = (ctx: ExtensionContext) => {
    const branch = ctx.sessionManager.getBranch();
    restore(branch);
    hudSnapshot = restoreHudSnapshot(branch);
    updateHud(ctx);
    // PI can restore an older session's tool loadout without this newly installed tool.
    if (!pi.getActiveTools().includes(TOOL_NAME)) pi.setActiveTools([...pi.getActiveTools(), TOOL_NAME]);
  };
  pi.on("session_start", (_event, ctx) => onSessionPath(ctx));
  pi.on("session_tree", (_event, ctx) => onSessionPath(ctx));
  pi.on("session_shutdown", (_event, ctx) => updateHud(ctx, true));

  // Only a delivered user message starts a new counting interval.
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") {
      reset();
      if (hudSnapshot) hudSnapshot.previousInput = true;
      updateHud(ctx);
    }
  });

  pi.on("context", (event) => {
    if (!injectSnapshotRequest) return;
    injectSnapshotRequest = false;
    return {
      messages: [...event.messages, { role: "user", content: request, timestamp: Date.now() }],
    };
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "WhereAmI",
    description: "Record a brief position snapshot when requested by the whereami extension. Not a task action.",
    parameters: Type.Object({
      level: Type.String({ description: "Current abstraction level" }),
      scope: Type.String({ description: "Current problem area" }),
      state: Type.String({ description: "Current understanding, not reasoning" }),
      next: Type.String({ description: "Next key action" }),
    }),
    async execute(_toolCallId, params) {
      const snapshot = awaitingSnapshot ? formatSnapshot(params) : undefined;
      return {
        content: [{ type: "text", text: snapshot ? "Snapshot recorded; continue the task." : "No valid snapshot recorded; continue the task." }],
        details: { snapshot },
      };
    },
  });

  pi.on("turn_end", (event, ctx) => {
    // The boundary runs after the entire tool batch has been persisted. Never insert
    // a custom message between a tool call and its result (invalid on replay).
    const entries = [...event.entries];
    const snapshotRequested = awaitingSnapshot;
    if (awaitingSnapshot) {
      entries.push({ type: "custom", customType: CHECK_RESPONSE_TYPE, data: { messageEntryId: event.messageEntryId } });
      const snapshotIndex = event.toolResults.findIndex(
        (result) => result.toolName === TOOL_NAME && !result.isError &&
          typeof (result.details as { snapshot?: unknown } | undefined)?.snapshot === "string",
      );
      if (snapshotIndex >= 0) {
        const snapshot = (event.toolResults[snapshotIndex].details as { snapshot: string }).snapshot;
        // Only omit an assistant entry if it carries nothing but this snapshot call.
        // ID alignment can be lost if Pi could not persist one of the tool results.
        const result = event.toolResults[snapshotIndex];
        const snapshotOnly = event.toolResults.length === 1 && result.toolName === TOOL_NAME &&
          event.message.role === "assistant" && event.message.content.length === 1 &&
          event.message.content[0].type === "toolCall" &&
          event.message.content[0].name === TOOL_NAME &&
          event.message.content[0].id === result.toolCallId;
        const resultId = event.toolResultEntryIds.length === event.toolResults.length
          ? event.toolResultEntryIds[snapshotIndex] : undefined;
        const assistantEntry = ctx.sessionManager.getEntry(event.messageEntryId);
        const resultEntry = resultId ? ctx.sessionManager.getEntry(resultId) : undefined;
        if (snapshotOnly && resultId && assistantEntry?.type === "message" && assistantEntry.message.role === "assistant" &&
          resultEntry?.type === "message" && resultEntry.message.role === "toolResult" &&
          resultEntry.message.toolCallId === result.toolCallId) {
          entries.push({ type: "context_edit", targetId: event.messageEntryId, replacement: null });
          entries.push({ type: "context_edit", targetId: resultId, replacement: null });
        }
        entries.push({ type: "custom_message", customType: SNAPSHOT_TYPE, content: snapshot, display: true });
        const fields = parseSnapshot(snapshot);
        if (fields) {
          hudSnapshot = { fields, previousInput: false };
        }
      }
      clearRequest();
    }

    if (!isDecision(event.message, snapshotRequested)) {
      updateHud(ctx);
      return entries.length > event.entries.length ? { entries } : undefined;
    }
    // Count text/final responses too, but never revive a finished task merely
    // to collect a snapshot. Pending input and tool availability gate checks,
    // not decisions; this keeps live state and branch replay in agreement.
    const canCheck = event.outcome === "completed" && hasTaskToolCall(event.message) &&
      !ctx.hasPendingMessages() && pi.getActiveTools().includes(TOOL_NAME);
    if (!advance(state, canCheck)) {
      updateHud(ctx);
      return entries.length > event.entries.length ? { entries } : undefined;
    }
    entries.push({ type: "custom", customType: CHECK_TYPE, data: { stage: state.stage, unit: "decision" } });
    awaitingSnapshot = true;
    injectSnapshotRequest = true;
    updateHud(ctx);
    return { entries, continue: true };
  });

  pi.on("agent_before_settle", (_event, ctx) => {
    // Missing/malformed tool calls or an aborted continuation must not leave a request armed.
    clearRequest();
    updateHud(ctx);
  });
}
