import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { CHECK_TYPE, REQUEST_TYPE, SNAPSHOT_TYPE, TOOL_NAME } from "../state.ts";

// The monorepo has an older local PI installation. Resolve pi-ai from the
// host PI dependency tree for this test; extension imports remain normal.
let piAi: string;
try {
  piAi = import.meta.resolve("@earendil-works/pi-ai");
} catch {
  piAi = new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
}
const hostPiRoot = join(dirname(dirname(process.execPath)), "lib/node_modules/@earendil-works/pi-coding-agent");
const hostPiAi = pathToFileURL(join(hostPiRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-ai") {
      return nextResolve(context.parentURL?.startsWith(pathToFileURL(hostPiRoot).href) ? hostPiAi : piAi, context);
    }
    return nextResolve(specifier, context);
  },
});
const { default: whereami } = await import("../index.ts");
// The workspace lockfile predates context edits. Exercise the SDK targeted by
// this extension, falling back to the installed host Pi for this offline test.
const localPi = import.meta.resolve("@earendil-works/pi-coding-agent");
const [major, minor] = JSON.parse(readFileSync(new URL("../package.json", localPi), "utf8")).version.split(".").map(Number);
const modernPi = major > 0 || minor >= 87 ? localPi :
  pathToFileURL(join(hostPiRoot, "dist/index.js")).href;
const { SessionManager } = await import(modernPi);
const defaultAgentDir = mkdtempSync(join(tmpdir(), "pi-whereami-config-"));
after(() => rmSync(defaultAgentDir, { recursive: true, force: true }));

function harness(sessionManager = SessionManager.inMemory("/tmp"), agentDir = defaultAgentDir) {
  const handlers = new Map<string, Function[]>();
  let tool: any;
  let toolAvailable = true;
  let pendingMessages = false;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    whereami({
      on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      registerTool(definition: unknown) { tool = definition; },
      getActiveTools() { return toolAvailable ? [TOOL_NAME] : []; },
      setActiveTools(names: string[]) { toolAvailable = names.includes(TOOL_NAME); },
    } as any);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  const ctx = { sessionManager, model: { id: "test-model" }, hasPendingMessages: () => pendingMessages };
  const emit = async (name: string, event: any = {}) => {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  const boundary = async (toolResults: any[], outcome = "completed", blocks?: any[]) => {
    const results = toolResults.map((result, i) => ({
      ...result, role: "toolResult", toolCallId: result.toolCallId ?? `call-${i}`,
      content: result.content ?? [{ type: "text", text: "done" }], timestamp: Date.now(),
    }));
    const message = {
      role: "assistant", content: blocks ?? results.map((result) => ({
        type: "toolCall", id: result.toolCallId, name: result.toolName, arguments: {},
      })), timestamp: Date.now(), stopReason: outcome === "completed" ? "toolUse" : outcome,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    };
    const messageEntryId = sessionManager.appendMessage(message);
    const toolResultEntryIds = results.map((result) => sessionManager.appendMessage(result));
    const result = await emit("turn_end", { entries: [], message, toolResults: results, toolResultEntryIds, messageEntryId, outcome });
    for (const entry of result?.entries ?? []) {
      if (entry.type === "custom_message") sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display);
      if (entry.type === "custom") sessionManager.appendCustomEntry(entry.customType, entry.data);
      if (entry.type === "context_edit") sessionManager.appendContextEdit(entry.targetId, entry.replacement);
    }
    return result;
  };
  const actions = (n: number) => Array.from({ length: n }, (_, i) => ({ role: "toolResult", toolName: "read", toolCallId: `id-${i}`, isError: false }));
  return { ctx, emit, boundary, actions, setToolAvailable(available: boolean) { toolAvailable = available; }, setPendingMessages(pending: boolean) { pendingMessages = pending; }, get tool() { return tool; } };
}

async function injectedPrompt(h: ReturnType<typeof harness>): Promise<string> {
  await h.emit("session_start");
  assert.equal((await h.boundary(h.actions(12)))?.continue, true);
  const request = await h.emit("context", { messages: [] });
  return request.messages.at(-1).content;
}

test("missing reorient.md uses the built-in strategy and fixed protocol", async () => {
  const prompt = await injectedPrompt(harness());
  assert.match(prompt, /Re-orient before continuing/);
  assert.match(prompt, /What is the main uncertainty or hypothesis currently driving the work\?/);
  assert.match(prompt, /Has the recent work materially reduced that uncertainty or changed your understanding\?/);
  assert.match(prompt, /continuing mainly from momentum, local adjacency, or an outdated assumption\?/);
  assert.match(prompt, /would resolve the important uncertainty more directly, prefer it\./);
  assert.match(prompt, /If the current path remains the best path, keep it\./);
  assert.match(prompt, /call whereami_snapshot exactly once/);
  assert.match(prompt, /Level .* Scope, State, Next/);
});

