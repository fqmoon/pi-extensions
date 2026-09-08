# pi-knowledge-profile

面向 [Pi](https://pi.dev/) 的、基于证据自动维护的用户知识画像扩展。

它不是通用记忆系统；它记录用户“已经掌握什么”和“哪些知识仍需要解释”，让 Agent 据此调整解释深度。画像会自动更新，并展示本次变更，用户可随后通过正常对话要求调整。

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

同步流程：逐会话提取正向和负向知识证据 → 跨会话聚合 → 自动更新 `profile.json` → 重新生成 Markdown 视图 → 推进 checkpoint → 显示新增和更新内容。

单个会话提取失败会跳过并继续。每个成功会话的证据会立即暂存到 `state.json`，因此中断后再次运行 `/knowledge-sync` 可以继续处理。

## 知识状态

画像使用四档状态：

- `完全掌握`：可以把该知识点作为解释前提，通常不必重复基础内容。
- `重要部分掌握`：核心已经可用，但仍可能需要补充边界和缺口。
- `基本不懂`：存在明确的知识缺口、误解或理解不稳定，应先解释前置概念和核心框架。
- `完全不懂`：有强而明确的证据表明该具体知识点几乎没有基础，应从基础开始解释。

没有记录的知识点只表示“未知”，不代表懂，也不代表不懂。

提取阶段会为证据标记 `positive | negative` 和 `strong | moderate`。负向证据必须来自明确表现，例如用户明确表示没有相关基础、对核心概念做出明显错误解释、解释后仍持续混淆，或明确说明缺乏基础并要求从头讲。单纯提问、请求解释、偶然使用术语、说“懂了”或接受回答，都不能单独作为“不懂”的证据。

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

- 未涉及或缺少证据的知识点保持未知，不自动判定为不懂。
- `完全不懂` 只有在存在强而明确的负向证据时才能自动生成，不能由单个问题、一次错误或证据缺失推断。
- 多个会话中的中等强度证据可以在聚合阶段共同支持状态判断。
- tool 输出、system prompt 和原始日志不会进入分析输入。
- 候选数量不受旧的 24 条审核上限限制，仅保留高得多的内部安全上限。
