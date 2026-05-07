# knowledge-state

## 什么时候用

- 前台需要轻量知识维护状态提示。
- 需要近期主题/来源提示，但不需要读取 wiki 正文。

## 怎么用

- 只读取 `knowledge_state` 的小字段。
- 提供 pending/topic/source 的轻量摘要给主流程。

## 别做什么

- 不加载完整 vault/wiki 页面到上下文。
- 不替代 memory recall。
- 不执行破坏性清理。

## 返回什么

```json
{
  "pending_knowledge_maintenance": false,
  "recent_curated_topics": ["..."],
  "recent_source_additions": ["..."],
  "last_status": "ok"
}
```
