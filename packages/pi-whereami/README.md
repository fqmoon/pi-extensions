# pi-whereami

English | [简体中文](README.zh-CN.md)

> **LLM: Just tell me whether I caught the fish. Don't worry about why I went through the Sahara.**

Some models score well and can finish the task, but their paths can be bizarre: almost like depth-first search, taking detours through nowhere before eventually getting there.

They usually have not forgotten the goal. They just keep drilling through files, call chains, and local evidence. Each step can look reasonable on its own, while the whole path becomes increasingly absurd, especially on analysis-heavy tasks.

`pi-whereami` waits until the agent has made a number of consecutive decisions, then **forces it to re-examine the current path: is this still worth pursuing, or should it switch approaches before it disappears into a rabbit hole?**

After that re-orientation, the agent leaves a short checkpoint and continues the original task:

```text
Level: module
Scope: rendering pipeline
State: invalidation remains the likely issue
Next: inspect the dirty propagation boundary
```

Checkpoints are kept in conversation history. The checkpoint tool itself is not gated by the periodic trigger: any valid checkpoint call is recorded immediately and shown in the HUD. Recording one does not reset or advance the re-orientation schedule.

The extension also provides a HUD so the user can see the agent's latest recorded position and current status:

```text
whereami · Decisions: 13/20 · Checkpoints: 1 · Checkpoint at decision 12
```

`13/20` means model decision turns, not tool calls and not task-completion percentage. `Checkpoint at decision 12` means the latest recorded checkpoint was taken after the 12th decision.

The default check intervals gradually shorten:

```text
20 → 15 → 10 → 10 → ...
```

Each new user message resets the count.

## Configuration

To change the schedule, create:

```text
~/.pi/agent/whereami/config.json
```

For example:

```json
{
  "intervals": [30, 20, 10]
}
```

`intervals` must contain **1 to 8 positive integers**. The last value repeats indefinitely, so `[30, 20, 10]` means `30 → 20 → 10 → 10 → ...`. Missing or invalid configuration falls back to the default `[20, 15, 10]`. Run `/reload` after editing the file.

It does not supervise the agent or decide whether the agent is correct. It simply interrupts a long chain of decisions often enough to make the agent look back and ask:

**Is this path still worth drilling into?**

## Install

Requires **Pi 0.87.1+**.

```bash
pi install npm:pi-whereami
```

After installation, use Pi normally. No extra command is required.

## Custom re-orientation

When a periodic check fires, `pi-whereami` gives the current agent a re-orientation prompt that tells it what to reconsider about the path it is taking, then asks it to leave a checkpoint.

The default prompt focuses on questions such as:

- What abstraction level and scope am I currently working in?
- Has the recent work actually reduced the main uncertainty?
- Is the current path still the most informative one?
- Am I continuing mainly because of momentum, local adjacency, or an outdated assumption?
- Would another abstraction level, competing hypothesis, or evidence source resolve the important uncertainty more directly?

If you want the agent to "look back at the road" differently, create:

```text
~/.pi/agent/whereami/reorient.md
```

This file **completely replaces the default re-orientation prompt**.

For example, you can make it focus more on competing hypotheses:

```markdown
Before continuing, check whether the recent work has reduced the main uncertainty.
If not, consider a competing explanation or a different source of evidence.
If the current path is still productive, keep it; do not change direction just to change it.
```

You can also tailor it to emphasize abstraction level, evidence quality, implementation boundaries, or whatever your workflow is most likely to get stuck on.

The custom prompt only defines **what the agent should reconsider**. The checkpoint format, `Level / Scope / State / Next`, is still controlled by the extension and does not need to be repeated in the file.

Run:

```text
/reload
```

after editing it.

If the file is missing, empty, or unreadable, the built-in prompt is used instead.

## License

MIT
