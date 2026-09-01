# pi-chat-tail

[English](README.md) | 简体中文

一个 Pi 扩展，用于将当前对话末尾的内容保存为 Markdown，保存范围截至最新一条助手回复。

基于 Joey Gibson 的 [`save` 扩展](https://github.com/joeygibson/pi-extensions/blob/main/extensions/save.ts)，并在 MIT 许可证下修改。

## 用法

```text
/tail
/tail 2
/tail 4
```

可选的位置参数用于控制保留最近多少条用户/助手消息，保存范围截至最新一条助手回复。默认值为 `1`。

示例：

- `/tail`：仅保存最新一条助手回复
- `/tail 2`：保存最近一组用户消息和助手回复
- `/tail 4`：保存最近两组用户消息和助手回复，前提是对话按通常方式交替进行

生成的文件名由第一条被保存消息的首个非空行组成；该行会经过清理和截断，然后附加精确到分钟的本地时间戳：

```text
<title>-YYYYMMDD-HHmm.md
```

不会覆盖已有文件。如果生成的文件名已经存在，会依次添加数字后缀：`title-YYYYMMDD-HHmm.md`、`title-YYYYMMDD-HHmm-2.md`、`title-YYYYMMDD-HHmm-3.md`，以此类推。

仅保存一条助手消息时，其 Markdown 内容会保持不变。保存多条消息时，每条消息会以 `## User` 或 `## Assistant` 作为标题前缀。

## 安装

```bash
pi install npm:pi-chat-tail
```

开发时，可以安装此仓库，或直接在 Pi 中加载 `packages/pi-chat-tail/index.ts`。

## 许可证

MIT。本包包含源自 Joey Gibson 的 MIT 许可证 `save` 扩展的代码；本包许可证保留了两份版权声明。
