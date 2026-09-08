# pi-knowledge-profile

An evidence-backed Pi extension that automatically maintains a user knowledge profile across sessions.

It is not a general memory system. It records knowledge states only when conversation evidence is strong enough, so the Agent can calibrate explanation depth. Syncs are automatic after the user invokes the command, and every run reports what changed so the user can correct the profile through normal conversation.

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

The sync extracts conservative evidence session by session, reconciles it across sessions, automatically updates `profile.json`, regenerates Markdown views, advances checkpoints, and displays added or updated knowledge points.

A failed session is skipped rather than aborting the batch. Evidence from every successful extraction is immediately staged in `state.json`, so an interrupted run can resume on the next `/knowledge-sync`.

## Configuration

```text
/knowledge-config
/knowledge-config threshold 10
```

The default reminder threshold is 5 pending sessions.

## Storage

```text
~/.pi/agent/user-knowledge/
  profile.json        # canonical structured profile
  state.json          # reminder threshold, staged evidence, checkpoints
  views/              # Markdown generated one-way from profile.json
    Git.md
    WebGPU.md
```

`profile.json` uses a fixed Domain → Subdomain → Knowledge Point hierarchy. Each point stores status, context, evidence, reason, and `updatedAt`.

Markdown is a derived view only and is never parsed back into JSON.

## Constraints

- A question, isolated terminology use, acknowledgement, or acceptance is not enough evidence by itself.
- Tool output, system prompts, and raw logs are excluded from analysis input.
- `完全不懂` is never inferred automatically.
- The old 24-candidate review limit is removed; only a much higher internal safety cap remains.
