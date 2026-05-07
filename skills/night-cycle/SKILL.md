# night-cycle

## 什么时候用

- 每日夜间 rollover 触发。
- 需要生成次日 carry-over 和夜间 digest。

## 怎么用

- 运行夜间收口流程，写入轻量产物。
- 只做有限候选提升与 inbox 投递。

## 别做什么

- 不做长期记忆批量删除。
- 不回放整段旧会话作为次日上下文。
- 不参与前台实时回复。

## 返回什么

```json
{
  "summary_date": "YYYY-MM-DD",
  "daily_context_key": "daily_context:latest",
  "reflection_digest_key": "night_cycle:latest_reflection_digest",
  "promoted_count": 0
}
```
