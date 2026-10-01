# pi-extensions

Some extensions for pi-agent.

## Extensions

### tail

Save the tail of the current conversation as Markdown, ending at the latest assistant response.

Location: [`packages/pi-chat-tail`](./packages/pi-chat-tail)

```text
/tail
/tail 2
/tail 4
```

The optional positional argument is the number of recent user/assistant messages to save. It defaults to `1`.

Each extension is kept as an independent package so it can be published to npm separately while remaining in this monorepo.


### whereami

Periodically prompts the agent to re-orient during long tasks and record a brief checkpoint with the `whereami_checkpoint` tool. It counts main-task LLM decision turns after each user message; the default intervals are 20, then 15, then 10 turns (repeating). A HUD above the editor shows decision progress, the next trigger threshold, and the latest checkpoint. Checkpoints are saved in conversation history, and the HUD stays visible after each agent run ends.

Location: [`packages/pi-whereami`](./packages/pi-whereami). Requires Pi 0.87.1 or newer. No command is needed; optional interval and re-orientation prompt configuration is available.

## Archived

- [`pi-knowledge-profile`](./archive/pi-knowledge-profile) — archived because task conversations proved too noisy and context-dependent to support a reliable long-lived knowledge profile.
