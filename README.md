# pi-extensions

Some extensions for pi-agent.

## Extensions

### tail

Save the tail of the current conversation as Markdown, ending at the latest assistant response.

Location: [`packages/tail`](./packages/tail)

```text
/tail
/tail -n 2
/tail notes -n 4
```

Each extension is kept as an independent package so it can be published to npm separately while remaining in this monorepo.
