import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advance, formatSnapshot, freshState, INTERVALS, hasTaskToolCall, isDecision,
  CHECK_TYPE, CHECK_RESPONSE_TYPE, REQUEST_TYPE, restoreState, SNAPSHOT_TYPE, TOOL_NAME,
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

// Deliberately use the same response IDs across different branches only where
// their shared prefix is identical; restore receives the active path alone.
test("12 → 8 → 6 → 4 → 4 decision intervals and reset", () => {
  const state = freshState();
  for (const [stage, interval] of [12, 8, 6, 4, 4].entries()) {
    assert.equal(INTERVALS[state.stage], interval);
    for (let i = 1; i < interval; i++) assert.equal(advance(state), false);
    assert.equal(advance(state), true);
    assert.deepEqual(state, { stage: Math.min(stage + 1, 3), decisionsSinceCheck: 0 });
  }
  assert.deepEqual(freshState(), { stage: 0, decisionsSinceCheck: 0 });
});

test("counting a final response does not consume the check stage", () => {
  const state = freshState();
  for (let i = 0; i < 12; i++) assert.equal(advance(state, false), false);
  assert.deepEqual(state, { stage: 0, decisionsSinceCheck: 12 });
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
    { type: "custom_message", customType: SNAPSHOT_TYPE }, ...turns(8, "b"), check(2),
    assistant("s2"), response("s2"), ...turns(6, "c"), check(3), assistant("s3", [TOOL_NAME]), response("s3"),
    ...turns(4, "d"), check(3), assistant("s4", [TOOL_NAME]), response("s4"), ...turns(2, "e")];
  assert.deepEqual(restoreState(branch as any), { stage: 3, decisionsSinceCheck: 2 });
  assert.deepEqual(restoreState([...branch, user] as any), freshState());
  assert.deepEqual(restoreState(branch.slice(0, 6) as any), { stage: 0, decisionsSinceCheck: 5 });
  const results = Array(20).fill({ type: "message", message: { role: "toolResult", toolName: "read" } });
  assert.deepEqual(restoreState([user, assistant("batch", Array(20).fill("read")), ...results] as any),
    { stage: 0, decisionsSinceCheck: 1 });
});

test("requested text is exempt, mixed work counts, and context edits do not alter replay", () => {
  const branch = [user, check(1), assistant("text"), response("text"),
    assistant("mixed", [TOOL_NAME, "read"]), response("mixed"),
    { type: "context_edit", targetId: "text", replacement: null },
    assistant("error", ["read"], "error"), assistant("aborted", ["read"], "aborted"), assistant("final")];
  assert.deepEqual(restoreState(branch as any), { stage: 1, decisionsSinceCheck: 2 });
});

test("an interrupted new check does not exempt ordinary work after resume", () => {
  assert.deepEqual(restoreState([user, check(1), assistant("next-final")] as any),
    { stage: 1, decisionsSinceCheck: 1 });
  // A branch ending before a response marker cannot inherit that marker from
  // a sibling that later completed collection.
  assert.deepEqual(restoreState([user, check(1), assistant("text")] as any),
    { stage: 1, decisionsSinceCheck: 1 });
  assert.deepEqual(restoreState([user, check(1), assistant("text"), response("text")] as any),
    { stage: 1, decisionsSinceCheck: 0 });
});

test("legacy checks keep consumed stages and rebuild subsequent decision counts", () => {
  const legacyCheck = { type: "custom", customType: CHECK_TYPE, data: { stage: 2 } };
  const legacyRequest = { type: "custom_message", customType: REQUEST_TYPE };
  const textSample = assistant("sample");
  const task = assistant("task", ["read", "grep", "bash"]);
  assert.deepEqual(restoreState([user, legacyCheck, textSample, task] as any), { stage: 2, decisionsSinceCheck: 1 });
  assert.deepEqual(restoreState([user, legacyRequest, textSample, task] as any), { stage: 1, decisionsSinceCheck: 1 });
  assert.deepEqual(restoreState([user, legacyCheck, task] as any), { stage: 2, decisionsSinceCheck: 1 });
  assert.deepEqual(restoreState([user, legacyCheck, user, assistant("new-final")] as any),
    { stage: 0, decisionsSinceCheck: 1 });
});

test("invalid snapshot fields are skipped, not filled in by the extension", () => {
  assert.equal(formatSnapshot({ level: "module", scope: "renderer", state: "likely dirty tracking", next: "inspect boundary" }),
    "[whereami]\n\nLevel: module\nScope: renderer\nState: likely dirty tracking\nNext: inspect boundary");
  assert.equal(formatSnapshot({ level: "file", scope: "renderer", state: "", next: "read" }), undefined);
  assert.equal(formatSnapshot({ level: "file", scope: "renderer\nother", state: "x", next: "read" }), undefined);
  assert.equal(formatSnapshot({ level: "file", scope: "renderer", state: "x", next: "x".repeat(161) }), undefined);
});
