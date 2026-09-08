# pi-knowledge-profile

An evidence-backed Pi extension that automatically maintains a bidirectional user knowledge profile across sessions.

It is not a general memory system. It records both what the user demonstrably understands and which knowledge still needs explanation, so the Agent can calibrate explanation depth. Syncs are automatic after the user invokes the command, and every run reports what changed so the user can correct the profile through normal conversation.

## Install

```bash
pi install npm:pi-knowledge-profile
```

## Usage

At startup, the extension counts unsynced sessions. When the count reaches the configured threshold, 5 by default, Pi shows a non-blocking reminder. Startup never calls a model or performs a sync.

Run:

```text
/knowledge-sync
```

Sync runs in batches of 20 sessions by default. Each batch independently extracts positive and negative knowledge evidence, reconciles it against the current profile, updates `profile.json`, regenerates Markdown views, advances that batch's checkpoints, and immediately displays the batch diff. Large first-time imports therefore produce profile updates progressively instead of waiting for every session to finish.

A failed session is skipped rather than aborting the batch. Evidence from every successful extraction is immediately staged in `state.json`. If sync is interrupted, completed batches are already committed and extracted evidence from the current batch remains staged for the next `/knowledge-sync`.

## Knowledge states

The profile uses four states:

- `完全掌握`: the point can normally be assumed without repeating basics.
- `重要部分掌握`: the core is usable, but relevant gaps or boundaries may still need explanation.
- `基本不懂`: there is concrete evidence of material gaps, misconceptions, or unstable understanding; explain prerequisites and core concepts first.
- `完全不懂`: strong explicit evidence shows essentially no foundation in that specific point; explain it from the foundation.

An absent knowledge point means unknown, not understood and not misunderstood.

Extraction labels evidence as `positive | negative` and `strong | moderate`. Negative evidence requires an actual demonstrated gap, such as explicitly stating a lack of background, clearly explaining a core concept incorrectly, remaining confused after explanation, or explicitly asking to start from basics because the background is missing. A question, request for explanation, isolated terminology use, acknowledgement, or acceptance alone is never evidence of ignorance.

## Configuration

```text
/knowledge-config
/knowledge-config threshold 10
/knowledge-config batch-size 50
```

The default reminder threshold is 5 pending sessions. The default batch size is 20 sessions.

## Storage

```text
~/.pi/agent/user-knowledge/
  profile.json        # canonical structured profile
  state.json          # reminder threshold, batch size, staged evidence, checkpoints
  views/              # Markdown generated one-way from profile.json
    Git.md
    WebGPU.md
```

`profile.json` uses a fixed Domain → Subdomain → Knowledge Point hierarchy. Each point stores status, context, evidence, reason, and `updatedAt`.

Markdown is a derived view only and is never parsed back into JSON.

## Constraints

- Never-discussed or unsupported knowledge remains unknown rather than being classified as ignorance.
- `完全不懂` may be generated automatically only from strong explicit negative evidence, never from a single question, one mistake, or missing evidence.
- Repeated moderate evidence across sessions may combine into a profile judgement during reconciliation.
- Tool output, system prompts, and raw logs are excluded from analysis input.
- The old 24-candidate review limit is removed; only a much higher internal safety cap remains.
