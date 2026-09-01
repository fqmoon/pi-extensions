# pi-chat-tail

English | [简体中文](README.zh-CN.md)

## Why ask an LLM to write another handoff Markdown every time you end a session?

Many Agent workflows end like this:

> “Summarize our discussion as Markdown so I can continue in the next session.”

But the conclusions that matter are often already there in the last few messages.

Asking the LLM to summarize them again means another round of waiting and another round of tokens. It may also reinterpret details that were already accurate.

`pi-chat-tail` does one simple thing:

It saves the last few messages of the current conversation directly as Markdown.

**No model call. No summarization. No rewriting.**

```text
/tail
```

Then you can end the session.

## Usage

```text
/tail
/tail 2
/tail 4
```

The number tells `pi-chat-tail` how many recent User / Assistant messages to save. The default is `1`.

For example:

- `/tail`: save the latest Assistant response
- `/tail 2`: save the latest User + Assistant pair
- `/tail 4`: save the latest two User + Assistant pairs

If you usually ask the Agent for a final plan before ending a session, `/tail` is normally enough.

If the last few turns are themselves useful context, use `/tail 2` or `/tail 4`.

## Output

`/tail` creates a Markdown file in the current directory.

Its filename is based on the first saved message, with the date and time appended. For example:

```text
SDK-TypeScript-migration-plan-20260901-2214.md
```

When saving a single Assistant message, its original Markdown is preserved.

When saving multiple messages, `## User` and `## Assistant` headings identify each role.

## Install

```bash
pi install npm:pi-chat-tail
```

Once installed, simply run:

```text
/tail
```

For development, you can also load this file directly from the repository:

```text
packages/pi-chat-tail/index.ts
```

## Why not ask the Agent to summarize?

You can.

But if your workflow looks like this:

```text
Discuss
↓
Reach a conclusion
↓
Agent writes the final plan
↓
Agent summarizes that final plan again
↓
Save the Markdown
```

The last two steps are really the same job twice.

`pi-chat-tail` turns that into:

```text
Discuss
↓
Reach a conclusion
↓
Agent writes the final plan
↓
/tail
```

Tools should shorten workflows, not add another workflow on top.

## License

MIT.

This project contains code adapted from Joey Gibson’s [`save` extension](https://github.com/joeygibson/pi-extensions/blob/main/extensions/save.ts), which is also licensed under the MIT License.

The corresponding copyright notice is preserved in the license file.
