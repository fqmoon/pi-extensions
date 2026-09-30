import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advance, formatCheckpoint, formatHud, parseCheckpoint, restoreHudCheckpoint, freshHudProgress, restoreHudProgress, freshState, DEFAULT_INTERVALS, intervalAt, hasTaskToolCall, isDecision,
  CHECK_TYPE, CHECK_RESPONSE_TYPE, REQUEST_TYPE, restoreState, CHECKPOINT_TYPE, TOOL_NAME,
} from "../state.ts";

const assistant = (id: string, tools: string[] = [], stopReason = "stop") => ({
  id, type: "message", message: {
    role: "assistant", stopReason,
    content: tools.length ? tools.map((name) => ({ type: "toolCall", name })) : [{ type: "text", text: "done" }],
  },
});
const user = { type: "message", message: { role: "user" } };
const check = (stage: number) => ({ type: "custom", customType: CHECK_TYPE, data: { stage, unit: "decision" } });
const response = (id: string) => ({ type: "custom", customType: CHECK_RESPONSE_TYPE, data: { messageEntryId: id } });
const legacySchedule = [12, 8, 6, 4] as const;

test("HUD parses durable checkpoints and ignores malformed history", () => {
  const fields = { level: "module", scope: "renderer", state: "dirty tracking", next: "inspect" };
  const checkpoint = { type: "custom_message", customType: CHECKPOINT_TYPE, content: formatCheckpoint(fields) };
  assert.deepEqual(parseCheckpoint(checkpoint.content), fields);
  for (const invalid of [undefined, [], "[whereami checkpoint]\n\nLevel: module", formatCheckpoint(fields)!.replace("Scope: renderer", "Scope: "),
    formatCheckpoint(fields)!.replace("State: dirty tracking", `State: ${"x".repeat(161)}`)]) {
    assert.equal(parseCheckpoint(invalid), undefined);
  }
  const malformed = { type: "custom_message", customType: CHECKPOINT_TYPE, content: "bad" };
  assert.deepEqual(restoreHudCheckpoint([checkpoint, malformed] as any), { fields, decision: 0 });
  assert.equal(restoreHudCheckpoint([checkpoint, user] as any), undefined);
  assert.equal(restoreHudCheckpoint([checkpoint, user, malformed] as any), undefined);
  assert.deepEqual(restoreHudCheckpoint([checkpoint, user, checkpoint] as any), { fields, decision: 0 });
  assert.equal(restoreHudCheckpoint([user] as any), undefined);
});

test("HUD shows the latest checkpoint decision and sanitizes only its display", () => {
  const state = { stage: 0, decisionsSinceCheck: 3 };
  assert.deepEqual(formatHud(undefined, state, { decisions: 3, checkpoints: 0 }), ["whereami · Decisions: 3/20 · Checkpoints: 0 · No checkpoint yet"]);
  assert.deepEqual(formatHud(undefined, { stage: 1, decisionsSinceCheck: 0 }, { decisions: 20, checkpoints: 0 }), ["whereami · Decisions: 20/35 · Checkpoints: 0 · No checkpoint yet"]);
  const fields = { level: "module", scope: "\x1b[31mrenderer\x1b[0m", state: "dirty tracking", next: "inspect" };
  const hud = { fields, decision: 2 };
  const lines = formatHud(hud, state, { decisions: 3, checkpoints: 1 });
  assert.equal(lines[0], "whereami · Decisions: 3/20 · Checkpoints: 1 · Checkpoint at decision 2");
  assert.equal(lines[1], "Level: module · Scope: renderer");
  assert.equal(fields.scope, "\x1b[31mrenderer\x1b[0m"); // Original durable data is untouched.
});

