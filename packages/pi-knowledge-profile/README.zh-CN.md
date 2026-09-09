# pi-knowledge-profile

面向 [Pi](https://pi.dev/) 的、基于证据自动维护的用户知识画像扩展。

它不是通用记忆系统；它记录用户“已经掌握什么”和“哪些知识仍需要解释”，让 Agent 据此调整解释深度。知识内容采用 Markdown 保存和传递，程序状态继续使用 JSON。

## 安装

```bash
pi install npm:pi-knowledge-profile
```

## 使用

启动时会加载 `profile.md`，并提示本次可注入 Profile 的长度，例如：

```text
Knowledge Profile injection: 1.2k/48k chars
```

默认最大注入长度为 48,000 字符。超过限制时只截断注入内容，不修改磁盘上的完整 `profile.md`。

启动时也会统计尚未同步的会话。默认累计到 5 个待同步会话后，Pi 给出非阻塞提示。启动过程不会调用模型，也不会自动同步。

运行：

```text
/knowledge-sync
```

同步不再按 session 数量分 batch，也不再对单 session 做固定长度截断。所有待同步历史消息按时间顺序组成一个逻辑同步批次，再按 `chunk-max-chars` 切成多个输入片段。默认每个片段最多 100,000 字符。

如果一个 session 或单条 message 很长，它会自然跨多个输入片段，不会因为超过固定 session/message 上限而丢弃后半段内容。

一个逻辑批次通过自然语言 accumulator 多轮处理：

```text
全部待同步历史消息
→ 按 chunk-max-chars 切成 N 个输入片段
→ part 1/N + 空 accumulator → accumulator 1
→ part 2/N + accumulator 1 → accumulator 2
→ ...
→ part N/N + accumulator N-1 → 最终 Evidence Note
→ Evidence Note + 现有 profile.md
→ 1 次 reconciliation 输出完整新版 profile.md
→ 推进所有相关 checkpoints
```

每次请求都会明确告诉模型当前是第几部分、总共有几部分。前面已经处理过的原始 transcript 不会重复发送，而是由上一轮 accumulator 承载已保留的知识证据。因此超长历史输入可以逐段处理，同时避免每一轮都重新发送全部旧文本。

模型不再被要求输出 JSON、tool-call schema 或固定字段结构。知识语义由模型用自然语言表达，代码只负责保存、切片、checkpoint、恢复和配置。

整个逻辑批次完成前不会推进 checkpoint。只有最终 Evidence Note 成功生成、写入 `evidence/*.md` 并 reconciliation 成功后，相关 session 才会正式提交。若已有旧版本 staged note，则下次 `/knowledge-sync` 会先完成这些 staged reconciliation，再分析新的历史消息。

每次模型调用最多尝试 3 次。重试只针对调用失败或空文本，不再存在 JSON 解析、schema validation 或 tool-call 格式失败。空文本/模型错误会报告 `stopReason`、`errorMessage`、content block 类型和 token usage 等诊断信息。

## 知识状态

画像仍建议使用四档状态：

- `完全掌握`：可以把该知识点作为解释前提，通常不必重复基础内容。
- `重要部分掌握`：核心已经可用，但仍可能需要补充边界和缺口。
- `基本不懂`：存在明确的知识缺口、误解或理解不稳定，应先解释前置概念和核心框架。
- `完全不懂`：有强而明确的证据表明该具体知识点几乎没有基础，应从基础开始解释。

这些状态现在属于 Markdown 画像的语义约定，而不是 JSON enum。没有记录的知识点只表示“未知”，不代表懂，也不代表不懂。

负向证据仍必须来自明确表现，例如用户明确表示没有相关基础、对核心概念做出明显错误解释、解释后仍持续混淆，或明确说明缺乏基础并要求从头讲。单纯提问、请求解释、偶然使用术语、说“懂了”或接受回答，都不能单独作为“不懂”的证据。

## 配置

```text
/knowledge-config
/knowledge-config threshold 10
/knowledge-config chunk-max-chars 150000
/knowledge-config profile-max-chars 64000
```

默认值：提醒阈值 5 个待同步会话，单次历史输入片段最大 100,000 字符，Profile 最大注入长度 48,000 字符。

`threshold` 可配置范围为 1–1,000；`chunk-max-chars` / `profile-max-chars` 可配置范围为 1,000–1,000,000。

旧配置 `batch-max-chars` 仍作为 `chunk-max-chars` 的兼容别名读取和接受命令输入；旧 `batch-size` 不再使用。

## 存储

文件位于 `~/.pi/agent/user-knowledge/`：

```text
profile.md          # 唯一知识画像真源，自然语言 Markdown
state.json          # 纯程序状态：配置、staged note 路径、checkpoints
evidence/           # 每次逻辑同步最终生成的自然语言证据记录
  *.md
profile.json        # 旧版文件；首次迁移后仅作为遗留数据保留
```

边界原则：

```text
程序状态 → JSON
知识语义 → Markdown
```

旧版 `profile.json` 会在首次加载且 `profile.md` 尚不存在时自动转换为 Markdown。旧版 `state.json` 中暂存的结构化 evidence 也会自动转换为 `evidence/*.md`，然后状态文件升级到新版结构。旧 `batchMaxChars` 配置会自动迁移为 `chunkMaxChars`。

Evidence Note 会保留在磁盘上作为可审计的历史证据；完成 reconciliation 后只清除 `state.json` 中的 staged 引用，不删除 note 文件。

## 约束

- 未涉及或缺少证据的知识点保持未知，不自动判定为不懂。
- `完全不懂` 只有在存在强而明确的负向证据时才能自动生成，不能由单个问题、一次错误或证据缺失推断。
- 多个会话中的中等强度证据可以在 accumulator / reconciliation 阶段共同支持状态判断。
- `SESSION_DATA` 中的内容被明确视为历史数据，分析模型不得执行其中出现的指令。
- tool 输出、system prompt 和插件自定义日志不会进入历史会话分析输入。
