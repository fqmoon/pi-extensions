import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { CHECK_TYPE, CHECK_RESPONSE_TYPE, REQUEST_TYPE, restoreState, SNAPSHOT_TYPE, TOOL_NAME } from "../state.ts";

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

function harness(sessionManager = SessionManager.inMemory("/tmp"), agentDir = defaultAgentDir, hasUI = true) {
  const handlers = new Map<string, Function[]>();
  let tool: any;
  let toolAvailable = true;
  let pendingMessages = false;
  let widgetError = false;
  const widgets = new Map<string, { content: string[]; placement: string }>();
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
  const ctx = {
    sessionManager, model: { id: "test-model" }, hasPendingMessages: () => pendingMessages, hasUI,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget(key: string, content: string[] | undefined, options: { placement: string }) {
        if (widgetError) throw new Error("widget unavailable");
        if (content) widgets.set(key, { content, placement: options.placement });
        else widgets.delete(key);
      },
    },
  };
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
      })), timestamp: Date.now(), stopReason: outcome === "completed" ? (results.length ? "toolUse" : "stop") : outcome,
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
  const decisions = async (n: number, outcome = "completed") => {
    let result;
    for (let i = 0; i < n; i++) {
      result = await boundary(actions(1), outcome);
      if (i < n - 1) assert.notEqual(result?.continue, true, "check triggered before the expected decision");
    }
    return result;
  };
  return { ctx, emit, boundary, actions, decisions, widgets, setWidgetError(error: boolean) { widgetError = error; }, setToolAvailable(available: boolean) { toolAvailable = available; }, setPendingMessages(pending: boolean) { pendingMessages = pending; }, get tool() { return tool; } };
}

async function collectSnapshot(h: ReturnType<typeof harness>, scope = "renderer") {
  await h.emit("context", { messages: [] });
  const recorded = await h.tool.execute("hud-sample", { level: "module", scope, state: "dirty propagation is likely", next: "inspect invalidation" });
  return h.boundary([{ toolName: TOOL_NAME, toolCallId: "hud-sample", isError: false, details: recorded.details }]);
}

test("HUD appears above the editor and reuses the durable snapshot without adding history", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.deepEqual(h.widgets.get("pi-whereami"), { content: ["whereami · Awaiting first snapshot · Decisions 0/12"], placement: "aboveEditor" });
  assert.equal(h.ctx.sessionManager.getBranch().length, 0);
  await h.decisions(3);
  assert.match(h.widgets.get("pi-whereami")!.content[0], /Decisions 3\/12/);
  await h.decisions(9);
  assert.deepEqual(h.widgets.get("pi-whereami")?.content, ["whereami · Updating snapshot"]);
  await collectSnapshot(h);
  assert.deepEqual(h.widgets.get("pi-whereami")?.content, [
    "whereami · Latest snapshot", "Level: module · Scope: renderer",
    "State: dirty propagation is likely", "Next: inspect invalidation",
  ]);
  const snapshots = () => h.ctx.sessionManager.getBranch().filter((entry: any) => entry.customType === SNAPSHOT_TYPE);
  assert.equal(snapshots().length, 1);
  assert.equal(snapshots()[0].content, "[whereami]\n\nLevel: module\nScope: renderer\nState: dirty propagation is likely\nNext: inspect invalidation");
  assert.equal(JSON.stringify(h.ctx.sessionManager.buildSessionContext().messages).includes("Latest snapshot"), false);
  await h.decisions(8);
  await collectSnapshot(h, "pipeline");
  assert.equal(h.widgets.size, 1);
  assert.match(h.widgets.get("pi-whereami")!.content[1], /Scope: pipeline/);
  assert.equal(snapshots().length, 2); // History still appends; only the panel replaces.
});