// Deliberately use the same response IDs across different branches only where
// their shared prefix is identical; restore receives the active path alone.
test("20 → 15 → 10 → 10 default intervals and custom schedules repeat their last value", () => {
  const state = freshState();
  for (const [stage, interval] of [20, 15, 10, 10].entries()) {
    assert.equal(intervalAt(DEFAULT_INTERVALS, state.stage), interval);
    for (let i = 1; i < interval; i++) assert.equal(advance(state), false);
    assert.equal(advance(state), true);
    assert.deepEqual(state, { stage: Math.min(stage + 1, 2), decisionsSinceCheck: 0 });
  }
  const custom = [3, 2] as const;
  assert.equal(intervalAt(custom, 0), 3);
  assert.equal(intervalAt(custom, 1), 2);
  assert.equal(intervalAt(custom, 99), 2);
  assert.deepEqual(freshState(), { stage: 0, decisionsSinceCheck: 0 });
});

test("counting a final response does not consume the check stage", () => {
  const state = freshState();
  for (let i = 0; i < 20; i++) assert.equal(advance(state, false), false);
  assert.deepEqual(state, { stage: 0, decisionsSinceCheck: 20 });
  assert.equal(advance(state), true);
  assert.deepEqual(state, { stage: 1, decisionsSinceCheck: 0 });
});

test("decision classification counts responses rather than tools or results", () => {
  for (const tools of [[], ["read"], Array(20).fill("read"), ["get_context_usage"], ["status"]]) {
    const message = assistant("task", tools).message;
    assert.equal(isDecision(message as any), true);
    assert.equal(hasTaskToolCall(message as any), tools.length > 0);
  }
  for (const tools of [[], [TOOL_NAME]]) {
    const message = assistant("sample", tools).message;
    assert.equal(isDecision(message as any, true), false);
  }
  assert.equal(isDecision(assistant("spontaneous-checkpoint", [TOOL_NAME]).message as any), false);
  assert.equal(isDecision(assistant("mixed", [TOOL_NAME, "read"]).message as any, true), true);
  assert.equal(isDecision(assistant("missing", ["read"]).message as any, true), true);
  for (const stopReason of ["error", "aborted"]) {
    assert.equal(isDecision(assistant("failed", ["read"], stopReason).message as any), false);
  }
  assert.equal(isDecision({ role: "toolResult", toolName: "read" } as any), false);
  assert.equal(isDecision(user.message as any), false);
});

test("branch replay counts assistant responses and resets at actual user messages", () => {
  const turns = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => assistant(`${prefix}-${i}`, ["read", "grep"]));
  const branch = [user, ...turns(12, "a"), check(1), assistant("s1", [TOOL_NAME]), response("s1"),
    { type: "custom_message", customType: CHECKPOINT_TYPE }, ...turns(8, "b"), check(2),
    assistant("s2"), response("s2"), ...turns(6, "c"), check(3), assistant("s3", [TOOL_NAME]), response("s3"),
    ...turns(4, "d"), check(3), assistant("s4", [TOOL_NAME]), response("s4"), ...turns(2, "e")];
  assert.deepEqual(restoreState(branch as any, legacySchedule), { stage: 3, decisionsSinceCheck: 2 });
  assert.deepEqual(restoreState([...branch, user] as any, legacySchedule), freshState());
  assert.deepEqual(restoreState(branch.slice(0, 6) as any, legacySchedule), { stage: 0, decisionsSinceCheck: 5 });
  const results = Array(20).fill({ type: "message", message: { role: "toolResult", toolName: "read" } });
  assert.deepEqual(restoreState([user, assistant("batch", Array(20).fill("read")), ...results] as any, legacySchedule),
    { stage: 0, decisionsSinceCheck: 1 });
});

test("requested text is exempt, mixed work counts, and context edits do not alter replay", () => {
  const branch = [user, check(1), assistant("text"), response("text"),
    assistant("mixed", [TOOL_NAME, "read"]), response("mixed"),
    { type: "context_edit", targetId: "text", replacement: null },
    assistant("error", ["read"], "error"), assistant("aborted", ["read"], "aborted"), assistant("final")];
  assert.deepEqual(restoreState(branch as any, legacySchedule), { stage: 1, decisionsSinceCheck: 2 });
});

