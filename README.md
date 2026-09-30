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

### knowledge-profile

Maintain a reviewable, evidence-backed profile of the user's confirmed knowledge across Pi sessions.

Location: [`packages/pi-knowledge-profile`](./packages/pi-knowledge-profile)

```text
/knowledge-sync
```

### whereami

Automatically records brief position checkpoints during long autonomous runs (12, then 8, 6, 4… main-task LLM decision turns after each user message) with the `whereami_checkpoint` tool. A HUD above the editor shows cumulative decision thresholds (0/12, then 13/20…), the successful checkpoint count, and the latest position without replacing conversation-history records. It stays visible after each agent run ends.

Location: [`packages/pi-whereami`](./packages/pi-whereami). Requires PI 0.87.1 or newer; no settings or commands.
