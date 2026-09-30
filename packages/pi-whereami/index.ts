import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  advance,
  formatCheckpoint,
  formatHud,
  freshState,
  freshHudProgress,
  hasTaskToolCall,
  isDecision,
  CHECK_TYPE,
  CHECK_RESPONSE_TYPE,
  INTERVALS,
  restoreState,
  restoreHudProgress,
  restoreHudCheckpoint,
  parseCheckpoint,
  type HudCheckpoint,
  CHECKPOINT_TYPE,
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

const CHECKPOINT_PROTOCOL = `After re-orienting, call ${TOOL_NAME} exactly once.
Record a brief progress checkpoint: the position you now hold, not your reasoning process.
Use one short sentence per field: Level (repo/subsystem/module/call-chain/file/symbol), Scope, State, Next.
Do not report the re-orientation analysis separately. Continue the original task after the checkpoint.`;

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
  const request = `${loadReorientationPrompt().trimEnd()}\n\n${CHECKPOINT_PROTOCOL}`;
  let state = freshState();
  let awaitingCheckpoint = false;
  let injectCheckpointRequest = false;
  let hudCheckpoint: HudCheckpoint | undefined;
  let hudProgress = freshHudProgress();
  let hudVisible = false;
  let collectionTarget: number | undefined;

  const updateHud = (ctx: ExtensionContext, clear = false) => {
    if (!ctx.hasUI) return;
    try {
      const lines = clear || !hudVisible ? undefined : formatHud(hudCheckpoint, state, hudProgress, awaitingCheckpoint, collectionTarget);
      ctx.ui.setWidget("pi-whereami", lines, { placement: "aboveEditor" });
    } catch {
      // UI rendering must never prevent a trigger or checkpoint from persisting.
    }
  };

  const clearRequest = () => {
    awaitingCheckpoint = false;
    injectCheckpointRequest = false;
    collectionTarget = undefined;
  };
  const reset = () => {
    state = freshState();
    hudProgress = freshHudProgress();
    hudCheckpoint = undefined;
    clearRequest();
  };
  const restore = (branch: Parameters<typeof restoreState>[0]) => {
    state = restoreState(branch);
    hudProgress = restoreHudProgress(branch);
    // An interrupted request must not become a new autonomous run on resume.
    clearRequest();
  };

  const onSessionPath = (ctx: ExtensionContext) => {
    hudVisible = !ctx.isIdle();
    const branch = ctx.sessionManager.getBranch();
    restore(branch);
    hudCheckpoint = restoreHudCheckpoint(branch);
    updateHud(ctx);
    // PI can restore an older session's tool loadout without this newly installed tool.
    if (!pi.getActiveTools().includes(TOOL_NAME)) pi.setActiveTools([...pi.getActiveTools(), TOOL_NAME]);
  };
  pi.on("session_start", (_event, ctx) => onSessionPath(ctx));
  pi.on("session_tree", (_event, ctx) => onSessionPath(ctx));
  pi.on("session_shutdown", (_event, ctx) => updateHud(ctx, true));
  pi.on("agent_start", (_event, ctx) => {
    hudVisible = true;
    updateHud(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    // Keep the last position visible between runs.
    updateHud(ctx);
  });

  // Only a delivered user message starts a new counting interval.
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") {
      reset();
      updateHud(ctx);
    }
  });

  pi.on("context", (event) => {
    if (!injectCheckpointRequest) return;
    injectCheckpointRequest = false;
    return {
      messages: [...event.messages, { role: "user", content: request, timestamp: Date.now() }],
    };
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Checkpoint",
    description: "Record a brief progress checkpoint when requested by the whereami extension. Not a task action.",
    parameters: Type.Object({
      level: Type.String({ description: "Current abstraction level" }),
      scope: Type.String({ description: "Current problem area" }),
      state: Type.String({ description: "Current understanding, not reasoning" }),
      next: Type.String({ description: "Next key action" }),
    }),
    async execute(_toolCallId, params) {
      const checkpoint = awaitingCheckpoint ? formatCheckpoint(params) : undefined;
      return {
        content: [{ type: "text", text: checkpoint ? "Checkpoint recorded; continue the task." : "No valid checkpoint recorded; continue the task." }],
        details: { checkpoint },
      };
    },
  });

  pi.on("turn_end", (event, ctx) => {
    // The boundary runs after the entire tool batch has been persisted. Never insert
    // a custom message between a tool call and its result (invalid on replay).
    const entries = [...event.entries];
    const checkpointRequested = awaitingCheckpoint;
    if (awaitingCheckpoint) {
      entries.push({ type: "custom", customType: CHECK_RESPONSE_TYPE, data: { messageEntryId: event.messageEntryId } });
      const checkpointIndex = event.toolResults.findIndex(
        (result) => result.toolName === TOOL_NAME && !result.isError &&
          typeof (result.details as { checkpoint?: unknown } | undefined)?.checkpoint === "string",
      );
      if (checkpointIndex >= 0) {
        const checkpoint = (event.toolResults[checkpointIndex].details as { checkpoint: string }).checkpoint;
        // Only omit an assistant entry if it carries nothing but this checkpoint call.
        // ID alignment can be lost if Pi could not persist one of the tool results.
        const result = event.toolResults[checkpointIndex];
        const checkpointOnly = event.toolResults.length === 1 && result.toolName === TOOL_NAME &&
          event.message.role === "assistant" && event.message.content.length === 1 &&
          event.message.content[0].type === "toolCall" &&
          event.message.content[0].name === TOOL_NAME &&
          event.message.content[0].id === result.toolCallId;
        const resultId = event.toolResultEntryIds.length === event.toolResults.length
          ? event.toolResultEntryIds[checkpointIndex] : undefined;
        const assistantEntry = ctx.sessionManager.getEntry(event.messageEntryId);
        const resultEntry = resultId ? ctx.sessionManager.getEntry(resultId) : undefined;
        if (checkpointOnly && resultId && assistantEntry?.type === "message" && assistantEntry.message.role === "assistant" &&
          resultEntry?.type === "message" && resultEntry.message.role === "toolResult" &&
          resultEntry.message.toolCallId === result.toolCallId) {
          entries.push({ type: "context_edit", targetId: event.messageEntryId, replacement: null });
          entries.push({ type: "context_edit", targetId: resultId, replacement: null });
        }
        entries.push({ type: "custom_message", customType: CHECKPOINT_TYPE, content: checkpoint, display: true });
        const fields = parseCheckpoint(checkpoint);
        if (fields) {
          hudCheckpoint = { fields };
          hudProgress.checkpoints++;
        }
      }
      clearRequest();
    }

    if (!isDecision(event.message, checkpointRequested)) {
      updateHud(ctx);
      return entries.length > event.entries.length ? { entries } : undefined;
    }
    // Count text/final responses too, but never revive a finished task merely
    // to collect a checkpoint. Pending input and tool availability gate checks,
    // not decisions; this keeps live state and branch replay in agreement.
    const canCheck = event.outcome === "completed" && hasTaskToolCall(event.message) &&
      !ctx.hasPendingMessages() && pi.getActiveTools().includes(TOOL_NAME);
    const target = hudProgress.decisions - state.decisionsSinceCheck + INTERVALS[state.stage];
    hudProgress.decisions++;
    if (!advance(state, canCheck)) {
      updateHud(ctx);
      return entries.length > event.entries.length ? { entries } : undefined;
    }
    entries.push({ type: "custom", customType: CHECK_TYPE, data: { stage: state.stage, unit: "decision" } });
    awaitingCheckpoint = true;
    collectionTarget = target;
    injectCheckpointRequest = true;
    updateHud(ctx);
    return { entries, continue: true };
  });

  pi.on("agent_before_settle", (_event, ctx) => {
    // Missing/malformed tool calls or an aborted continuation must not leave a request armed.
    clearRequest();
    updateHud(ctx);
  });
}
