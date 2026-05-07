# life-loop

## 什么时候用

- 定时任务触发机会扫描。
- 需要生成 companion/maintenance/reflection opportunities。

## 怎么用

- 由 scheduler 调用 life loop。
- 返回 opportunity 列表给 orchestrator 做最终判断。

## 别做什么

- 不直接给用户发消息。
- 不绕过 orchestrator judgment。
- 不直接改 prompt/policy。

## 返回什么

```json
{
  "opportunities": [
    {
      "id": "...",
      "kind": "companion|maintenance|reflection",
      "status": "pending",
      "reason": "..."
    }
  ]
}
```
