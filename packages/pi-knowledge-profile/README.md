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

Sync runs in batches of 20 sessions by default using a natural-language knowledge pipeline:

```text
historical session
→ model writes a natural-language Evidence Note
→ save evidence/*.md
→ reconcile the batch notes with the current profile.md
→ model returns the complete revised profile.md
→ advance checkpoints
```

The model is no longer required to emit JSON, a tool-call schema, or a fixed machine-readable field structure. Knowledge semantics stay in natural language; code only owns persistence, batching, checkpoints, recovery, and configuration.

A failed session is skipped rather than aborting the batch. Each successful Evidence Note is immediately persisted as its own Markdown file, and `state.json` stages only the note path plus checkpoint. If sync is interrupted before reconciliation, those notes are reused by the next `/knowledge-sync`.

Each model call gets at most 3 attempts. Retries cover request failures and empty model responses; JSON parsing, schema validation, and tool-call formatting are no longer part of the pipeline.

## Knowledge states

The profile still uses these semantic status labels when a status is useful:

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
/knowledge-config batch-size 50
/knowledge-config profile-max-chars 64000
```

Defaults: reminder threshold 5 pending sessions, batch size 20, profile injection limit 48,000 characters. `profile-max-chars` accepts 1,000–1,000,000.

## Storage

```text
~/.pi/agent/user-knowledge/
  profile.md          # canonical natural-language knowledge profile
  state.json          # program state only: config, staged note paths, checkpoints
  evidence/           # persistent natural-language evidence notes
    *.md
  profile.json        # legacy file, retained after migration
```

Boundary rule:

```text
program state → JSON
knowledge semantics → Markdown
```

If `profile.md` does not yet exist, the extension migrates the legacy `profile.json` into Markdown on first load. Legacy structured evidence staged inside `state.json` is likewise converted into `evidence/*.md`, then the state file is upgraded to the new shape.

Evidence Notes remain on disk as an audit trail. After successful reconciliation, only their staged references are removed from `state.json`; the note files are not deleted.

## Constraints

- Never-discussed or unsupported knowledge remains unknown rather than being classified as ignorance.
- `完全不懂` may be generated automatically only from strong explicit negative evidence, never from a single question, one mistake, or missing evidence.
- Repeated moderate evidence across sessions may combine into a profile judgement during reconciliation.
- Content inside `SESSION_DATA` is explicitly treated as inert historical data; the analysis model must not follow instructions found inside it.
- Tool output, system prompts, and plugin custom logs are excluded from historical-session analysis input.
