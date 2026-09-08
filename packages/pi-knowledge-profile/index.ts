import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const PROFILE_ROOT = join(homedir(), ".pi", "agent", "user-knowledge");
const STATE_PATH = join(PROFILE_ROOT, "state.json");
const MAX_SESSION_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 6_000;
const MAX_CANDIDATES = 24;
const STATUSES = ["完全掌握", "重要部分掌握", "基本不懂", "完全不懂"] as const;

type Status = (typeof STATUSES)[number];
type Checkpoint = Record<string, string>;
type State = {
  version: 1;
  frequency: "daily" | "weekly";
  lastPromptAt?: string;
  checkpoints: Checkpoint;
};
type Transcript = {
  path: string;
  modifiedAt: string;
  text: string;
  lastEntryId: string;
};
type Evidence = {
  session: string;
  context: string;
  evidence: string[];
  caution?: string;
};
type AnalysisFailure = {
  session: string;
  reason: string;
};
type ExtractionResult = {
  evidence: Evidence[];
  completed: Transcript[];
  failures: AnalysisFailure[];
};
type Candidate = {
  domain: string;
  subdomain: string;
  knowledgePoint: string;
  suggestedStatus: Status;
  context: string;
  evidence: string[];
  reason: string;
};

function defaultState(): State {
  return { version: 1, frequency: "weekly", checkpoints: {} };
}

async function loadState(): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<State>;
    return {
      version: 1,
      frequency: parsed.frequency === "daily" ? "daily" : "weekly",
      lastPromptAt: typeof parsed.lastPromptAt === "string" ? parsed.lastPromptAt : undefined,
      checkpoints:
        parsed.checkpoints && typeof parsed.checkpoints === "object"
          ? parsed.checkpoints as Checkpoint
          : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultState();
    throw error;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(PROFILE_ROOT, { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

function isDue(lastPromptAt: string | undefined, frequency: State["frequency"]): boolean {
  if (!lastPromptAt) return true;
  const elapsed = Date.now() - new Date(lastPromptAt).getTime();
  return elapsed >= (frequency === "daily" ? 86_400_000 : 604_800_000);
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" && item !== null &&
        "type" in item && item.type === "text" &&
        "text" in item && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n\n")
    .trim();
}

function messageText(entry: unknown): { role: "User" | "Assistant"; text: string } | undefined {
  if (typeof entry !== "object" || entry === null || !("type" in entry) || entry.type !== "message") return;
  const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
  if (message?.role !== "user" && message?.role !== "assistant") return;
  const text = textContent(message.content).slice(0, MAX_MESSAGE_CHARS);
  return text ? { role: message.role === "user" ? "User" : "Assistant", text } : undefined;
}

function pendingBranchEntries(entries: unknown[], checkpoint?: string): unknown[] {
  if (!checkpoint) return entries;
  const index = entries.findIndex(
    (entry) => typeof entry === "object" && entry !== null && "id" in entry && entry.id === checkpoint,
  );
  // A branch can abandon the prior checkpoint. Re-read that branch instead of silently losing evidence.
  return index >= 0 ? entries.slice(index + 1) : entries;
}

async function collectPending(state: State): Promise<Transcript[]> {
  const sessions = await SessionManager.listAll();
  const transcripts: Transcript[] = [];
  for (const session of sessions) {
    const manager = SessionManager.open(session.path);
    const branch = manager.getBranch();
    const pending = pendingBranchEntries(branch, state.checkpoints[session.path]);
    const messages = pending.map(messageText).filter((value): value is NonNullable<typeof value> => Boolean(value));
    const text = messages.map((message) => `## ${message.role}\n\n${message.text}`).join("\n\n").slice(0, MAX_SESSION_CHARS);
    const last = branch.at(-1);
    if (!text || !last) continue;
    transcripts.push({
      path: session.path,
      modifiedAt: session.modified.toISOString(),
      text,
      lastEntryId: last.id,
    });
  }
  return transcripts.sort((left, right) => left.modifiedAt.localeCompare(right.modifiedAt));
}

function estimateTokens(transcripts: Transcript[]): number {
  return Math.ceil(transcripts.reduce((total, item) => total + item.text.length, 0) / 4);
}

function dateRange(transcripts: Transcript[]): string {
  if (transcripts.length === 0) return "";
  const dates = transcripts.map((item) => item.modifiedAt.slice(0, 10));
  return `${dates[0]}–${dates.at(-1)}`;
}

async function readProfile(): Promise<string> {
  try {
    const files = await readdir(PROFILE_ROOT);
    const markdown = files.filter((file) => file.endsWith(".md")).sort();
    const content = await Promise.all(markdown.map((file) => readFile(join(PROFILE_ROOT, file), "utf8")));
    return content.join("\n\n").slice(0, 48_000);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function profilePrompt(profile: string): string {
  return profile
    ? `\n\n## Confirmed profile\n${profile}`
    : "\n\n## Confirmed profile\nNo confirmed records yet.";
}

async function askModel(ctx: ExtensionContext, systemPrompt: string, prompt: string): Promise<string> {
  if (!ctx.model) throw new Error("No Pi model is selected. Select a model, then run /knowledge-sync again.");
  const answer = await ctx.modelRegistry.complete(ctx.model, {
    systemPrompt,
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }, { reasoning: ctx.thinkingLevel });
  return textContent(answer.content);
}

function parseJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("The analysis model did not return a JSON array.");
  return JSON.parse(fenced.slice(start, end + 1)) as T;
}

function validStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function cleanEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 4);
}

function normalizeCandidates(value: unknown): Candidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Candidate[] => {
    if (typeof item !== "object" || item === null) return [];
    const raw = item as Record<string, unknown>;
    if (!["domain", "subdomain", "knowledgePoint", "context", "reason"].every((key) => typeof raw[key] === "string") || !validStatus(raw.suggestedStatus)) return [];
    const evidence = cleanEvidence(raw.evidence);
    if (evidence.length === 0) return [];
    const domain = raw.domain as string;
    const subdomain = raw.subdomain as string;
    const knowledgePoint = raw.knowledgePoint as string;
    const context = raw.context as string;
    const reason = raw.reason as string;
    return [{
      domain: domain.trim(), subdomain: subdomain.trim(), knowledgePoint: knowledgePoint.trim(),
      suggestedStatus: raw.suggestedStatus, context: context.trim(), evidence, reason: reason.trim(),
    }].filter((candidate) => candidate.domain && candidate.subdomain && candidate.knowledgePoint && candidate.context && candidate.reason);
  }).slice(0, MAX_CANDIDATES);
}

