# pi-knowledge-profile

面向 [Pi](https://pi.dev/) 的、基于证据并由用户确认的知识画像扩展。

它不是通用记忆系统；它只记录用户审核确认过的知识状态，让 Agent 能安全判断哪些内容可以作为解释前提。

## 安装

```bash
pi install npm:pi-knowledge-profile
```

## 使用

当到达每周提示周期且发现未处理历史时，Pi 启动阶段仅给出非阻塞提示：

```text
Knowledge Profile：12 个待同步会话 · 约 48k tokens · 2026-09-01–2026-09-08。
运行 /knowledge-sync 审核更新。
```

只有手动运行 `/knowledge-sync` 才会扫描历史、调用模型生成候选并写入画像。启动过程不弹窗，也不调用模型。

同步会先逐会话提取保守证据，再跨会话聚合；每个候选都展示上下文、具体证据和理由，用户逐项确认后才原子写入 Markdown。

每个会话提取成功后，证据会立刻暂存到 `state.json`，但不会推进 checkpoint。首次全量同步很大时，可停止同步后直接运行 `/knowledge-review`：它只对已暂存的会话进行跨会话聚合和逐项审核，不会继续扫描其余会话。审核成功才会写入画像、推进这些会话的 checkpoint，并清空暂存批次。

## 存储

文件位于 `~/.pi/agent/user-knowledge/`。每个领域一个 Markdown 文件；固定三级结构为“领域 → 子领域 → 知识点”，禁止第四级。允许的状态是“完全掌握、重要部分掌握、基本不懂、完全不懂”；没有条目只代表尚未确认，不代表不懂。

`state.json` 保存提醒、暂存证据与增量 checkpoint。默认每周提醒；如需每日提醒，可将其中的 `frequency` 改为 `daily`。

## 约束

- 单纯提问、偶然使用术语、说“懂了”或接受解释，不能单独作为证据。
- tool 输出、system prompt 和原始日志不会进入分析输入。
- 用户未完成审核时不会推进 checkpoint。
