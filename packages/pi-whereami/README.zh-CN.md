# pi-whereami

[English](README.md) | 简体中文

> **LLM：你就说钓没钓到吧，别管我去过撒哈拉沙漠。**

一些模型跑分不错，任务可以完成，但是路径奇特，类似深度优先搜索，绕路绕到姥姥家里去了。

它们通常没有忘记目标，只是会沿着文件、调用链和局部证据越钻越深。每一步单独看都说得过去，连起来就开始离谱，尤其是在分析类任务中。

`pi-whereami` 会在 Agent 连续做出一定数量的决策后，**强制它重新审视当前路径：是不是还值得继续，还是应该换条路，防止一路钻进牛角尖。**

重新审视后，Agent 会留下一条很短的 checkpoint，再继续原任务：

```text
Level: module
Scope: rendering pipeline
State: invalidation remains the likely issue
Next: inspect the dirty propagation boundary
```

Checkpoint 会保存在会话历史中。Checkpoint 工具本身不受周期触发窗口限制：只要调用参数合法，就会立即记录并更新 HUD；主动记录 checkpoint 也不会重置或推进 re-orientation 的计数。

除此之外，插件还提供一个 HUD 面板，让用户也能看到 Agent 当前记录的位置和运行状态：

```text
WhereAmI · Decisions: 13/20 · Checkpoint at decision 12
```

`13/20` 表示模型决策次数，不是工具调用数，也不是任务完成度；`Checkpoint at decision 12` 表示最新 checkpoint 记录在第 12 次决策之后。

默认检查间隔逐渐缩短：

```text
20 → 15 → 10 → 10 → ...
```

每条新的用户消息都会重新计数。

## Configuration

如需修改检查节奏，创建：

```text
~/.pi/agent/whereami/config.json
```

例如：

```json
{
  "intervals": [30, 20, 10]
}
```

`intervals` 必须包含 **1 到 8 个正整数**。最后一个值会无限重复，因此 `[30, 20, 10]` 表示 `30 → 20 → 10 → 10 → ...`。配置不存在或无效时，整份配置回退到默认值 `[20, 15, 10]`。修改后执行 `/reload` 生效。

它不监督 Agent，也不判断 Agent 对不对。它做的只是定期打断连续决策，让 Agent 回头看一眼：

**这条路还值得继续钻吗？**

## Install

需要 **Pi 0.87.1+**。

```bash
pi install npm:pi-whereami
```

安装后直接正常使用 Pi，无需额外命令。

## Custom re-orientation

每次周期检查触发时，`pi-whereami` 会先给当前 Agent 一段 re-orientation 提示，让它重新审视自己正在走的路径，然后要求它留下一条 checkpoint。

默认提示主要检查这些问题：

- 当前正在什么层级、什么范围内工作；
- 最近的工作有没有真正减少主要不确定性；
- 当前路径是不是仍然最有信息价值；
- 是否只是因为惯性、局部关联或旧假设而继续往下钻；
- 有没有更直接的层级、假设或证据来源。

如果你希望 Agent 用不同的方式“回头看路”，可以创建：

```text
~/.pi/agent/whereami/reorient.md
```

这个文件会**完全替换默认的 re-orientation 提示**。

例如，你可以让它更关注竞争假设：

```markdown
继续之前，检查最近的工作有没有缩小主要疑问。
如果没有，考虑一个竞争解释，或者换一种证据来源。
如果当前路径仍然有效，就继续，不要为了换路而换路。
```

也可以针对自己的工作流，要求它更关注抽象层级、证据质量、实现边界或其他容易钻牛角尖的地方。

自定义提示只负责定义“**重新审视什么**”。Checkpoint 的 `Level / Scope / State / Next` 格式仍由插件负责，不需要在文件里重复规定。

修改后执行：

```text
/reload
```

文件不存在、为空或无法读取时，会继续使用默认提示。

## License

MIT
