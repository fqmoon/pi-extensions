# pi-whereami

A Pi extension that periodically asks the **current agent** to re-orient and record a brief position checkpoint during long autonomous runs. A compact HUD above the editor displays the current run state while the same checkpoints continue to appear in conversation history. No second model, automatic drift detection, forced direction change, or settings UI.

Requires `@earendil-works/pi-coding-agent` 0.87.1 or newer. Install the package with Pi or load `index.ts` directly. This monorepo loads it via the root `pi.extensions` manifest.

After each actual user message, the first check is after 12 main-task **LLM decision turns**; later checks are after 8, 6, 4, 4… decisions. A new user message resets this schedule. One completed main-task assistant response counts once, whether it calls one tool, twenty parallel tools, a status tool, or no tools. For example, parallel reads of A/B/C in one response count as one decision; reading A, B, and C in three successive responses counts as three. Failed tool results still count when the assistant response itself completed normally; provider error/aborted responses and internal HTTP retries do not count.

The check occurs at the safe turn boundary after the entire tool batch. Text/final responses count but never force a continuation just to collect a checkpoint; a due interval is consumed only at a subsequent safe task-tool boundary, with no pending input and the checkpoint tool available. A plugin-requested collection response without other task tool calls does not count, even if it includes text/thinking or omits/malforms the checkpoint. A requested response that also calls ordinary task tools counts once, whether or not it fills the checkpoint.

At each check, the extension temporarily asks the main agent to reassess its current abstraction level, scope, and whether its path is still informative rather than merely adjacent. It may keep a productive deep dive; the plugin does not judge the direction. The main agent then fills four required short fields through its own `whereami_checkpoint` tool. The request is visible only to that model call, not saved in the session. Once filled, the extension stores a visible `pi-whereami-checkpoint` custom message in the current session:

```text
[whereami checkpoint]

Level: module
Scope: rendering pipeline
State: invalidation remains the likely issue
Next: inspect the dirty propagation boundary
```

A checkpoint records a point in task progress, not necessarily a completed milestone. The tool is `whereami_checkpoint`, its result exposes `details.checkpoint`, and durable records use the `pi-whereami-checkpoint` custom message type with a `[whereami checkpoint]` marker. The extension identity remains `pi-whereami`.

In interactive mode, the HUD appears when the agent starts executing and stays visible after the run ends, including errors or aborts. Later runs update the same panel. All panel labels are English. Its header always includes `Decisions: A/B` and `Checkpoints: N`, alongside the latest checkpoint's Level / Scope / State / Next. Both counts reset to zero on each delivered real user message. A counts the same main-task decisions as the existing trigger; checkpoint-only collection responses do not increment it. B is the cumulative next trigger threshold: `0/12`, `12/12` during collection, `12/20` after collection, then `13/20`; later thresholds are 26, 30, 34… under the existing 12 → 8 → 6 → 4… intervals. If a due check is deferred by the existing trigger gates, the next threshold follows the actual consumed boundary. N counts valid recorded checkpoints, so failed checks advance the trigger stage without incrementing N.

Before any checkpoint exists for the current user message, the header says `Awaiting first checkpoint` and no position fields are shown. A new user message clears the fields together with both counts; the HUD only shows the latest valid checkpoint counted by `Checkpoints: N`. Earlier checkpoints remain in conversation history. During collection it says `Updating checkpoint`. Progress remains visible in all these states, including after a successful checkpoint. The panel never invents an initial position or requests an extra model response.

The HUD restores its counts and fields from the active session branch on resume or tree navigation, initially staying hidden if idle until execution starts, and clears on session shutdown/reload. Malformed checkpoints leave the last valid position for the current user message intact, or leave the fields empty if none exists. Headless modes skip the widget, and a UI failure cannot interfere with trigger bookkeeping or message persistence. Position fields are periodic checkpoints rather than a real-time tool/activity tracker; existing trigger intervals and history/context behavior are unchanged.

To replace the built-in re-orientation strategy, create `<agent-dir>/whereami/reorient.md` (by default `~/.pi/agent/whereami/reorient.md`; `PI_CODING_AGENT_DIR` overrides `<agent-dir>`). A missing, blank, or unreadable file falls back to the built-in strategy. The file is read once when the extension loads; changing it requires reloading the extension. Its content **replaces** the default strategy, but the plugin always appends its own checkpoint instructions, including the fixed Level / Scope / State / Next fields and a request not to report the analysis separately. There is no project-specific prompt hierarchy or live file watching.

Pi stores the checkpoint as a `custom_message`, so it survives session resume and follows the current branch. For model requests Pi represents custom messages as user-role content; they are **not** real user input and do not reset the schedule. A non-context `pi-whereami-check` entry records the consumed trigger stage for resume and branching, even if the check fails. New checks identify the decision unit, and a non-context `pi-whereami-response` entry identifies the assistant response actually answering that request. This keeps interrupted collection from excluding unrelated work after resume. Replay counts assistant responses in the raw active branch, not tool results or the projected model context. Existing trigger checks retain their consumed stage, with subsequent history recounted in decisions; historical trigger positions are not rewritten.

On a successful checkpoint-only turn, append-only context edits omit its assistant tool call and tool result from future model context while retaining both in the raw session. When other task work shares the turn, no cleanup is attempted. The tool result is only an acknowledgement; the checkpoint is not also emitted as an assistant progress report. If fields are missing, too long, or malformed, the check is skipped and the agent keeps working. Automatic context compaction may summarize earlier history rather than keeping old checkpoints verbatim in later model requests.

Evaluate search quality separately on real long tasks: check whether an uninformative file chain changes level or evidence source, a productive deep dive stays on course, stagnant work considers a competing explanation, and a clearly wrong direction changes `Next` substantively. Offline tests verify the mechanism, not these model behaviors.

From the monorepo root, run the offline tests with `node --test packages/pi-whereami/test/*.test.ts` (Node 24+). The monorepo's existing lockfile has an older PI SDK; the extension itself targets the host PI version indicated above.
