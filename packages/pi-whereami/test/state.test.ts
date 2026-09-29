import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, formatSnapshot, freshState, INTERVALS, isAction, CHECK_TYPE, REQUEST_TYPE, restoreState, SNAPSHOT_TYPE, TOOL_NAME } from "../state.ts";

test("12 → 8 → 6 → 4 → 4, reset and no recursive snapshot action", () => {
  const state = freshState();
  for (const [stage, interval] of [12, 8, 6, 4, 4].entries()) {
    assert.equal(INTERVALS[state.stage], interval);
    for (let i = 1; i < interval; i++) assert.equal(advance(state), false);
    assert.equal(advance(state), true);
    assert.deepEqual(state, { stage: Math.min(stage + 1, 3), actionsSinceCheck: 0 });
  }
  assert.equal(isAction(TOOL_NAME), false);
  assert.equal(isAction("get_context_usage"), false);
  for (const tool of ["read", "grep", "find", "bash", "edit", "write", "multi_tool_use.parallel", "test", "build"]) {
    assert.equal(isAction(tool), true, tool);
  }
  assert.deepEqual(freshState(), { stage: 0, actionsSinceCheck: 0 });
});

test("branch replay tracks only current branch and resets at every user message", () => {
  const user = { type: "message", message: { role: "user" } };
  const action = { type: "message", message: { role: "toolResult", toolName: "read" } };
  const snapshotTool = { type: "message", message: { role: "toolResult", toolName: TOOL_NAME } };
  const check = (stage: number) => ({ type: "custom", customType: CHECK_TYPE, data: { stage } });
  const snapshot = { type: "custom_message", customType: SNAPSHOT_TYPE };
  const branch = [user, ...Array(12).fill(action), check(1), snapshotTool, snapshot, ...Array(8).fill(action), check(2), ...Array(6).fill(action), check(3), ...Array(4).fill(action), check(3), ...Array(2).fill(action)];
  assert.deepEqual(restoreState(branch as any), { stage: 3, actionsSinceCheck: 2 });
  assert.deepEqual(restoreState([...branch, user] as any), freshState());
  // Another leaf branched before the first check does not inherit checks on the old leaf.
  assert.deepEqual(restoreState([...branch.slice(0, 5), action] as any), { stage: 0, actionsSinceCheck: 5 });
  assert.deepEqual(restoreState([user, ...Array(12).fill(action), { type: "custom_message", customType: REQUEST_TYPE }] as any), { stage: 1, actionsSinceCheck: 0 });
});

test("invalid snapshot fields are skipped, not filled in by the extension", () => {
  assert.equal(formatSnapshot({ level: "module", scope: "renderer", state: "likely dirty tracking", next: "inspect boundary" }),
    "[whereami]\n\nLevel: module\nScope: renderer\nState: likely dirty tracking\nNext: inspect boundary");
  assert.equal(formatSnapshot({ level: "file", scope: "renderer", state: "", next: "read" }), undefined);
  assert.equal(formatSnapshot({ level: "file", scope: "renderer\nother", state: "x", next: "read" }), undefined);
  assert.equal(formatSnapshot({ level: "file", scope: "renderer", state: "x", next: "x".repeat(161) }), undefined);
});
