# pi-whereami

A Pi extension that periodically asks the **current agent** to re-orient and record a brief position snapshot during long autonomous runs. No second model, automatic drift detection, forced direction change, settings UI, or panel.

Requires `@earendil-works/pi-coding-agent` 0.87.1 or newer. Install the package with Pi or load `index.ts` directly. This monorepo loads it via the root `pi.extensions` manifest.

After each actual user message, the first check is after 12 task tool calls; later checks are after 8, 6, 4, 4… calls. A new user message resets this schedule. A parallel tool batch cannot be interrupted: the check occurs at the safe turn boundary after that batch. UI/status-only calls and the snapshot tool itself do not count. Other task tools count once per completed call, including a failed call that still produced a tool result.

At each check, the extension temporarily asks the main agent to reassess its current abstraction level, scope, and whether its path is still informative rather than merely adjacent. It may keep a productive deep dive; the plugin does not judge the direction. The main agent then fills four required short fields through its own `whereami_snapshot` tool. The request is visible only to that model call, not saved in the session. Once filled, the extension stores a visible `pi-whereami` custom message in the current session:

```text
[whereami]

Level: module
Scope: rendering pipeline
State: invalidation remains the likely issue
Next: inspect the dirty propagation boundary
```

To replace the built-in re-orientation strategy, create `<agent-dir>/whereami/reorient.md` (by default `~/.pi/agent/whereami/reorient.md`; `PI_CODING_AGENT_DIR` overrides `<agent-dir>`). A missing, blank, or unreadable file falls back to the built-in strategy. The file is read once when the extension loads; changing it requires reloading the extension. Its content **replaces** the default strategy, but the plugin always appends its own snapshot instructions, including the fixed Level / Scope / State / Next fields and a request not to report the analysis separately. There is no project-specific prompt hierarchy or live file watching.

Pi stores the snapshot as a `custom_message`, so it survives session resume and follows the current branch. For model requests Pi represents custom messages as user-role content; they are **not** real user input and do not reset the schedule. A non-context `pi-whereami-check` entry records the consumed trigger stage for resume and branching, even if the check fails. On a successful snapshot-only turn, append-only context edits omit its assistant tool call and tool result from future model context while retaining both in the raw session. When other task work shares the turn, no cleanup is attempted. The tool result is only an acknowledgement; the snapshot is not also emitted as an assistant progress report. If fields are missing, too long, or malformed, the check is skipped and the agent keeps working. Automatic context compaction may summarize earlier history rather than keeping old snapshots verbatim in later model requests.

Evaluate search quality separately on real long tasks: check whether an uninformative file chain changes level or evidence source, a productive deep dive stays on course, stagnant work considers a competing explanation, and a clearly wrong direction changes `Next` substantively. Offline tests verify the mechanism, not these model behaviors.

From the monorepo root, run the offline tests with `node --test packages/pi-whereami/test/*.test.ts` (Node 24+). The monorepo's existing lockfile has an older PI SDK; the extension itself targets the host PI version indicated above.
