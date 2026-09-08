# pi-knowledge-profile

An evidence-backed, user-confirmed knowledge profile for [Pi](https://pi.dev/).

It is deliberately not a general memory system. It records only what the user has reviewed and confirmed about their knowledge, so Pi can safely choose what to take as an explanation prerequisite.

## Install

```bash
pi install npm:pi-knowledge-profile
```

## Workflow

At the first Pi startup after the weekly reminder period, the extension loads the confirmed profile and shows a non-blocking notification when unprocessed sessions exist:

```text
Knowledge Profile: 12 pending sessions · ~48k tokens · 2026-09-01–2026-09-08.
Run /knowledge-sync to review updates.
```

`/knowledge-sync` then:

1. scans only new entries since the last completed sync;
2. extracts conservative evidence per session with the selected Pi model;
3. reconciles evidence across sessions into candidates;
4. shows each candidate's context, evidence, and reason, then asks for a user decision;
5. atomically writes accepted records to domain Markdown files and advances the checkpoint.

The command is the only path that runs analysis or changes the profile. Startup never opens a modal or calls a model.

## Storage

The profile is stored under `~/.pi/agent/user-knowledge/`:

```text
state.json                 # schedule and per-session incremental checkpoints
Graphics.md                # one Markdown file per domain
Software engineering.md
```

Each confirmed item uses exactly three knowledge levels: domain, subdomain, and knowledge point. The statuses are `完全掌握`, `重要部分掌握`, `基本不懂`, and `完全不懂`. An absent item means no confirmed judgement, not lack of knowledge.

## Safety rules

- A question, a one-off term, `懂了`, or accepting an explanation is not enough evidence by itself.
- Every candidate contains distinct context, concrete evidence, and reasoning.
- The user may keep the current state or decline to record an item.
- Tool output, system prompts, and raw logs are excluded from the analysis input.
- Session checkpoints advance only after the review finishes successfully.

## Limits of the first release

The review UI intentionally uses Pi's standard selector rather than a custom panel. Candidate generation is bounded per session to control cost. The default reminder frequency is weekly; edit `state.json` and set `"frequency": "daily"` to use a daily reminder.