test("an interrupted new check does not exempt ordinary work after resume", () => {
  assert.deepEqual(restoreState([user, check(1), assistant("next-final")] as any, legacySchedule),
    { stage: 1, decisionsSinceCheck: 1 });
  // A branch ending before a response marker cannot inherit that marker from
  // a sibling that later completed collection.
  assert.deepEqual(restoreState([user, check(1), assistant("text")] as any, legacySchedule),
    { stage: 1, decisionsSinceCheck: 1 });
  assert.deepEqual(restoreState([user, check(1), assistant("text"), response("text")] as any, legacySchedule),
    { stage: 1, decisionsSinceCheck: 0 });
});

test("legacy checks keep consumed stages and rebuild subsequent decision counts", () => {
  const legacyCheck = { type: "custom", customType: CHECK_TYPE, data: { stage: 2 } };
  const legacyRequest = { type: "custom_message", customType: REQUEST_TYPE };
  const textSample = assistant("sample");
  const task = assistant("task", ["read", "grep", "bash"]);
  assert.deepEqual(restoreState([user, legacyCheck, textSample, task] as any, legacySchedule), { stage: 2, decisionsSinceCheck: 1 });
  assert.deepEqual(restoreState([user, legacyRequest, textSample, task] as any, legacySchedule), { stage: 1, decisionsSinceCheck: 1 });
  assert.deepEqual(restoreState([user, legacyCheck, task] as any, legacySchedule), { stage: 2, decisionsSinceCheck: 1 });
  assert.deepEqual(restoreState([user, legacyCheck, user, assistant("new-final")] as any, legacySchedule),
    { stage: 0, decisionsSinceCheck: 1 });
});

test("invalid checkpoint fields are skipped, not filled in by the extension", () => {
  assert.equal(formatCheckpoint({ level: "module", scope: "renderer", state: "likely dirty tracking", next: "inspect boundary" }),
    "[whereami checkpoint]\n\nLevel: module\nScope: renderer\nState: likely dirty tracking\nNext: inspect boundary");
  assert.equal(formatCheckpoint({ level: "file", scope: "renderer", state: "", next: "read" }), undefined);
  assert.equal(formatCheckpoint({ level: "file", scope: "renderer\nother", state: "x", next: "read" }), undefined);
  assert.equal(formatCheckpoint({ level: "file", scope: "renderer", state: "x", next: "x".repeat(161) }), undefined);
});

test("HUD replay shares decision exemptions and counts only valid checkpoints after the latest user input", () => {
  const valid = { type: "custom_message", customType: CHECKPOINT_TYPE,
    content: formatCheckpoint({ level: "module", scope: "renderer", state: "dirty", next: "inspect" }) };
  const turns = (n: number) => Array.from({ length: n }, (_, i) => assistant(`task-${i}`, ["read"]));
  const branch = [user, ...turns(12), check(1), assistant("sample", [TOOL_NAME]), response("sample"), valid,
    assistant("mixed", [TOOL_NAME, "read"]), response("mixed"),
    { type: "custom_message", customType: CHECKPOINT_TYPE, content: "bad" },
    assistant("failed", ["read"], "error"), { type: "context_edit", targetId: "task-0", replacement: null }];
  const progress = restoreHudProgress(branch as any, legacySchedule);
  assert.deepEqual(progress, { decisions: 13, checkpoints: 1 });
  assert.deepEqual(restoreHudCheckpoint(branch as any, legacySchedule), {
    fields: { level: "module", scope: "renderer", state: "dirty", next: "inspect" },
    decision: 12,
  });
  assert.match(formatHud(restoreHudCheckpoint(branch as any, legacySchedule), restoreState(branch as any, legacySchedule), progress, legacySchedule)[0],
    /Decisions: 13\/20 · Checkpoints: 1 · Checkpoint at decision 12/);
  assert.deepEqual(restoreHudProgress([...branch, user] as any, legacySchedule), freshHudProgress());
  // A due check deferred by the actual trigger gate shifts the next threshold.
  const delayed = [user, ...turns(15), check(1), assistant("later", ["read"])];
  assert.match(formatHud(undefined, restoreState(delayed as any, legacySchedule), restoreHudProgress(delayed as any, legacySchedule), legacySchedule)[0], /Decisions: 16\/23/);
});
