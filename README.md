# pi-extensions

Some extensions for pi-agent.

## Extensions

### tail

Save the tail of the current conversation as Markdown, ending at the latest assistant response.

Location: [`packages/tail`](./packages/tail)

```text
/tail
/tail 2
/tail 4
```

The optional positional argument is the number of recent user/assistant messages to save. It defaults to `1`.

Each extension is kept as an independent package so it can be published to npm separately while remaining in this monorepo.
