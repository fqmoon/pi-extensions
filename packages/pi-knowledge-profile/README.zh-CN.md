# pi-knowledge-profile

面向 [Pi](https://pi.dev/) 的、基于证据自动维护的用户知识画像扩展。

它不是通用记忆系统；它只记录从会话中得到充分证据的知识状态，用来帮助 Agent 调整解释深度。画像会自动更新，并展示本次变更，用户可随后通过正常对话要求调整。

## 安装

```bash
pi install npm:pi-knowledge-profile
```

## 使用

启动时会统计尚未同步的会话。默认累计到 5 个待同步会话后，Pi 给出非阻塞提示：

```text
Knowledge Profile: 7 pending sessions · ~31,000 tokens · 2026-09-01–2026-09-08.
Run /knowledge-sync to update.
```

启动过程不会调用模型，也不会自动同步。

运行：

```text
/knowledge-sync
```

同步流程：逐会话提取保守证据 → 跨会话聚合 → 自动更新 `profile.json` → 重新生成 Markdown 视图 → 推进 checkpoint → 显示新增和更新内容。

单个会话提取失败会跳过并继续。每个成功会话的证据会立即暂存到 `state.json`，因此中断后再次运行 `/knowledge-sync` 可以继续处理。

## 配置

查看配置：

```text
/knowledge-config
```

修改提醒阈值：

```text
/knowledge-config threshold 10
```

默认阈值为 5 个待同步会话。

## 存储

文件位于 `~/.pi/agent/user-knowledge/`：

```text
profile.json        # 唯一真源，结构化知识画像
state.json          # reminder threshold、staged evidence、checkpoints
views/              # 从 profile.json 单向生成的人类可读 Markdown
  Git.md
  WebGPU.md
```

`profile.json` 固定为“领域 → 子领域 → 知识点”三级结构。知识点保存状态、上下文、证据、理由和更新时间。

Markdown 只是派生视图，不作为数据源，也不会反向同步到 JSON。

## 约束

- 单纯提问、偶然使用术语、说“懂了”或接受解释，不能单独作为证据。
- tool 输出、system prompt 和原始日志不会进入分析输入。
- `完全不懂` 不会由同步流程自动推断。
- 候选数量不再受 24 条审核上限限制，仅保留高得多的内部安全上限。
