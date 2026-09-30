# pi-whereami

English | [简体中文](README.zh-CN.md)

## The agent is still working. But where is it now?

During a long task, an agent can read file after file, follow a call chain, and keep making tool calls. It becomes hard to tell what it has learned—or whether the next step still serves the original task.

`pi-whereami` periodically asks the **agent already doing the work** to pause and re-orient:

- Where am I working, and at what level?
- What do I currently understand?
- Is this path still useful, or am I following it out of momentum?
- What is the next useful action?

It records a short checkpoint, then lets the agent continue. You can see the latest position above the editor and look back at earlier checkpoints in the conversation.

**No second agent. No need to keep asking “where are we?”**

## Install

Requires **Pi 0.87.1 or newer**.

```bash
pi install npm:pi-whereami
```

Start Pi, or run `/reload` in an existing session. Then give the agent a task as usual. There is no command to run or setup required.

To try it directly from this repository, run this from the repository root:

```bash
pi -e ./packages/pi-whereami/index.ts
```

## What you see

A compact panel appears above the editor when the agent starts working. For example:

```text
whereami · Decisions: 13/20 · Checkpoints: 1 · Latest checkpoint
Level: module · Scope: rendering pipeline
State: invalidation remains the likely issue
Next: inspect the dirty propagation boundary
```

The four fields describe the agent's position:

| Field | Meaning |
| --- | --- |
| Level | The level of detail it is working at, such as subsystem, module, or function. |
| Scope | The part of the problem it is currently focused on. |
| State | Its current understanding—not a transcript of its reasoning. |
| Next | The next key action it plans to take. |

`Decisions: 13/20` means 13 main-task responses have completed since your last message; the next check is due at 20. It is **not** a task-completion percentage. `Checkpoints: 1` means one checkpoint has been successfully recorded during that period.

Before the first checkpoint, the panel says `Awaiting first checkpoint`. While collecting one, it says `Updating checkpoint`. The position fields update only when a valid checkpoint arrives: **this is a periodic snapshot, not a live tool-activity feed**.

The panel stays visible after the agent finishes or is interrupted. Your next message resets it, but earlier checkpoints remain in conversation history. Resuming a session or switching branches restores the corresponding position when execution starts.

Panel labels are currently English. Non-interactive modes still record checkpoints, but do not show the panel.

## When it checks

After each new user message, the first check is due after **12 main-task model responses**. The next intervals are **8, 6, then 4 responses**, repeating every 4 thereafter.

A response counts once, whether it calls one tool or several tools in parallel. These are model turns, not individual tool calls or elapsed time. A response used only to collect a checkpoint does not count toward the next interval.

Checks wait until the current batch of task tools finishes, and give pending user input priority. The extension does not restart a finished task just to collect a checkpoint, so short tasks may finish without one.

## What it does—and does not—promise

The default reminder asks the agent to reconsider its working level, main uncertainty, and choice of evidence. If another path would be more informative, it encourages a change. If the current deep dive is productive, it encourages staying with it.

**The extension prompts a reassessment; it does not decide whether the agent is right.**

- It does not independently detect drift, verify progress, or force a direction change.
- A checkpoint is the agent's own account of its position, not proof that a milestone is complete.
- It uses your current agent and model. There is no separate reviewer model or API key, but checks can add model turns, tokens, and latency.
- Checkpoints are saved in the session and included in later model context. Pi's automatic compaction may summarize older ones.
- If the agent fails to provide a valid checkpoint, no new position is recorded and work continues. The panel keeps the last valid position, if any.

It is useful when you want occasional orientation during long investigations or implementation tasks—not another agent supervising every step.

## Optional: change the reminder

The built-in reminder works without configuration. To replace it, create:

```text
~/.pi/agent/whereami/reorient.md
```

For example:

```markdown
Before continuing, check whether the recent work has narrowed the main uncertainty.
If not, consider a competing explanation or a different source of evidence.
Keep a productive investigation on course; do not change direction just to change it.
```

This file **replaces** the built-in re-orientation reminder. You do not need to specify the checkpoint format: the extension still asks for the four fields and tells the agent to continue the original task.

Run `/reload` after editing it. A missing, empty, or unreadable file uses the default reminder. If you set `PI_CODING_AGENT_DIR`, the file belongs under that directory's `whereami/reorient.md` instead. There are no project-specific reminder files or interval settings.

## License

MIT.
