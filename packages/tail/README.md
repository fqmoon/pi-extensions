# @fqmoon/pi-tail

A Pi extension that saves the tail of the current conversation as Markdown, ending at the latest assistant response.

Based on Joey Gibson's [`save` extension](https://github.com/joeygibson/pi-extensions/blob/main/extensions/save.ts) and modified under the MIT License.

## Usage

```text
/tail
/tail 2
/tail 4
```

The optional positional argument controls how many recent user/assistant messages are preserved, ending at the latest assistant response. The default is `1`.

Examples:

- `/tail`: latest assistant response only
- `/tail 2`: latest user + assistant pair
- `/tail 4`: latest two user + assistant pairs, assuming the conversation alternates normally

The generated filename uses the first non-empty line of the first saved message, sanitized and truncated, followed by a local-time timestamp accurate to the minute:

```text
<title>-YYYYMMDD-HHmm.md
```

Existing files are not overwritten.

When only one assistant message is saved, its Markdown is written unchanged. When multiple messages are saved, each message is prefixed with `## User` or `## Assistant`.

## Install

From npm after publication:

```bash
pi install npm:@fqmoon/pi-tail
```

During development, install the repository or load `packages/tail/index.ts` directly from Pi.

## License

MIT. This package contains code derived from Joey Gibson's MIT-licensed `save` extension; the package license preserves both copyright notices.
