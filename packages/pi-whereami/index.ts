import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  advance,
  formatSnapshot,
  freshState,
  isAction,
  REQUEST_TYPE,
  restoreState,
  SNAPSHOT_TYPE,
  TOOL_NAME,
} from "./state.ts";

const REQUEST = `Briefly describe your current position in the task by calling ${TOOL_NAME} once.
Use one short sentence per field: Level (repo/subsystem/module/call-chain/file/symbol), Scope, State, Next.
Describe the state you already hold; do not make a new plan or change direction because of this check.
Do not include a separate progress report. Continue the original task after the snapshot.`;

export default function (pi: ExtensionAPI) {
  let state = freshState();
  let awaitingSnapshot = false;
  let waitingForUserDelivery = false;

  const reset = () => {
    state = freshState();
    awaitingSnapshot = false;
  };
  const restore = (branch: Parameters<typeof restoreState>[0]) => {
    state = restoreState(branch);
    // An interrupted request must not become a new autonomous run on resume.
    awaitingSnapshot = false;
    waitingForUserDelivery = false;
  };

  const onSessionPath = (branch: Parameters<typeof restoreState>[0]) => {
    restore(branch);
    // PI can restore an older session's tool loadout without this newly installed tool.
    if (!pi.getActiveTools().includes(TOOL_NAME)) pi.setActiveTools([...pi.getActiveTools(), TOOL_NAME]);
  };
  pi.on("session_start", (_event, ctx) => onSessionPath(ctx.sessionManager.getBranch()));
  pi.on("session_tree", (_event, ctx) => onSessionPath(ctx.sessionManager.getBranch()));

  // Reset on submission even if the user queues input while the agent is working.
  // message_start also covers messages arriving from another extension or a queued prompt.
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      reset();
      // Old-run tools may still complete before a queued message is delivered.
      waitingForUserDelivery = true;
    }
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "user") {
      reset();
      waitingForUserDelivery = false;
    }
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "WhereAmI",
    description: "Record a brief position snapshot when requested by the whereami extension. Not a task action.",
    parameters: Type.Object({
      level: Type.Optional(Type.String({ description: "Current abstraction level" })),
      scope: Type.Optional(Type.String({ description: "Current problem area" })),
      state: Type.Optional(Type.String({ description: "Current understanding, not reasoning" })),
      next: Type.Optional(Type.String({ description: "Next key action" })),
    }),
    async execute(_toolCallId, params) {
      const snapshot = awaitingSnapshot ? formatSnapshot(params) : undefined;
      return {
        content: [{ type: "text", text: snapshot ? "Snapshot recorded; continue the task." : "No valid snapshot recorded; continue the task." }],
        details: { snapshot },
      };
    },
  });

  pi.on("turn_end", (event) => {
    // A queued user input supersedes the old autonomous run immediately, even
    // when its next tool batch finishes before PI delivers the new user message.
    if (waitingForUserDelivery) return;
    // The boundary runs after the entire tool batch has been persisted. Never insert
    // a custom message between a tool call and its result (invalid on replay).
    const entries = [...event.entries];
    if (awaitingSnapshot) {
      const snapshot = event.toolResults
        .filter((result) => result.toolName === TOOL_NAME && !result.isError)
        .map((result) => (result.details as { snapshot?: unknown } | undefined)?.snapshot)
        .find((value): value is string => typeof value === "string");
      if (snapshot) entries.push({ type: "custom_message", customType: SNAPSHOT_TYPE, content: snapshot, display: true });
      awaitingSnapshot = false;
    }

    const actionCount = event.toolResults.filter((result) => isAction(result.toolName)).length;
    if (actionCount === 0) return entries.length > event.entries.length ? { entries } : undefined;
    if (event.outcome !== "completed" || !pi.getActiveTools().includes(TOOL_NAME)) {
      // Completed tool calls still count, but an error or an unavailable snapshot
      // tool must never interrupt the main agent with an impossible request.
      state.actionsSinceCheck += actionCount;
      return entries.length > event.entries.length ? { entries } : undefined;
    }
    if (!advance(state, actionCount)) {
      return entries.length > event.entries.length ? { entries } : undefined;
    }
    // A hidden custom message is an extension request, not an actual user input.
    // PI will transform it into a user-role message for the provider.
    entries.push({ type: "custom_message", customType: REQUEST_TYPE, content: REQUEST, display: false });
    awaitingSnapshot = true;
    return { entries, continue: true };
  });

  pi.on("agent_before_settle", () => {
    // Missing/malformed tool calls should never keep the agent in a sampling loop.
    awaitingSnapshot = false;
  });
}
