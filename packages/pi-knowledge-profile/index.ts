import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const PROFILE_ROOT = join(homedir(), ".pi", "agent", "user-knowledge");
const PROFILE_PATH = join(PROFILE_ROOT, "profile.json");
const STATE_PATH = join(PROFILE_ROOT, "state.json");
const VIEWS_ROOT = join(PROFILE_ROOT, "views");
const LOG_ENTRY_TYPE = "knowledge-profile-log";
const MAX_SESSION_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 6_000;
const MAX_CANDIDATES_SAFETY = 200;
const DEFAULT_REMINDER_THRESHOLD = 5;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_PROFILE_MAX_CHARS = 48_000;
const STATUSES = ["完全掌握", "重要部分掌握", "基本不懂", "完全不懂"] as const;
const EVIDENCE_SIGNALS = ["positive", "negative"] as const;
const EVIDENCE_STRENGTHS = ["strong", "moderate"] as const;

type Status = (typeof STATUSES)[number];
type EvidenceSignal = (typeof EVIDENCE_SIGNALS)[number];
type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];
type Checkpoint = Record<string, string>;
type StagedSession = { lastEntryId: string; evidence: Evidence[] };
type State = {
  version: 4;
  reminderThreshold: number;
  batchSize: number;
  profileMaxChars: number;
  checkpoints: Checkpoint;
  staged: Record<string, StagedSession>;
};
type Transcript = { path: string; modifiedAt: string; text: string; lastEntryId: string };
type Evidence = {
  session: string;
  context: string;
  signal: EvidenceSignal;
  strength: EvidenceStrength;
  evidence: string[];
  caution?: string;
};
type AnalysisFailure = { session: string; reason: string };
type ExtractionResult = { completed: Transcript[]; failures: AnalysisFailure[] };
type Candidate = {
  domain: string;
  subdomain: string;
  knowledgePoint: string;
  suggestedStatus: Status;
  context: string;
  evidence: string[];
  reason: string;
};
type KnowledgePoint = {
  name: string;
  status: Status;
  context: string;
  evidence: string[];
  reason: string;
  updatedAt: string;
};
type Subdomain = { name: string; knowledgePoints: KnowledgePoint[] };
type Domain = { name: string; subdomains: Subdomain[] };
type Profile = { version: 1; domains: Domain[] };
type ProfileChange = {
  kind: "added" | "updated";
  path: string;
  previousStatus?: Status;
  status: Status;
};
type BatchCommitResult = {
  committed: number;
  failures: number;
  changes: ProfileChange[];
};
type LogKind = "working" | "success" | "warning" | "info" | "error";
type LogEntry = { kind: LogKind; text: string };
type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  calls: number;
};
type ModelAnswer = { text: string; callTokens: number };
type ConfigKey = "threshold" | "batchSize" | "profileMaxChars";

function defaultState(): State {
  return {
    version: 4,
    reminderThreshold: DEFAULT_REMINDER_THRESHOLD,
    batchSize: DEFAULT_BATCH_SIZE,
    profileMaxChars: DEFAULT_PROFILE_MAX_CHARS,
    checkpoints: {},
    staged: {},
  };
}

function emptyProfile(): Profile {
  return { version: 1, domains: [] };
}

function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, calls: 0 };
}

function appendLog(pi: ExtensionAPI, kind: LogKind, text: string): void {
  pi.appendEntry(LOG_ENTRY_TYPE, { kind, text } satisfies LogEntry);
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatChars(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function validStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function validEvidenceSignal(value: unknown): value is EvidenceSignal {
  return typeof value === "string" && (EVIDENCE_SIGNALS as readonly string[]).includes(value);
}

function validEvidenceStrength(value: unknown): value is EvidenceStrength {
  return typeof value === "string" && (EVIDENCE_STRENGTHS as readonly string[]).includes(value);
}

function cleanEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 4);
}