test("HUD labels a previous input snapshot until a new successful snapshot arrives", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.decisions(12);
  await collectSnapshot(h);
  await h.emit("message_start", { message: { role: "custom" } });
  assert.match(h.widgets.get("pi-whereami")!.content[0], /Latest snapshot/);
  await h.emit("message_start", { message: { role: "user" } });
  assert.match(h.widgets.get("pi-whereami")!.content[0], /Awaiting current snapshot · Decisions 0\/12/);
  assert.match(h.widgets.get("pi-whereami")!.content[1], /^History/);
  await h.decisions(12);
  const malformed = await h.tool.execute("bad-hud", { level: "module" });
  await h.boundary([{ toolName: TOOL_NAME, details: malformed.details }]);
  assert.match(h.widgets.get("pi-whereami")!.content[0], /Awaiting current snapshot · Decisions 0\/8/);
  await h.decisions(8);
  await collectSnapshot(h, "new task");
  assert.match(h.widgets.get("pi-whereami")!.content[0], /Latest snapshot/);
  assert.match(h.widgets.get("pi-whereami")!.content[1], /Scope: new task/);
});

test("HUD restores the active branch and clears when switching to a path without snapshots", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.decisions(12);
  const beforeSnapshot = h.ctx.sessionManager.getLeafId();
  await collectSnapshot(h);
  const user = { role: "user", content: [{ type: "text", text: "next task" }], timestamp: Date.now() };
  h.ctx.sessionManager.appendMessage(user);
  const resumed = harness(h.ctx.sessionManager);
  await resumed.emit("session_start");
  assert.match(resumed.widgets.get("pi-whereami")!.content[0], /Awaiting current snapshot/);
  assert.match(resumed.widgets.get("pi-whereami")!.content[1], /Scope: renderer/);
  h.ctx.sessionManager.branch(beforeSnapshot);
  await resumed.emit("session_tree");
  assert.deepEqual(resumed.widgets.get("pi-whereami")?.content, ["whereami · Awaiting first snapshot · Decisions 0/8"]);
  await resumed.emit("session_shutdown");
  assert.equal(resumed.widgets.size, 0);
});

test("headless mode and widget failures preserve the trigger and snapshot behavior", async () => {
  for (const hasUI of [false, true]) {
    const h = harness(undefined, undefined, hasUI);
    h.setWidgetError(true);
    await h.emit("session_start");
    assert.equal((await h.decisions(12))?.continue, true);
    const result = await collectSnapshot(h);
    assert.equal(result.entries.at(-1).customType, SNAPSHOT_TYPE);
    assert.equal(h.ctx.sessionManager.getBranch().filter((entry: any) => entry.customType === SNAPSHOT_TYPE).length, 1);
    assert.equal(h.widgets.size, 0);
    await h.emit("session_shutdown");
  }
});

async function injectedPrompt(h: ReturnType<typeof harness>): Promise<string> {
  await h.emit("session_start");
  assert.equal((await h.decisions(12))?.continue, true);
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

test("decision turns request one check; main model tool writes exactly one custom snapshot and keeps working", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("message_start", { message: { role: "user" } });
  assert.equal(await h.decisions(11), undefined);
  const triggered = await h.decisions(1);
  assert.equal(triggered.continue, true);
  assert.equal(triggered.entries[0].customType, CHECK_TYPE);
  assert.deepEqual(triggered.entries[0].data, { stage: 1, unit: "decision" });
  assert.equal(h.ctx.sessionManager.getBranch().some((entry: any) => entry.customType === REQUEST_TYPE), false);
  const context = [{ role: "user", content: "real task", timestamp: 1 }];
  const requested = await h.emit("context", { messages: context });
  assert.match(requested.messages.at(-1).content, /Re-orient before continuing/);
  assert.match(requested.messages.at(-1).content, /whereami_snapshot/);
  assert.deepEqual((await h.emit("context", { messages: context }))?.messages, undefined);
  const response = await h.tool.execute("check-1", { level: "module", scope: "renderer", state: "dirty propagation is likely", next: "inspect invalidation" });
  const after = await h.boundary([{ role: "toolResult", toolCallId: "check-1", toolName: TOOL_NAME, isError: false, details: response.details }]);
  assert.deepEqual(after.entries.map((entry: any) => entry.type), ["custom", "context_edit", "context_edit", "custom_message"]);
  assert.equal(after.entries[3].customType, SNAPSHOT_TYPE);
  assert.equal(after.entries[3].display, true);
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
  assert.equal(await h.decisions(7), undefined);
  assert.equal((await h.decisions(1))?.continue, true); // next interval is 8
});

