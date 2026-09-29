# pi-whereami

A Phase 1 Pi extension that asks the **current agent** for a brief position snapshot during long autonomous runs. No second model, direction checking, steering, settings, or panel.

Requires `@earendil-works/pi-coding-agent` 0.87.1 or newer. Install the package with Pi or load `index.ts` directly. This monorepo loads it via the root `pi.extensions` manifest.

After each actual user message, the first check is after 12 task tool calls; later checks are after 8, 6, 4, 4… calls. A new user message resets this schedule. A parallel tool batch cannot be interrupted: the check occurs at the safe turn boundary after that batch. UI/status-only calls and the snapshot tool itself do not count. Other task tools count once per completed call, including a failed call that still produced a tool result.

The extension asks the main agent to fill four short fields through its own `whereami_snapshot` tool. Once filled, the extension stores a visible `pi-whereami` custom message in the current session:

```text
[whereami]

Level: module
Scope: rendering pipeline
State: invalidation remains the likely issue
Next: inspect the dirty propagation boundary
```

Pi stores this as a `custom_message`, so it survives session resume and follows the current branch. For model requests Pi represents custom messages as user-role content; they are **not** real user input and do not reset the schedule. The tool result is only an acknowledgement; the snapshot is not also emitted as an assistant progress report. If fields are missing, too long, or malformed, the check is skipped and the agent keeps working. Automatic context compaction may summarize earlier history rather than keeping old snapshots verbatim in later model requests.

From the monorepo root, run the offline tests with `node --test packages/pi-whereami/test/*.test.ts` (Node 24+). The monorepo's existing lockfile has an older PI SDK; the extension itself targets the host PI version indicated above.
