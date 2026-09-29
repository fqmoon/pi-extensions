import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { REQUEST_TYPE, SNAPSHOT_TYPE, TOOL_NAME } from "../state.ts";

// The monorepo has an older local PI installation. Resolve pi-ai from the
// host PI dependency tree for this test; extension imports remain normal.
let piAi: string;
try {
  piAi = import.meta.resolve("@earendil-works/pi-ai");
} catch {
  piAi = new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier === "@earendil-works/pi-ai" ? piAi : specifier, context);
  },
});
const { default: whereami } = await import("../index.ts");

function harness(sessionManager = SessionManager.inMemory("/tmp")) {
  const handlers = new Map<string, Function[]>();
  let tool: any;
  let toolAvailable = true;
  let pendingMessages = false;
  whereami({
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(definition: unknown) { tool = definition; },
    getActiveTools() { return toolAvailable ? [TOOL_NAME] : []; },
    setActiveTools(names: string[]) { toolAvailable = names.includes(TOOL_NAME); },
  } as any);
  const ctx = { sessionManager, model: { id: "test-model" }, hasPendingMessages: () => pendingMessages };
  const emit = async (name: string, event: any = {}) => {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  const boundary = async (toolResults: any[], outcome = "completed") => {
    const result = await emit("turn_end", { entries: [], toolResults, outcome });
    for (const entry of result?.entries ?? []) {
      if (entry.type === "custom_message") sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display);
    }
    return result;
  };
  const actions = (n: number) => Array.from({ length: n }, (_, i) => ({ role: "toolResult", toolName: "read", toolCallId: `id-${i}`, isError: false }));
  return { ctx, emit, boundary, actions, setToolAvailable(available: boolean) { toolAvailable = available; }, setPendingMessages(pending: boolean) { pendingMessages = pending; }, get tool() { return tool; } };
}

test("tool batch requests one check; main model tool writes exactly one custom snapshot and keeps working", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("message_start", { message: { role: "user" } });
  assert.equal(await h.boundary(h.actions(11)), undefined);
  const triggered = await h.boundary(h.actions(1));
  assert.equal(triggered.continue, true);
  assert.equal(triggered.entries[0].customType, REQUEST_TYPE);
  assert.equal(triggered.entries[0].display, false);
  const response = await h.tool.execute("check-1", { level: "module", scope: "renderer", state: "dirty propagation is likely", next: "inspect invalidation" });
  const after = await h.boundary([{ role: "toolResult", toolCallId: "check-1", toolName: TOOL_NAME, isError: false, details: response.details }]);
  assert.equal(after.entries[0].customType, SNAPSHOT_TYPE);
  assert.equal(after.entries[0].display, true);
  assert.equal(after.continue, undefined); // Normal tool-follow-up, not a forced steering turn.
  const branch = h.ctx.sessionManager.getBranch();
  assert.equal(branch.filter((entry: any) => entry.customType === SNAPSHOT_TYPE).length, 1);
  assert.equal(h.ctx.sessionManager.buildSessionContext().messages.at(-1)?.role, "custom");
  assert.equal(await h.boundary(h.actions(7)), undefined);
  assert.equal((await h.boundary(h.actions(1)))?.continue, true); // next interval is 8
});

test("bad fields and failed checks do not interrupt the task; user resets at deep stage", async () => {
  const h = harness();
  await h.emit("session_start");
  for (const n of [12, 8, 6, 4]) {
    assert.equal((await h.boundary(h.actions(n)))?.continue, true);
    const malformed = await h.tool.execute("bad", { scope: "renderer" });
    assert.equal(malformed.details.snapshot, undefined);
    assert.equal(await h.boundary([{ role: "toolResult", toolName: TOOL_NAME, isError: false, details: malformed.details }]), undefined);
  }
  // A failed sampling turn (no tool called) is allowed to finish normally.
  assert.equal((await h.boundary(h.actions(4)))?.continue, true);
  assert.equal(await h.boundary([]), undefined);
  h.setPendingMessages(true);
  assert.equal(await h.boundary(h.actions(12)), undefined); // old run, before queued input is delivered
  h.setPendingMessages(false);
  await h.emit("message_start", { message: { role: "user" } });
  assert.equal(await h.boundary(h.actions(11)), undefined);
  await h.emit("message_start", { message: { role: "custom" } });
  assert.equal((await h.boundary(h.actions(1)))?.continue, true); // custom is not a reset
});

test("handled input does not suppress checks or reset the counting interval", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal(await h.boundary(h.actions(11)), undefined);
  await h.emit("input", { source: "interactive", text: ":status" }); // another extension handles it
  assert.equal((await h.boundary(h.actions(1)))?.continue, true);
});

test("error turns do not force sampling, but their task tool calls still count", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal(await h.boundary(h.actions(11), "error"), undefined);
  assert.equal((await h.boundary(h.actions(1)))?.continue, true);
});

test("an older session's tool loadout activates the plugin; later unavailability cannot interrupt the task", async () => {
  const h = harness();
  h.setToolAvailable(false);
  await h.emit("session_start");
  assert.equal((await h.boundary(h.actions(12)))?.continue, true);
  await h.emit("message_start", { message: { role: "user" } });
  h.setToolAvailable(false);
  assert.equal(await h.boundary(h.actions(12)), undefined);
  h.setToolAvailable(true);
  assert.equal((await h.boundary(h.actions(1)))?.continue, true);
});

test("session file resume and branch keep the snapshot in history without polluting sibling branches", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-whereami-"));
  try {
    const manager = SessionManager.create(dir, dir);
    // PI flushes a session file only once it contains a real assistant response.
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Work in progress" }], timestamp: Date.now(), stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } as any);
    const anchor = manager.appendCustomMessageEntry("anchor", "other context", true);
    const snapshot = manager.appendCustomMessageEntry(SNAPSHOT_TYPE, "[whereami]\n\nLevel: module\nScope: renderer\nState: likely invalidation\nNext: inspect boundary", true);
    const path = manager.getSessionFile()!;
    const resumed = SessionManager.open(path);
    assert.equal(resumed.getBranch().some((entry) => entry.id === snapshot), true);
    assert.equal(resumed.buildSessionContext().messages.at(-1)?.role, "custom");
    resumed.branch(anchor);
    assert.equal(resumed.getBranch().some((entry) => entry.id === snapshot), false);
    resumed.appendCustomMessageEntry(SNAPSHOT_TYPE, "[whereami]\n\nLevel: file\nScope: second branch\nState: unknown\nNext: inspect", true);
    assert.equal(resumed.getBranch().some((entry) => entry.id === snapshot), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