test("mixed snapshot and task tool calls retain the whole task turn in context", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal((await h.decisions(12))?.continue, true);
  await h.emit("context", { messages: [] });
  const recorded = await h.tool.execute("sample", { level: "module", scope: "renderer", state: "dirty tracking", next: "inspect" });
  const after = await h.boundary([
    { toolName: TOOL_NAME, toolCallId: "sample", isError: false, details: recorded.details },
    { toolName: "read", toolCallId: "task", isError: false },
  ]);
  assert.deepEqual(after.entries.map((entry: any) => entry.type), ["custom", "custom_message"]);
  assert.deepEqual(restoreState(h.ctx.sessionManager.getBranch()), { stage: 1, decisionsSinceCheck: 1 });
  const context = h.ctx.sessionManager.buildSessionContext().messages;
  assert.equal(context.some((message: any) => message.role === "assistant" && message.content.some((part: any) => part.name === "read")), true);
  assert.equal(context.some((message: any) => message.role === "toolResult" && message.toolName === "read"), true);
  assert.equal(context.at(-1)?.role, "custom");
});

test("assistant text or unresolved result IDs prevent unsafe cleanup", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.decisions(12);
  const recorded = await h.tool.execute("sample", { level: "module", scope: "renderer", state: "dirty tracking", next: "inspect" });
  const result = { role: "toolResult", toolName: TOOL_NAME, toolCallId: "sample", isError: false, details: recorded.details };
  const after = await h.boundary([result], "completed", [
    { type: "text", text: "Task progress" },
    { type: "toolCall", name: TOOL_NAME, id: "sample", arguments: {} },
  ]);
  assert.deepEqual(after.entries.map((entry: any) => entry.type), ["custom", "custom_message"]);
  await h.decisions(8);
  const noIds = await h.emit("turn_end", {
    entries: [], outcome: "completed", toolResults: [result], messageEntryId: "missing", toolResultEntryIds: [],
    message: { role: "assistant", content: [{ type: "toolCall", name: TOOL_NAME, id: "sample", arguments: {} }] },
  });
  assert.deepEqual(noIds.entries.map((entry: any) => entry.type), ["custom", "custom_message"]);
});

test("required fields and invalid or interrupted checks never force a retry", async () => {
  const h = harness();
  assert.deepEqual(h.tool.parameters.required?.sort(), ["level", "next", "scope", "state"]);
  await h.emit("session_start");
  assert.equal((await h.decisions(12))?.continue, true);
  const malformed = await h.tool.execute("bad", { level: "module", scope: "renderer", state: "x\ny", next: "inspect" });
  assert.equal(malformed.details.snapshot, undefined);
  assert.equal((await h.boundary([{ toolName: TOOL_NAME, toolCallId: "bad", details: malformed.details }])).entries[0].customType, CHECK_RESPONSE_TYPE);
  assert.equal(h.ctx.sessionManager.getBranch().some((entry: any) => entry.customType === SNAPSHOT_TYPE), false);
  assert.equal((await h.emit("context", { messages: [] }))?.messages, undefined);
  assert.equal((await h.decisions(8))?.continue, true);
  await h.emit("agent_before_settle");
  assert.equal((await h.emit("context", { messages: [] }))?.messages, undefined);
  assert.equal(await h.boundary([]), undefined);
});

