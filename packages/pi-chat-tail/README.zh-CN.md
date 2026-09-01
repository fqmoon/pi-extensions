# pi-chat-tail

[English](README.md) | 简体中文

## 何必每次结束会话，都让 LLM 再写一份交接 Markdown？

很多 Agent 工作流最后都会变成这样：

> “总结一下刚才的讨论，写成 Markdown，方便下个会话继续。”

但真正有价值的结论，往往已经在最后几轮对话里了。

再让 LLM 总结一次，不仅要多等一轮、再花一轮 token，还可能在总结时把原本准确的内容重新加工一遍。

`pi-chat-tail` 做的事情很简单：

直接把当前会话最后几条消息保存成 Markdown。

**不调用模型，不总结，也不改写。**

```text
/tail
```

然后就可以结束 session。

## 用法

```text
/tail
/tail 2
/tail 4
```

后面的数字表示保存最近多少条 User / Assistant 消息，默认是 `1`。

例如：

- `/tail`：保存最新一条 Assistant 回复
- `/tail 2`：保存最近一组 User + Assistant
- `/tail 4`：保存最近两组 User + Assistant

如果你习惯在结束会话前让 Agent 输出最终方案，通常 `/tail` 就够了。

如果最后几轮讨论本身也需要保留，则可以用 `/tail 2`、`/tail 4`。

## 输出

`/tail` 会在当前目录生成一个 Markdown 文件。

文件名会根据保存内容的首条消息生成，并附带日期时间，例如：

```text
SDK-TypeScript迁移方案-20260901-2214.md
```

只保存一条 Assistant 消息时，会直接保留原始 Markdown 内容。

保存多条消息时，会使用 `## User` 和 `## Assistant` 标记不同角色。

## 安装

```bash
pi install npm:pi-chat-tail
```

安装后直接使用：

```text
/tail
```

开发时也可以直接加载仓库中的：

```text
packages/pi-chat-tail/index.ts
```

## 为什么不是让 Agent 自己总结？

当然可以。

但如果你的工作流是：

```text
讨论
↓
形成结论
↓
Agent 输出最终方案
↓
再让 Agent 总结刚才的最终方案
↓
保存 Markdown
```

最后两步其实是在重复同一件事。

`pi-chat-tail` 只是把它变成：

```text
讨论
↓
形成结论
↓
Agent 输出最终方案
↓
/tail
```

工具应该减少工作流，而不是再创造一层工作流。

## License

MIT。

本项目包含修改自 Joey Gibson [`save` extension](https://github.com/joeygibson/pi-extensions/blob/main/extensions/save.ts) 的代码，原项目同样采用 MIT License。

许可证文件中保留了对应的版权声明。
