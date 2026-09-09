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

Sync no longer batches by session count and no longer applies a fixed per-session truncation. All pending historical messages form one logical sync batch and are split into input chunks bounded by `chunk-max-chars`, 100,000 characters by default.

A long session or even a single long message can span multiple input chunks; later content is not discarded merely because it exceeds a fixed session/message cap.

The logical batch is reduced through a natural-language evidence accumulator:

```text
all pending historical messages
→ split into N chunks by chunk-max-chars
→ part 1/N + empty accumulator → accumulator 1
→ part 2/N + accumulator 1 → accumulator 2
→ ...
→ part N/N + accumulator N-1 → final Evidence Note
→ Evidence Note + current profile.md
→ one reconciliation call returns the complete revised profile.md
→ advance all related checkpoints
```

Every request tells the model which part it is receiving and how many parts exist in total. Earlier raw transcript is not resent; the previous accumulator carries forward retained evidence. This allows very large histories to be processed incrementally without repeatedly replaying all prior raw text.

The model is not required to emit JSON, a tool-call schema, or a fixed machine-readable field structure. Knowledge semantics remain natural language; code owns persistence, chunking, checkpoints, recovery, and configuration.

No checkpoint advances while the logical batch is still being reduced. Sessions are committed only after the final Evidence Note is produced, persisted under `evidence/*.md`, and successfully reconciled into `profile.md`. Legacy staged notes are reconciled first on the next `/knowledge-sync` before new history is analyzed.

Each model call gets at most 3 attempts. Retries cover request failures and empty responses. Empty/model-error diagnostics report stop reason, provider error message, content block types, and token usage.

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
  state.json          # program state only: config, staged note paths, checkpoints
  evidence/           # final natural-language evidence note for each logical sync
    *.md
  profile.json        # legacy file, retained after migration
```

Boundary rule:

```text
program state → JSON
knowledge semantics → Markdown
```

If `profile.md` does not yet exist, the extension migrates the legacy `profile.json` into Markdown on first load. Legacy structured evidence staged inside `state.json` is likewise converted into `evidence/*.md`. Legacy `batchMaxChars` migrates to `chunkMaxChars`.

Evidence Notes remain on disk as an audit trail. After successful reconciliation, only their staged references are removed from `state.json`; the note files are not deleted.

## Constraints

- Never-discussed or unsupported knowledge remains unknown rather than being classified as ignorance.
- `完全不懂` may be generated automatically only from strong explicit negative evidence, never from a single question, one mistake, or missing evidence.
- Repeated moderate evidence across sessions may combine in the accumulator and reconciliation stages.
- Content inside `SESSION_DATA` is explicitly treated as inert historical data; the analysis model must not follow instructions found inside it.
- Tool output, system prompts, and plugin custom logs are excluded from historical-session analysis input.