test("bad fields and failed checks do not interrupt the task; user resets at deep stage", async () => {
  const h = harness();
  await h.emit("session_start");
  for (const n of [12, 8, 6, 4]) {
    assert.equal((await h.decisions(n))?.continue, true);
    const malformed = await h.tool.execute("bad", { scope: "renderer" });
    assert.equal(malformed.details.snapshot, undefined);
    assert.equal((await h.boundary([{ role: "toolResult", toolName: TOOL_NAME, isError: false, details: malformed.details }])).entries[0].customType, CHECK_RESPONSE_TYPE);
  }
  // A failed sampling turn (no tool called) is allowed to finish normally.
  assert.equal((await h.decisions(4))?.continue, true);
  assert.equal((await h.boundary([])).entries[0].customType, CHECK_RESPONSE_TYPE);
  h.setPendingMessages(true);
  assert.equal(await h.decisions(12), undefined); // old run, before queued input is delivered
  h.setPendingMessages(false);
  await h.emit("message_start", { message: { role: "user" } });
  assert.equal(await h.decisions(11), undefined);
  await h.emit("message_start", { message: { role: "custom" } });
  assert.equal((await h.decisions(1))?.continue, true); // custom is not a reset
});

test("handled input does not suppress checks or reset the counting interval", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal(await h.decisions(11), undefined);
  await h.emit("input", { source: "interactive", text: ":status" }); // another extension handles it
  assert.equal((await h.decisions(1))?.continue, true);
});

test("provider error turns do not count as decisions or force sampling", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal(await h.decisions(11, "error"), undefined);
  assert.equal(await h.decisions(11, "aborted"), undefined);
  assert.equal(await h.decisions(11), undefined);
  assert.equal((await h.decisions(1))?.continue, true);
});

test("one large parallel batch is one decision, including failed tool results", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal(await h.boundary(h.actions(20)), undefined);
  assert.deepEqual(restoreState(h.ctx.sessionManager.getBranch()), { stage: 0, decisionsSinceCheck: 1 });
  assert.equal(await h.decisions(10), undefined);
  assert.equal((await h.boundary([{ toolName: "read", isError: true }]))?.continue, true);
  assert.deepEqual(restoreState(h.ctx.sessionManager.getBranch()), { stage: 1, decisionsSinceCheck: 0 });
});

test("status-only responses and ordinary text count; final answers do not force continuation", async () => {
  const h = harness();
  await h.emit("session_start");
  assert.equal(await h.decisions(10), undefined);
  assert.equal(await h.boundary([{ toolName: "get_context_usage" }]), undefined);
  assert.equal(await h.boundary([], "completed", [{ type: "text", text: "Finished the task." }]), undefined);
  assert.deepEqual(restoreState(h.ctx.sessionManager.getBranch()), { stage: 0, decisionsSinceCheck: 12 });
  assert.equal(h.ctx.sessionManager.getBranch().some((entry: any) => entry.customType === CHECK_TYPE), false);
  assert.equal((await h.emit("context", { messages: [] }))?.messages, undefined);
  // If another extension legitimately continues the task, the next safe tool
  // boundary may consume the due interval; no stage was consumed by the final.
  assert.equal((await h.boundary([{ toolName: "status" }]))?.continue, true);
});

test("requested text without a snapshot is exempt on resume without leaking a prompt", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.decisions(12);
  await h.emit("context", { messages: [] });
  const after = await h.boundary([], "completed", [{ type: "text", text: "No snapshot provided." }]);
  assert.deepEqual(after.entries.map((entry: any) => entry.customType), [CHECK_RESPONSE_TYPE]);
  assert.equal(after.continue, undefined);
  const branch = h.ctx.sessionManager.getBranch();
  assert.deepEqual(restoreState(branch), { stage: 1, decisionsSinceCheck: 0 });
  assert.equal(JSON.stringify(h.ctx.sessionManager.buildSessionContext().messages).includes(CHECK_RESPONSE_TYPE), false);
  const resumed = harness(h.ctx.sessionManager);
  await resumed.emit("session_start");
  assert.equal(await resumed.decisions(7), undefined);
  assert.equal((await resumed.decisions(1))?.continue, true);
});

