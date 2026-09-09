# pi-knowledge-profile

An evidence-backed Pi extension that automatically maintains a bidirectional user knowledge profile across sessions.

It is not a general memory system. It records both what the user demonstrably understands and which knowledge still needs explanation, so the Agent can calibrate explanation depth. Knowledge content is stored and reconciled as Markdown; JSON is reserved for program state.

## Install

```bash
pi install npm:pi-knowledge-profile
```

## Usage

At startup, the extension loads `profile.md` and reports how much of it can be injected into the Agent prompt. The default maximum is 48,000 characters. If the profile is larger, only the injected context is truncated; the full file on disk remains unchanged.

Startup also counts unsynced sessions. When the count reaches the configured threshold, 5 by default, Pi shows a non-blocking reminder. Startup never calls a model or performs a sync.

Run:

```text
/knowledge-sync
```

Sync no longer batches by session count and no longer applies a fixed per-session or per-message truncation. All pending historical messages form one logical sync input and are split into chunks bounded by `chunk-max-chars`, 100,000 characters by default.

A long session or even one long message can span multiple chunks; later content is not discarded merely because it exceeds a fixed cap.

Each chunk performs exactly two model calls: Extract, then Reconcile.

```text
all pending historical messages
→ split into N chunks by chunk-max-chars
→ Chunk 1: Extract(raw chunk) → Evidence Note 1
→ Chunk 1: Reconcile(profile + Evidence Note 1) → profile 1
→ Chunk 2: Extract(raw chunk) → Evidence Note 2
→ Chunk 2: Reconcile(profile 1 + Evidence Note 2) → profile 2
→ ...
→ Chunk N: Extract(raw chunk) → Evidence Note N
→ Chunk N: Reconcile(profile N-1 + Evidence Note N) → profile N
→ advance all related session checkpoints
```

There is no evidence accumulator. Extract is responsible only for extracting knowledge evidence from the current raw chunk. Reconcile is responsible only for merging that Evidence Note into the current `profile.md`.

Every chunk produces persistent stage output. Its Evidence Note is immediately written under `evidence/*.md`; after reconciliation succeeds, the revised `profile.md` is immediately written as well. If a 12-chunk sync stops after chunk 6, the first six Evidence Notes and their profile updates are already on disk.

`state.json` stores an `activeSync` progress record containing the input fingerprint, total chunk count, and next chunk index. If the source input is unchanged, a later `/knowledge-sync` resumes from the next unreconciled chunk instead of starting over.

Because a chunk may split through the middle of a session, session checkpoints are not advanced after every chunk. They advance only after all chunks in the logical sync have completed, preventing a half-processed long session from being marked complete.

The UI reports each model call before it starts, including the operation, input size, selected model, and thinking level. A typical sequence looks like:

```text
◌ Chunk 3/8 · Extract · raw 92k chars · provider/model · thinking medium
✓ Chunk 3/8 · Extract saved · evidence 6.2k chars
◌ Chunk 3/8 · Reconcile · profile 14k chars + evidence 6.5k chars · provider/model · thinking medium
✓ Chunk 3/8 · Reconcile saved · profile 14k→15k chars
```

Retries keep the same operation label and report the attempt number. Each model call gets at most 3 attempts. Retries cover request failures and empty responses. Empty/model-error diagnostics report stop reason, provider error message, content block types, and token usage.

The model is not required to emit JSON, a tool-call schema, or a fixed machine-readable field structure. Knowledge semantics remain natural language; code owns persistence, chunking, checkpoints, recovery, and configuration.

Legacy staged Evidence Notes are still supported. On the next `/knowledge-sync`, they are reconciled before the new chunk flow begins.

## Knowledge states

The profile still uses these semantic status labels when useful:

- `完全掌握`: the point can normally be assumed without repeating basics.
- `重要部分掌握`: the core is usable, but relevant gaps or boundaries may still need explanation.
- `基本不懂`: there is concrete evidence of material gaps, misconceptions, or unstable understanding; explain prerequisites and core concepts first.
- `完全不懂`: strong explicit evidence shows essentially no foundation in that specific point; explain it from the foundation.

These are Markdown conventions rather than JSON enums. An absent knowledge point means unknown, not understood and not misunderstood.

Negative evidence still requires an actual demonstrated gap, such as explicitly stating a lack of background, clearly explaining a core concept incorrectly, remaining confused after explanation, or explicitly asking to start from basics because the background is missing. A question, request for explanation, isolated terminology use, acknowledgement, or acceptance alone is never evidence of ignorance.

## Configuration

```text
/knowledge-config
/knowledge-config threshold 10
/knowledge-config chunk-max-chars 150000
/knowledge-config profile-max-chars 64000
```

Defaults: reminder threshold 5 pending sessions, raw input chunk limit 100,000 characters, profile injection limit 48,000 characters.

`threshold` accepts 1–1,000. `chunk-max-chars` and `profile-max-chars` accept 1,000–1,000,000.

Legacy `batch-max-chars` is still accepted/read as a compatibility alias for `chunk-max-chars`. The old `batch-size` setting is no longer used.

## Storage

```text
~/.pi/agent/user-knowledge/
  profile.md          # canonical natural-language knowledge profile
  state.json          # program state: config, activeSync, legacy staged notes, checkpoints
  evidence/           # persistent Evidence Note for every processed chunk
    *.md
  profile.json        # legacy file, retained after migration
```

Boundary rule:

```text
program state → JSON
knowledge semantics → Markdown
```

If `profile.md` does not yet exist, the extension migrates the legacy `profile.json` into Markdown on first load. Legacy structured evidence staged inside `state.json` is likewise converted into `evidence/*.md`. Legacy `batchMaxChars` migrates to `chunkMaxChars`.

Chunk Evidence Notes remain on disk as an audit trail. `activeSync` stores only recovery-oriented program state and does not carry knowledge semantics.

## Constraints

- Never-discussed or unsupported knowledge remains unknown rather than being classified as ignorance.
- `完全不懂` may be generated automatically only from strong explicit negative evidence, never from a single question, one mistake, or missing evidence.
- Evidence from multiple chunks accumulates into the long-lived profile through sequential reconciliation.
- Content inside `SESSION_DATA` is explicitly treated as inert historical data; the analysis model must not follow instructions found inside it.
- Tool output, system prompts, and plugin custom logs are excluded from historical-session analysis input.