test("user strategy replaces the default, retains the protocol, and is loaded once per extension", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-whereami-user-prompt-"));
  try {
    const file = join(dir, "whereami", "reorient.md");
    mkdirSync(dirname(file));
    writeFileSync(file, "CUSTOM REORIENT");
    const h = harness(undefined, dir);
    writeFileSync(file, "Do whatever you want.");
    const prompt = await injectedPrompt(h);
    assert.match(prompt, /CUSTOM REORIENT/);
    assert.doesNotMatch(prompt, /Re-orient before continuing/);
    assert.match(prompt, /call whereami_snapshot exactly once/);
    assert.match(prompt, /Level .* Scope, State, Next/);
    assert.equal(JSON.stringify(h.ctx.sessionManager.getBranch()).includes("CUSTOM REORIENT"), false);
    assert.equal((await h.emit("context", { messages: [] }))?.messages, undefined);
    const replaced = await injectedPrompt(harness(undefined, dir));
    assert.match(replaced, /Do whatever you want/);
    assert.match(replaced, /call whereami_snapshot exactly once/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blank or unreadable reorient.md falls back without failing the agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-whereami-fallback-"));
  try {
    const file = join(dir, "whereami", "reorient.md");
    mkdirSync(dirname(file));
    writeFileSync(file, " \n\t ");
    assert.match(await injectedPrompt(harness(undefined, dir)), /Re-orient before continuing/);
    rmSync(file);
    mkdirSync(file); // Reading a directory as a file fails even when tests run as root.
    assert.match(await injectedPrompt(harness(undefined, dir)), /Re-orient before continuing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool batch requests one check; main model tool writes exactly one custom snapshot and keeps working", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("message_start", { message: { role: "user" } });
  assert.equal(await h.boundary(h.actions(11)), undefined);
  const triggered = await h.boundary(h.actions(1));
  assert.equal(triggered.continue, true);
  assert.equal(triggered.entries[0].customType, CHECK_TYPE);
  assert.deepEqual(triggered.entries[0].data, { stage: 1 });
  assert.equal(h.ctx.sessionManager.getBranch().some((entry: any) => entry.customType === REQUEST_TYPE), false);
  const context = [{ role: "user", content: "real task", timestamp: 1 }];
  const requested = await h.emit("context", { messages: context });
  assert.match(requested.messages.at(-1).content, /Re-orient before continuing/);
  assert.match(requested.messages.at(-1).content, /whereami_snapshot/);
  assert.deepEqual((await h.emit("context", { messages: context }))?.messages, undefined);
  const response = await h.tool.execute("check-1", { level: "module", scope: "renderer", state: "dirty propagation is likely", next: "inspect invalidation" });
  const after = await h.boundary([{ role: "toolResult", toolCallId: "check-1", toolName: TOOL_NAME, isError: false, details: response.details }]);
  assert.deepEqual(after.entries.map((entry: any) => entry.type), ["context_edit", "context_edit", "custom_message"]);
  assert.equal(after.entries[2].customType, SNAPSHOT_TYPE);
  assert.equal(after.entries[2].display, true);
  assert.equal(after.continue, undefined); // Normal tool-follow-up, not a forced steering turn.
  const branch = h.ctx.sessionManager.getBranch();
  assert.equal(branch.filter((entry: any) => entry.customType === SNAPSHOT_TYPE).length, 1);
  assert.equal(branch.filter((entry: any) => entry.type === "context_edit").length, 2);
  assert.equal(branch.some((entry: any) => entry.type === "message" && entry.message.role === "assistant" &&
    entry.message.content.some((part: any) => part.name === TOOL_NAME)), true);
  assert.equal(branch.some((entry: any) => entry.type === "message" && entry.message.role === "toolResult" &&
    entry.message.toolName === TOOL_NAME), true);
  const projected = h.ctx.sessionManager.buildSessionContext().messages;
  assert.equal(projected.at(-1)?.role, "custom");
  assert.match(JSON.stringify(projected.at(-1)), /\[whereami\]/);
  assert.equal(projected.some((message: any) => message.role === "toolResult" && message.toolName === TOOL_NAME), false);
  assert.equal(projected.some((message: any) => message.role === "assistant" && message.content?.some((part: any) => part.name === TOOL_NAME)), false);
  assert.equal(JSON.stringify(branch).includes("Re-orient before continuing"), false);
  assert.equal(JSON.stringify(projected).includes("Re-orient before continuing"), false);
  assert.equal((await h.emit("context", { messages: projected }))?.messages, undefined);
  assert.equal(await h.boundary(h.actions(7)), undefined);
  assert.equal((await h.boundary(h.actions(1)))?.continue, true); // next interval is 8
});

test("mixed snapshot and task tool calls retain the whole task turn in context", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal((await h.boundary(h.actions(12)))?.continue, true);
  await h.emit("context", { messages: [] });
  const recorded = await h.tool.execute("sample", { level: "module", scope: "renderer", state: "dirty tracking", next: "inspect" });
  const after = await h.boundary([
    { toolName: TOOL_NAME, toolCallId: "sample", isError: false, details: recorded.details },
    { toolName: "read", toolCallId: "task", isError: false },
  ]);
  assert.deepEqual(after.entries.map((entry: any) => entry.type), ["custom_message"]);
  const context = h.ctx.sessionManager.buildSessionContext().messages;
  assert.equal(context.some((message: any) => message.role === "assistant" && message.content.some((part: any) => part.name === "read")), true);
  assert.equal(context.some((message: any) => message.role === "toolResult" && message.toolName === "read"), true);
  assert.equal(context.at(-1)?.role, "custom");
});

test("assistant text or unresolved result IDs prevent unsafe cleanup", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.boundary(h.actions(12));
  const recorded = await h.tool.execute("sample", { level: "module", scope: "renderer", state: "dirty tracking", next: "inspect" });
  const result = { role: "toolResult", toolName: TOOL_NAME, toolCallId: "sample", isError: false, details: recorded.details };
  const after = await h.boundary([result], "completed", [
    { type: "text", text: "Task progress" },
    { type: "toolCall", name: TOOL_NAME, id: "sample", arguments: {} },
  ]);
  assert.deepEqual(after.entries.map((entry: any) => entry.type), ["custom_message"]);
  await h.boundary(h.actions(8));
  const noIds = await h.emit("turn_end", {
    entries: [], outcome: "completed", toolResults: [result], messageEntryId: "missing", toolResultEntryIds: [],
    message: { role: "assistant", content: [{ type: "toolCall", name: TOOL_NAME, id: "sample", arguments: {} }] },
  });
  assert.deepEqual(noIds.entries.map((entry: any) => entry.type), ["custom_message"]);
});

test("required fields and invalid or interrupted checks never force a retry", async () => {
  const h = harness();
  assert.deepEqual(h.tool.parameters.required?.sort(), ["level", "next", "scope", "state"]);
  await h.emit("session_start");
  assert.equal((await h.boundary(h.actions(12)))?.continue, true);
  const malformed = await h.tool.execute("bad", { level: "module", scope: "renderer", state: "x\ny", next: "inspect" });
  assert.equal(malformed.details.snapshot, undefined);
  assert.equal(await h.boundary([{ toolName: TOOL_NAME, toolCallId: "bad", details: malformed.details }]), undefined);
  assert.equal(h.ctx.sessionManager.getBranch().some((entry: any) => entry.customType === SNAPSHOT_TYPE), false);
  assert.equal((await h.emit("context", { messages: [] }))?.messages, undefined);
  assert.equal((await h.boundary(h.actions(8)))?.continue, true);
  await h.emit("agent_before_settle");
  assert.equal((await h.emit("context", { messages: [] }))?.messages, undefined);
  assert.equal(await h.boundary([]), undefined);
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

test("resuming a session keeps checkpoint and context edits on their own branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-whereami-cleanup-"));
  try {
    const manager = SessionManager.create(dir, dir);
    const h = harness(manager);
    await h.emit("session_start");
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "task" }], timestamp: Date.now() });
    assert.equal((await h.boundary(h.actions(12)))?.continue, true);
    await h.emit("context", { messages: [] });
    const anchor = manager.getLeafId();
    const recorded = await h.tool.execute("sample", { level: "module", scope: "renderer", state: "dirty tracking", next: "inspect" });
    await h.boundary([{ toolName: TOOL_NAME, toolCallId: "sample", details: recorded.details }]);
    const path = manager.getSessionFile()!;
    const resumed = SessionManager.open(path);
    assert.equal(resumed.getBranch().filter((entry: any) => entry.type === "context_edit").length, 2);
    assert.equal(resumed.getBranch().filter((entry: any) => entry.customType === CHECK_TYPE).length, 1);
    const messages = resumed.buildSessionContext().messages;
    assert.equal(messages.some((msg: any) => msg.role === "assistant" && msg.content.some((part: any) => part.name === TOOL_NAME)), false);
    assert.equal(messages.some((msg: any) => msg.role === "toolResult" && msg.toolName === TOOL_NAME), false);
    assert.equal(messages.at(-1)?.role, "custom");
    const resumedHarness = harness(resumed);
    await resumedHarness.emit("session_start");
    assert.equal(await resumedHarness.boundary(resumedHarness.actions(7)), undefined);
    assert.equal((await resumedHarness.boundary(resumedHarness.actions(1)))?.continue, true);
    resumed.branch(anchor);
    const sibling = harness(resumed);
    await sibling.emit("session_tree");
    assert.equal(resumed.getBranch().some((entry: any) => entry.customType === SNAPSHOT_TYPE), false);
    assert.equal(resumed.getBranch().some((entry: any) => entry.type === "context_edit"), false);
    assert.equal((await sibling.boundary(sibling.actions(8)))?.continue, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