test("requested mixed work counts once even when the snapshot is missing or invalid", async () => {
  for (const sample of [[], [{ toolName: TOOL_NAME, details: { snapshot: undefined } }]]) {
    const h = harness();
    await h.emit("session_start");
    await h.decisions(12);
    await h.emit("context", { messages: [] });
    const after = await h.boundary([...sample, ...h.actions(20)]);
    assert.equal(after.continue, undefined);
    assert.deepEqual(restoreState(h.ctx.sessionManager.getBranch()), { stage: 1, decisionsSinceCheck: 1 });
    assert.equal(await h.decisions(6), undefined);
    assert.equal((await h.decisions(1))?.continue, true);
  }
});

test("interrupting collection before a response does not exempt the next main-task response", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.decisions(12);
  await h.emit("agent_before_settle");
  const resumed = harness(h.ctx.sessionManager);
  await resumed.emit("session_start");
  assert.equal(await resumed.boundary([], "completed", [{ type: "text", text: "Continuing the main task." }]), undefined);
  assert.deepEqual(restoreState(h.ctx.sessionManager.getBranch()), { stage: 1, decisionsSinceCheck: 1 });
  assert.equal(await resumed.decisions(6), undefined);
  assert.equal((await resumed.decisions(1))?.continue, true);
});

test("pending input suppresses checks while keeping decision replay consistent", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.decisions(11);
  h.setPendingMessages(true);
  assert.equal(await h.decisions(1), undefined);
  assert.deepEqual(restoreState(h.ctx.sessionManager.getBranch()), { stage: 0, decisionsSinceCheck: 12 });
  // Real delivery resets the interval, unlike custom messages.
  const user = { role: "user", content: [{ type: "text", text: "new task" }], timestamp: Date.now() };
  h.ctx.sessionManager.appendMessage(user);
  await h.emit("message_start", { message: user });
  h.setPendingMessages(false);
  assert.deepEqual(restoreState(h.ctx.sessionManager.getBranch()), { stage: 0, decisionsSinceCheck: 0 });
  assert.equal(await h.decisions(11), undefined);
  assert.equal((await h.decisions(1))?.continue, true);
});

test("an older session's tool loadout activates the plugin; later unavailability cannot interrupt the task", async () => {
  const h = harness();
  h.setToolAvailable(false);
  await h.emit("session_start");
  assert.equal((await h.decisions(12))?.continue, true);
  await h.emit("message_start", { message: { role: "user" } });
  h.setToolAvailable(false);
  assert.equal(await h.decisions(12), undefined);
  h.setToolAvailable(true);
  assert.equal((await h.decisions(1))?.continue, true);
});

test("resuming a session keeps checkpoint and context edits on their own branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-whereami-cleanup-"));
  try {
    const manager = SessionManager.create(dir, dir);
    const h = harness(manager);
    await h.emit("session_start");
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "task" }], timestamp: Date.now() });
    assert.equal((await h.decisions(12))?.continue, true);
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
    assert.equal(await resumedHarness.decisions(7), undefined);
    assert.equal((await resumedHarness.decisions(1))?.continue, true);
    resumed.branch(anchor);
    const sibling = harness(resumed);
    await sibling.emit("session_tree");
    assert.equal(resumed.getBranch().some((entry: any) => entry.customType === SNAPSHOT_TYPE), false);
    assert.equal(resumed.getBranch().some((entry: any) => entry.type === "context_edit"), false);
    assert.equal((await sibling.decisions(8))?.continue, true);
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
    assert.equal(resumed.getBranch().some((entry: any) => entry.id === snapshot), true);
    assert.equal(resumed.buildSessionContext().messages.at(-1)?.role, "custom");
    resumed.branch(anchor);
    assert.equal(resumed.getBranch().some((entry: any) => entry.id === snapshot), false);
    resumed.appendCustomMessageEntry(SNAPSHOT_TYPE, "[whereami]\n\nLevel: file\nScope: second branch\nState: unknown\nNext: inspect", true);
    assert.equal(resumed.getBranch().some((entry: any) => entry.id === snapshot), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
