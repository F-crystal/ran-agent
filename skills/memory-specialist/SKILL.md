# memory-specialist

## 什么时候用

- 当前回合需要回忆用户短期/长期记忆线索。
- 回合结束后需要做记忆提取与存储决策。

## 怎么用

- 调用 `memory_specialist` 做 recall/update。
- 优先走 LLM extraction；失败时回退 rule-based。
- 输出只返回结构化 recall/store 结果，不返回大段原始记忆文本。

## 别做什么

- 不做前台说话。
- 不接管 response mode/tool routing。
- 不把 vault/wiki 当记忆库。

## 返回什么

```json
{
  "should_inject": true,
  "rendered_context": "...",
  "working_written": false,
  "profile_written": false,
  "fallback_used": false
}
```