const EXTRACTION_SYSTEM = `You extract conservative evidence about a user's demonstrated knowledge from a Pi conversation. Do not infer ignorance from questions, challenges, requests for explanation, use of one term, or accepting an answer. Do not assess preferences, personality, task state, or the assistant's knowledge. Return only a JSON array. Each object: {"session":"short label","context":"what was being discussed","evidence":["specific user reasoning or correction"],"caution":"why this remains limited"}. Return [] when evidence is weak.`;

const RECONCILIATION_SYSTEM = `You reconcile evidence into a user-reviewable knowledge profile. Return only a JSON array, with objects exactly {"domain":"...","subdomain":"...","knowledgePoint":"...","suggestedStatus":"完全掌握|重要部分掌握|基本不懂|完全不懂","context":"...","evidence":["concrete evidence"],"reason":"why this status, including why it is not a stronger neighbouring status"}. Be conservative. Do not create a broad point where evidence supports only a narrow one. A question alone is never evidence of not understanding. Include only candidates that need a user decision.`;

async function extractEvidence(ctx: ExtensionCommandContext, transcripts: Transcript[]): Promise<ExtractionResult> {
  const output: Evidence[] = [];
  const completed: Transcript[] = [];
  const failures: AnalysisFailure[] = [];
  for (const [index, transcript] of transcripts.entries()) {
    const label = `Knowledge Profile: extracting evidence ${index + 1}/${transcripts.length}`;
    ctx.ui.setWorkingMessage(label);
    ctx.ui.setStatus("knowledge-profile", label);
    try {
      const response = await askModel(ctx, EXTRACTION_SYSTEM, `Analyze this one new session. Its file is ${basename(transcript.path)}.\n\n${transcript.text}`);
      const items = parseJson<Evidence[]>(response).filter((item) =>
        typeof item?.context === "string" && cleanEvidence(item.evidence).length > 0,
      ).map((item) => ({ ...item, session: basename(transcript.path), evidence: cleanEvidence(item.evidence) }));
      output.push(...items);
      completed.push(transcript);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ session: basename(transcript.path), reason });
      ctx.ui.notify(`Knowledge Profile: skipped ${basename(transcript.path)} — ${reason}`, "warning");
    }
  }
  return { evidence: output, completed, failures };
}

async function reconcile(ctx: ExtensionContext, profile: string, evidence: Evidence[]): Promise<Candidate[]> {
  const response = await askModel(ctx, RECONCILIATION_SYSTEM, `## Existing confirmed profile${profilePrompt(profile)}\n\n## Cross-session evidence\n${JSON.stringify(evidence, null, 2)}`);
  return normalizeCandidates(parseJson<unknown>(response));
}