function isEvidence(value: unknown): value is Evidence {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Partial<Evidence>;
  return typeof raw.session === "string" && typeof raw.context === "string" &&
    validEvidenceSignal(raw.signal) && validEvidenceStrength(raw.strength) && cleanEvidence(raw.evidence).length > 0;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

async function writeState(state: State): Promise<void> {
  await atomicWrite(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

async function loadState(): Promise<State> {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<State>;
    const reminderThreshold = Number.isInteger(parsed.reminderThreshold) && (parsed.reminderThreshold ?? 0) > 0
      ? parsed.reminderThreshold as number
      : DEFAULT_REMINDER_THRESHOLD;
    const batchSize = Number.isInteger(parsed.batchSize) && (parsed.batchSize ?? 0) > 0
      ? parsed.batchSize as number
      : DEFAULT_BATCH_SIZE;
    const profileMaxChars = Number.isInteger(parsed.profileMaxChars) && (parsed.profileMaxChars ?? 0) > 0
      ? parsed.profileMaxChars as number
      : DEFAULT_PROFILE_MAX_CHARS;
    return {
      version: 4,
      reminderThreshold,
      batchSize,
      profileMaxChars,
      checkpoints: parsed.checkpoints && typeof parsed.checkpoints === "object" ? parsed.checkpoints : {},
      staged: parsed.staged && typeof parsed.staged === "object"
        ? Object.fromEntries(Object.entries(parsed.staged).flatMap(([path, item]) => {
          if (typeof item !== "object" || item === null) return [];
          const raw = item as Partial<StagedSession>;
          if (typeof raw.lastEntryId !== "string" || !Array.isArray(raw.evidence)) return [];
          return [[path, { lastEntryId: raw.lastEntryId, evidence: raw.evidence.filter(isEvidence) }]];
        }))
        : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultState();
    throw error;
  }
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && "type" in item && item.type === "text" &&
      "text" in item && typeof item.text === "string")
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
  return index >= 0 ? entries.slice(index + 1) : entries;
}

async function collectPending(state: State): Promise<Transcript[]> {
  const sessions = await SessionManager.listAll();
  const transcripts: Transcript[] = [];
  for (const session of sessions) {
    const manager = SessionManager.open(session.path);
    const branch = manager.getBranch();
    const checkpoint = state.staged[session.path]?.lastEntryId ?? state.checkpoints[session.path];
    const pending = pendingBranchEntries(branch, checkpoint);
    const messages = pending.map(messageText).filter((value): value is NonNullable<typeof value> => Boolean(value));
    const text = messages.map((message) => `## ${message.role}\n\n${message.text}`).join("\n\n").slice(0, MAX_SESSION_CHARS);
    const last = branch.at(-1);
    if (!text || !last) continue;
    transcripts.push({ path: session.path, modifiedAt: session.modified.toISOString(), text, lastEntryId: last.id });
  }
  return transcripts.sort((left, right) => left.modifiedAt.localeCompare(right.modifiedAt));
}

function pendingSessionCount(state: State, pending: Transcript[]): number {
  return new Set([...Object.keys(state.staged), ...pending.map((item) => item.path)]).size;
}

function estimateTokens(transcripts: Transcript[]): number {
  return Math.ceil(transcripts.reduce((total, item) => total + item.text.length, 0) / 4);
}

function dateRange(transcripts: Transcript[]): string {
  if (transcripts.length === 0) return "";
  const dates = transcripts.map((item) => item.modifiedAt.slice(0, 10));
  return `${dates[0]}–${dates.at(-1)}`;
}

function isKnowledgePoint(value: unknown): value is KnowledgePoint {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Partial<KnowledgePoint>;
  return typeof raw.name === "string" && validStatus(raw.status) && typeof raw.context === "string" &&
    Array.isArray(raw.evidence) && typeof raw.reason === "string" && typeof raw.updatedAt === "string";
}

function normalizeProfile(value: unknown): Profile {
  if (typeof value !== "object" || value === null) return emptyProfile();
  const rawDomains = (value as { domains?: unknown }).domains;
  if (!Array.isArray(rawDomains)) return emptyProfile();
  const domains = rawDomains.flatMap((domain): Domain[] => {
    if (typeof domain !== "object" || domain === null) return [];
    const raw = domain as { name?: unknown; subdomains?: unknown };
    if (typeof raw.name !== "string" || !Array.isArray(raw.subdomains)) return [];
    const subdomains = raw.subdomains.flatMap((subdomain): Subdomain[] => {
      if (typeof subdomain !== "object" || subdomain === null) return [];
      const item = subdomain as { name?: unknown; knowledgePoints?: unknown };
      if (typeof item.name !== "string" || !Array.isArray(item.knowledgePoints)) return [];
      return [{ name: item.name, knowledgePoints: item.knowledgePoints.filter(isKnowledgePoint) }];
    });
    return [{ name: raw.name, subdomains }];
  });
  return { version: 1, domains };
}

async function loadProfile(): Promise<Profile> {
  try {
    return normalizeProfile(JSON.parse(await readFile(PROFILE_PATH, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyProfile();
    throw error;
  }
}

async function writeProfile(profile: Profile): Promise<void> {
  await atomicWrite(PROFILE_PATH, JSON.stringify(profile, null, 2) + "\n");
}

function safeFilename(value: string): string {
  const result = value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
  return result || "General";
}

function renderDomain(domain: Domain): string {
  return domain.subdomains.map((subdomain) => [
    `## ${subdomain.name}`,
    ...subdomain.knowledgePoints.map((point) => [
      `### ${point.name}`,
      "",
      `- Status: ${point.status}`,
      `- Context: ${point.context}`,
      "- Evidence:",
      ...point.evidence.map((item) => `  - ${item}`),
      `- Reason: ${point.reason}`,
      `- Updated: ${point.updatedAt}`,
    ].join("\n")),
  ].join("\n\n")).join("\n\n") + "\n";
}

async function renderViews(profile: Profile): Promise<void> {
  await mkdir(VIEWS_ROOT, { recursive: true });
  const existing = (await readdir(VIEWS_ROOT)).filter((file) => file.endsWith(".md"));
  const desired = new Set(profile.domains.map((domain) => `${safeFilename(domain.name)}.md`));
  await Promise.all(existing.filter((file) => !desired.has(file)).map((file) => unlink(join(VIEWS_ROOT, file))));
  await Promise.all(profile.domains.map((domain) =>
    atomicWrite(join(VIEWS_ROOT, `${safeFilename(domain.name)}.md`), renderDomain(domain))));
}

function profileJson(profile: Profile): string {
  return JSON.stringify(profile);
}

function profileForPrompt(profile: Profile, maxChars: number): string {
  return profileJson(profile).slice(0, maxChars);
}

async function askModel(
  ctx: ExtensionContext,
  usage: UsageTotals,
  systemPrompt: string,
  prompt: string,
): Promise<ModelAnswer> {
  if (!ctx.model) throw new Error("No Pi model is selected. Select a model, then run /knowledge-sync again.");
  const answer = await ctx.modelRegistry.complete(ctx.model, {
    systemPrompt,
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }, { reasoning: ctx.thinkingLevel });
  const callTokens = answer.usage.totalTokens || 0;
  usage.input += answer.usage.input || 0;
  usage.output += answer.usage.output || 0;
  usage.cacheRead += answer.usage.cacheRead || 0;
  usage.cacheWrite += answer.usage.cacheWrite || 0;
  usage.totalTokens += callTokens;
  usage.calls += 1;
  return { text: textContent(answer.content), callTokens };
}

function parseJsonArray<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("The analysis model did not return a JSON array.");
  return JSON.parse(fenced.slice(start, end + 1)) as T;
}

function normalizeCandidates(value: unknown): Candidate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Candidate[] => {
    if (typeof item !== "object" || item === null) return [];
    const raw = item as Record<string, unknown>;
    if (!["domain", "subdomain", "knowledgePoint", "context", "reason"].every((key) => typeof raw[key] === "string") || !validStatus(raw.suggestedStatus)) return [];
    const evidence = cleanEvidence(raw.evidence);
    if (evidence.length === 0) return [];
    const candidate: Candidate = {
      domain: (raw.domain as string).trim(),
      subdomain: (raw.subdomain as string).trim(),
      knowledgePoint: (raw.knowledgePoint as string).trim(),
      suggestedStatus: raw.suggestedStatus,
      context: (raw.context as string).trim(),
      evidence,
      reason: (raw.reason as string).trim(),
    };
    return candidate.domain && candidate.subdomain && candidate.knowledgePoint && candidate.context && candidate.reason ? [candidate] : [];
  }).slice(0, MAX_CANDIDATES_SAFETY);
}

const EXTRACTION_SYSTEM = `You extract evidence about both what a user understands and what they do not yet understand from one Pi conversation. Return only a JSON array. Each object must be exactly {"session":"short label","context":"what was being discussed","signal":"positive|negative","strength":"strong|moderate","evidence":["specific user statement, reasoning, correction, misconception, or demonstrated confusion"],"caution":"optional limitation"}. Positive evidence includes correct explanation, correction, comparison, boundary reasoning, application, or repeated competent use. Negative evidence requires actual evidence of a knowledge gap: an explicit statement of not knowing or lacking background, a clearly incorrect explanation of a core concept, repeated confusion after explanation, or an explicit request to start from basics tied to stated lack of knowledge. A question alone, a request for explanation alone, isolated terminology use, acknowledgement, or accepting an answer is never negative evidence. Do not infer ignorance from absence. Use strong when the evidence directly establishes the signal; use moderate when it is credible but narrower or indirect. Preserve useful moderate evidence so cross-session reconciliation can combine repeated signals. Do not assess preferences, personality, task state, or the assistant's knowledge. Return [] only when there is no meaningful positive or negative knowledge evidence.`;

const RECONCILIATION_SYSTEM = `You reconcile cross-session evidence into an automatically maintained user knowledge profile. Return only a JSON array, with objects exactly {"domain":"...","subdomain":"...","knowledgePoint":"...","suggestedStatus":"完全掌握|重要部分掌握|基本不懂|完全不懂","context":"...","evidence":["concrete evidence"],"reason":"why this status, including why neighbouring statuses are less appropriate"}. The profile is bidirectional: it records both what may be assumed and what should be explained. Unknown or never-discussed knowledge must remain absent, not be classified as ignorance. Use positive and negative evidence together, including repeated moderate evidence across sessions. 完全掌握 means the user demonstrates reliable command including relevant boundaries or application. 重要部分掌握 means the core is usable but some limits remain. 基本不懂 means there is concrete evidence of material gaps, misconceptions, or unstable understanding, while some familiarity may exist. 完全不懂 requires strong explicit evidence of essentially no foundation in that specific knowledge point; never infer it merely from a question, one mistake, or missing evidence. Existing points may move in either direction only when new evidence justifies the change. Keep knowledge points narrow enough that the evidence genuinely supports the status. Include only points for which the evidence justifies an add or update.`;

async function extractEvidence(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: State,
  transcripts: Transcript[],
  offset: number,
  total: number,
  usage: UsageTotals,
): Promise<ExtractionResult> {
  const completed: Transcript[] = [];
  const failures: AnalysisFailure[] = [];
  for (const [index, transcript] of transcripts.entries()) {
    const position = offset + index + 1;
    try {
      const answer = await askModel(
        ctx,
        usage,
        EXTRACTION_SYSTEM,
        `Analyze this one new session. Its file is ${basename(transcript.path)}.\n\n${transcript.text}`,
      );
      const items = parseJsonArray<unknown[]>(answer.text).flatMap((item): Evidence[] => {
        if (typeof item !== "object" || item === null) return [];
        const raw = item as Record<string, unknown>;
        const evidence = cleanEvidence(raw.evidence);
        if (typeof raw.context !== "string" || !validEvidenceSignal(raw.signal) || !validEvidenceStrength(raw.strength) || evidence.length === 0) return [];
        const result: Evidence = {
          session: basename(transcript.path),
          context: raw.context.trim(),
          signal: raw.signal,
          strength: raw.strength,
          evidence,
        };
        if (typeof raw.caution === "string" && raw.caution.trim()) result.caution = raw.caution.trim();
        return result.context ? [result] : [];
      });
      completed.push(transcript);
      const staged = state.staged[transcript.path];
      state.staged[transcript.path] = {
        lastEntryId: transcript.lastEntryId,
        evidence: [...(staged?.evidence ?? []), ...items],
      };
      await writeState(state);
      appendLog(
        pi,
        "success",
        `${position}/${total} ${basename(transcript.path)} · evidence ${items.length} · ${formatTokens(answer.callTokens)} tok · total ${formatTokens(usage.totalTokens)}`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ session: basename(transcript.path), reason });
      appendLog(pi, "warning", `${position}/${total} ${basename(transcript.path)} · skipped · ${reason}`);
    }
  }
  return { completed, failures };
}

async function reconcile(
  ctx: ExtensionContext,
  profile: Profile,
  evidence: Evidence[],
  usage: UsageTotals,
  profileMaxChars: number,
): Promise<{ candidates: Candidate[]; callTokens: number }> {
  const answer = await askModel(
    ctx,
    usage,
    RECONCILIATION_SYSTEM,
    `## Existing profile\n${profileForPrompt(profile, profileMaxChars)}\n\n## Cross-session evidence\n${JSON.stringify(evidence, null, 2)}`,
  );
  return { candidates: normalizeCandidates(parseJsonArray<unknown>(answer.text)), callTokens: answer.callTokens };
}

function upsertCandidate(profile: Profile, candidate: Candidate): ProfileChange {
  let domain = profile.domains.find((item) => item.name === candidate.domain);
  if (!domain) {
    domain = { name: candidate.domain, subdomains: [] };
    profile.domains.push(domain);
  }
  let subdomain = domain.subdomains.find((item) => item.name === candidate.subdomain);
  if (!subdomain) {
    subdomain = { name: candidate.subdomain, knowledgePoints: [] };
    domain.subdomains.push(subdomain);
  }
  const path = `${candidate.domain} / ${candidate.subdomain} / ${candidate.knowledgePoint}`;
  const existing = subdomain.knowledgePoints.find((item) => item.name === candidate.knowledgePoint);
  const point: KnowledgePoint = {
    name: candidate.knowledgePoint,
    status: candidate.suggestedStatus,
    context: candidate.context,
    evidence: candidate.evidence,
    reason: candidate.reason,
    updatedAt: new Date().toISOString(),
  };
  if (!existing) {
    subdomain.knowledgePoints.push(point);
    return { kind: "added", path, status: point.status };
  }
  const previousStatus = existing.status;
  Object.assign(existing, point);
  return { kind: "updated", path, previousStatus, status: point.status };
}

function formatChanges(changes: ProfileChange[], committed: number, failures: number, batchLabel: string, totalTokens: number): string {
  const added = changes.filter((item) => item.kind === "added");
  const updated = changes.filter((item) => item.kind === "updated");
  const lines = [`${batchLabel} · +${added.length} ~${updated.length} · committed ${committed}${failures > 0 ? ` · skipped ${failures}` : ""} · total ${formatTokens(totalTokens)} tok`];
  for (const item of added) lines.push(`+ ${item.path} → ${item.status}`);
  for (const item of updated) lines.push(`~ ${item.path}${item.previousStatus === item.status ? ` → ${item.status}` : `: ${item.previousStatus} → ${item.status}`}`);
  return lines.join("\n");
}

async function commitStaged(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: State,
  usage: UsageTotals,
  failures = 0,
  batchLabel = "Batch",
): Promise<BatchCommitResult> {
  const staged = Object.entries(state.staged);
  if (staged.length === 0) return { committed: 0, failures, changes: [] };

  const checkpoints = {
    ...state.checkpoints,
    ...Object.fromEntries(staged.map(([path, item]) => [path, item.lastEntryId])),
  };
  const evidence = staged.flatMap(([, item]) => item.evidence);
  let changes: ProfileChange[] = [];

  if (evidence.length > 0) {
    appendLog(pi, "working", `${batchLabel} · reconciling · total ${formatTokens(usage.totalTokens)} tok`);
    const profile = await loadProfile();
    const result = await reconcile(ctx, profile, evidence, usage, state.profileMaxChars);
    changes = result.candidates.map((candidate) => upsertCandidate(profile, candidate));
    await writeProfile(profile);
    await renderViews(profile);
  }

  state.checkpoints = checkpoints;
  state.staged = {};
  await writeState(state);
  appendLog(pi, "success", formatChanges(changes, staged.length, failures, batchLabel, usage.totalTokens));
  return { committed: staged.length, failures, changes };
}

async function sync(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const state = await loadState();
  const pending = await collectPending(state);
  const total = pendingSessionCount(state, pending);
  const usage = emptyUsage();

  if (total === 0) {
    appendLog(pi, "info", "No new sessions to sync.");
    return;
  }

  if (!ctx.model) throw new Error("No Pi model is selected. Select a model, then run /knowledge-sync again.");
  const modelLabel = `${ctx.model.provider}/${ctx.model.id}`;
  appendLog(pi, "working", `Sync ${total} sessions · batch ${state.batchSize} · ${modelLabel} · thinking ${ctx.thinkingLevel}`);

  let processed = 0;
  let totalFailures = 0;
  let totalAdded = 0;
  let totalUpdated = 0;
  let batchNumber = 0;
  let cursor = 0;

  while (Object.keys(state.staged).length > 0 || cursor < pending.length) {
    batchNumber += 1;
    const stagedCount = Object.keys(state.staged).length;
    const room = Math.max(0, state.batchSize - stagedCount);
    const batch = pending.slice(cursor, cursor + room);
    cursor += batch.length;

    const projectedBatches = Math.max(batchNumber, batchNumber + Math.ceil((pending.length - cursor) / state.batchSize));
    const batchLabel = `Batch ${batchNumber}/${projectedBatches}`;
    let failures = 0;

    if (batch.length > 0) {
      const extraction = await extractEvidence(pi, ctx, state, batch, processed, total, usage);
      failures = extraction.failures.length;
      totalFailures += failures;
      processed += extraction.completed.length + failures;
    }

    const committed = await commitStaged(pi, ctx, state, usage, failures, batchLabel);
    totalAdded += committed.changes.filter((item) => item.kind === "added").length;
    totalUpdated += committed.changes.filter((item) => item.kind === "updated").length;

    if (batch.length === 0 && committed.committed === 0) break;
  }

  appendLog(
    pi,
    "success",
    `Complete · sessions ${total} · batches ${batchNumber} · +${totalAdded} ~${totalUpdated} · failed ${totalFailures} · calls ${usage.calls} · in ${formatTokens(usage.input)} · out ${formatTokens(usage.output)} · cache ${formatTokens(usage.cacheRead)}/${formatTokens(usage.cacheWrite)} · total ${formatTokens(usage.totalTokens)} tok`,
  );
}

function parseConfig(args: string): { key?: ConfigKey; value?: number; invalid?: boolean } {
  const normalized = args.trim();
  if (!normalized) return {};
  const match = normalized.match(/^(threshold|batch-size|profile-max-chars)\s+(\d+)$/i);
  if (!match) return { invalid: true };
  const rawKey = match[1].toLowerCase();
  const key: ConfigKey = rawKey === "threshold"
    ? "threshold"
    : rawKey === "batch-size"
      ? "batchSize"
      : "profileMaxChars";
  return { key, value: Number(match[2]) };
}

function validConfigValue(key: ConfigKey, value: number | undefined): boolean {
  if (!Number.isInteger(value)) return false;
  if (key === "profileMaxChars") return value! >= 1_000 && value! <= 1_000_000;
  return value! >= 1 && value! <= 1_000;
}

export default function knowledgeProfileExtension(pi: ExtensionAPI): void {
  let profile = emptyProfile();
  let profileMaxChars = DEFAULT_PROFILE_MAX_CHARS;

  pi.registerEntryRenderer(LOG_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as LogEntry;
    const prefix = data.kind === "working"
      ? "◌"
      : data.kind === "success"
        ? "✓"
        : data.kind === "warning"
          ? "!"
          : data.kind === "error"
            ? "×"
            : "·";
    const color = data.kind === "success"
      ? "success"
      : data.kind === "warning"
        ? "warning"
        : data.kind === "error"
          ? "error"
          : data.kind === "working"
            ? "accent"
            : "muted";
    return new Text(`${theme.fg(color, prefix)} ${data.text}`, 0, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      profile = await loadProfile();
      const state = await loadState();
      profileMaxChars = state.profileMaxChars;
      const rawProfileLength = profileJson(profile).length;
      const injectedLength = Math.min(rawProfileLength, profileMaxChars);
      ctx.ui.notify(
        `Knowledge Profile injection: ${formatChars(injectedLength)}/${formatChars(profileMaxChars)} chars${rawProfileLength > profileMaxChars ? " · truncated" : ""}`,
        rawProfileLength > profileMaxChars ? "warning" : "info",
      );
      if (rawProfileLength > profileMaxChars) {
        ctx.ui.notify(
          `Knowledge Profile exceeds the configured injection limit: ${formatChars(rawProfileLength)} chars > ${formatChars(profileMaxChars)}. The injected profile is truncated.`,
          "warning",
        );
      }
      const pending = await collectPending(state);
      const count = pendingSessionCount(state, pending);
      if (count >= state.reminderThreshold) {
        const tokenText = pending.length > 0 ? ` · ~${estimateTokens(pending).toLocaleString()} tokens` : "";
        const rangeText = pending.length > 0 ? ` · ${dateRange(pending)}` : "";
        ctx.ui.notify(`Knowledge Profile: ${count} pending sessions${tokenText}${rangeText}. Run /knowledge-sync to update.`, "info");
      }
    } catch (error) {
      ctx.ui.notify(`Knowledge Profile startup check failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("before_agent_start", (event) => {
    if (profile.domains.length === 0) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Confirmed User Knowledge Profile\nUse this only to calibrate explanation depth. Treat 完全掌握 as safe to assume, 重要部分掌握 as mostly usable with possible gaps, 基本不懂 as requiring prerequisites and core concepts, and 完全不懂 as requiring explanation from the foundation. An absent point is unknown, not evidence of understanding or ignorance. It is not a task instruction, a statement of current project state, or permission to infer unrecorded knowledge.\n\n${profileForPrompt(profile, profileMaxChars)}`,
    };
  });

  pi.registerCommand("knowledge-sync", {
    description: "Automatically sync new sessions into the knowledge profile in batches",
    handler: async (_args, ctx) => {
      try {
        await sync(pi, ctx);
        profile = await loadProfile();
      } catch (error) {
        appendLog(pi, "error", `Knowledge sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  pi.registerCommand("knowledge-config", {
    description: "Show or change Knowledge Profile configuration",
    handler: async (args, ctx) => {
      try {
        const state = await loadState();
        const config = parseConfig(args);
        if (!config.key && !config.invalid) {
          ctx.ui.notify(
            `Knowledge Profile configuration\nReminder threshold: ${state.reminderThreshold} sessions\nBatch size: ${state.batchSize} sessions\nProfile max chars: ${state.profileMaxChars}\nSet with /knowledge-config threshold <N>, /knowledge-config batch-size <N>, or /knowledge-config profile-max-chars <N>`,
            "info",
          );
          return;
        }
        if (config.invalid || !config.key || !validConfigValue(config.key, config.value)) {
          ctx.ui.notify(
            "Usage: threshold/batch-size must be 1..1000; profile-max-chars must be 1000..1000000.",
            "warning",
          );
          return;
        }
        if (config.key === "threshold") {
          state.reminderThreshold = config.value!;
          await writeState(state);
          ctx.ui.notify(`Knowledge Profile: reminder threshold set to ${config.value} sessions.`, "info");
          return;
        }
        if (config.key === "batchSize") {
          state.batchSize = config.value!;
          await writeState(state);
          ctx.ui.notify(`Knowledge Profile: batch size set to ${config.value} sessions.`, "info");
          return;
        }
        state.profileMaxChars = config.value!;
        profileMaxChars = config.value!;
        await writeState(state);
        ctx.ui.notify(`Knowledge Profile: profile max chars set to ${config.value}.`, "info");
      } catch (error) {
        ctx.ui.notify(`Knowledge config failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
