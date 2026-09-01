# pi-extensions

Some extensions for pi-agent.

## Extensions

### save-md

Save the latest assistant response, optionally with recent user/assistant messages, as Markdown.

Location: [`packages/save-md`](./packages/save-md)

```text
/save
/save -n 2
/save notes -n 4
```

Each extension is kept as an independent package so it can be published to npm separately while remaining in this monorepo.