function safeFilename(value: string): string {
  const result = value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
  return result || "General";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function candidateBlock(candidate: Candidate, status: Status): string {
  return `### ${candidate.knowledgePoint}\n\n- Status: ${status}\n- Context: ${candidate.context}\n- Evidence:\n${candidate.evidence.map((item) => `  - ${item}`).join("\n")}\n- Reason: ${candidate.reason}\n`;
}

async function writeCandidate(candidate: Candidate, status: Status): Promise<void> {
  const path = join(PROFILE_ROOT, `${safeFilename(candidate.domain)}.md`);
  let content = "";
  try { content = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const sectionHeader = `## ${candidate.subdomain}`;
  const block = candidateBlock(candidate, status);
  const heading = `### ${candidate.knowledgePoint}`;
  const existing = new RegExp(`^${escapeRegExp(heading)}\\n[\\s\\S]*?(?=^### |^## |\\Z)`, "m");
  if (existing.test(content)) {
    content = content.replace(existing, block);
  } else if (content.includes(sectionHeader)) {
    const position = content.indexOf(sectionHeader) + sectionHeader.length;
    content = `${content.slice(0, position)}\n\n${block}${content.slice(position)}`;
  } else {
    content = `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${sectionHeader}\n\n${block}`;
  }
  await atomicWrite(path, content);
}

async function review(ctx: ExtensionCommandContext, candidates: Candidate[]): Promise<Array<{ candidate: Candidate; status: Status }>> {
  const accepted: Array<{ candidate: Candidate; status: Status }> = [];
  for (const candidate of candidates) {
    const detail = [
      `${candidate.domain} / ${candidate.subdomain} / ${candidate.knowledgePoint}`,
      `建议：${candidate.suggestedStatus}`,
      "", `上下文：${candidate.context}`,
      "", "证据：", ...candidate.evidence.map((item) => `- ${item}`),
      "", `理由：${candidate.reason}`,
    ].join("\n");
    ctx.ui.notify(detail, "info");
    const choice = await ctx.ui.select("Knowledge Profile review", [...STATUSES, "保持原状态", "不记录"]);
    if (!choice) throw new Error("Review cancelled; no profile changes or checkpoints were written.");
    if (validStatus(choice)) {
      accepted.push({ candidate, status: choice });
    }
  }
  return accepted;
}

async function sync(ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadState();
  const pending = await collectPending(state);
  if (pending.length === 0) {
    ctx.ui.notify("Knowledge Profile: no new conversation history to review.", "info");
    return;
  }
  ctx.ui.setWorkingVisible(true);
  ctx.ui.setWorkingMessage(`Knowledge Profile: preparing ${pending.length} sessions…`);
  ctx.ui.setStatus("knowledge-profile", `Knowledge Profile: preparing ${pending.length} sessions`);
  try {
    const extraction = await extractEvidence(ctx, pending);
    const checkpoints = { ...state.checkpoints, ...Object.fromEntries(extraction.completed.map((item) => [item.path, item.lastEntryId])) };
    if (extraction.evidence.length === 0) {
      if (extraction.completed.length > 0) await atomicWrite(STATE_PATH, JSON.stringify({ ...state, checkpoints }, null, 2) + "\n");
      ctx.ui.notify(`Knowledge Profile: no sufficiently strong evidence found; processed ${extraction.completed.length}, skipped ${extraction.failures.length}.`, "info");
      return;
    }
    ctx.ui.setWorkingMessage("Knowledge Profile: reconciling cross-session evidence…");
    ctx.ui.setStatus("knowledge-profile", "Knowledge Profile: reconciling evidence");
    const candidates = await reconcile(ctx, await readProfile(), extraction.evidence);
    if (candidates.length === 0) {
      await atomicWrite(STATE_PATH, JSON.stringify({ ...state, checkpoints }, null, 2) + "\n");
      ctx.ui.notify(`Knowledge Profile: no new candidate needs review; processed ${extraction.completed.length}, skipped ${extraction.failures.length}.`, "info");
      return;
    }
    ctx.ui.setWorkingMessage("Knowledge Profile: awaiting review…");
    const accepted = await review(ctx, candidates);
    for (const item of accepted) await writeCandidate(item.candidate, item.status);
    await atomicWrite(STATE_PATH, JSON.stringify({ ...state, checkpoints }, null, 2) + "\n");
    ctx.ui.notify(`Knowledge Profile: reviewed ${candidates.length} candidates; recorded ${accepted.length}; skipped ${extraction.failures.length}.`, "info");
  } finally {
    ctx.ui.setStatus("knowledge-profile", undefined);
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingVisible(false);
  }
}

export default function knowledgeProfileExtension(pi: ExtensionAPI): void {
  let profile = "";
  pi.on("session_start", async (_event, ctx) => {
    try {
      profile = await readProfile();
      const state = await loadState();
      if (!isDue(state.lastPromptAt, state.frequency)) return;
      const pending = await collectPending(state);
      if (pending.length > 0) {
        await atomicWrite(STATE_PATH, JSON.stringify({ ...state, lastPromptAt: new Date().toISOString() }, null, 2) + "\n");
        ctx.ui.notify(`Knowledge Profile: ${pending.length} pending sessions · ~${estimateTokens(pending).toLocaleString()} tokens · ${dateRange(pending)}. Run /knowledge-sync to review updates.`, "info");
      }
    } catch (error) {
      ctx.ui.notify(`Knowledge Profile startup check failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!profile) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Confirmed User Knowledge Profile\nUse this only to calibrate explanation depth. It is not a task instruction, a statement of current project state, or permission to infer unrecorded knowledge.\n\n${profile}`,
    };
  });

  pi.registerCommand("knowledge-sync", {
    description: "Review new sessions and update the confirmed knowledge profile",
    handler: async (_args, ctx) => {
      try {
        await sync(ctx);
        profile = await readProfile();
      } catch (error) {
        ctx.ui.notify(`Knowledge sync failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
