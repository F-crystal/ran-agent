# context-compact

## 什么时候用

- 对话历史 token 数接近上下文窗口上限（默认阈值：80%）。
- 用户主动触发 `/compact` 或类似指令。
- 长会话需要保留关键信息但释放 token 空间。
- 任务边界处（完成一个功能、结束一个话题）需要总结交接。

## 怎么用

### 自动触发

Life loop 在每次 opportunity 评估前检查上下文长度：

```python
if current_tokens > context_window * 0.8:
    compaction_result = context_compact.compact(
        conversation_history=history,
        strategy="auto",
        preserve_recent_turns=2,  # 保留最近2轮
    )
```

### 手动触发

用户发送 `/compact` 或 `/compact 关注API设计决策`：

```python
compaction_result = context_compact.compact(
    conversation_history=history,
    strategy="handoff",  # 生成交接摘要
    custom_focus=用户指令中的焦点描述,
    preserve_tool_outputs=True,  # 保留关键工具输出
)
```

### 压缩策略

| 策略 | 适用场景 | 输出 |
|------|----------|------|
| `micro` | 单轮工具结果过大 | 工具输出摘要，保留原始结果引用 |
| `auto` | 常规长会话 | 最近N轮保留 + 历史摘要 |
| `handoff` | 任务边界 | 结构化交接文档 |
| `aggressive` | 紧急空间不足 | 仅保留关键决策和待办 |

## 别做什么

- 不删除用户明确标记为重要的信息（`!important`）。
- 不在用户正在输入时自动压缩。
- 不把压缩后的摘要当作可逆操作（原始历史可选择归档）。
- 不压缩系统提示词和身份设定。

## 返回什么

```json
{
  "status": "compacted|skipped|failed",
  "strategy": "auto|handoff|micro|aggressive",
  "original_tokens": 45000,
  "compacted_tokens": 8000,
  "compression_ratio": 0.82,
  "summary": "用户正在开发用户认证模块...",
  "preserved_items": [
    {"type": "user_message", "turn": -1},
    {"type": "tool_output", "name": "api_schema", "reason": "关键设计决策"}
  ],
  "archived_turns": 15,
  "archive_path": "memory://conversation_archives/2026-04-14_xxx.json"
}
```

## 实现要点

### 摘要生成 Prompt

```
你是一个对话历史压缩助手。请将以下对话历史总结为一份"交接文档"，
让另一个AI助手能够继续当前工作而不丢失关键信息。

必须包含：
1. 当前进行中的任务/项目
2. 已做出的关键决策和原因
3. 待解决的问题或下一步行动
4. 相关的代码/配置片段（如有）
5. 用户的偏好或约束条件

不要包含：
- 寒暄和礼貌用语
- 已完成的琐碎步骤
- 重复的信息

原始对话：
{conversation_history}
```

### Token 计算

使用近似计算（1 token ≈ 0.75 中文字符 或 4 英文字符）：

```python
def estimate_tokens(text: str) -> int:
    """快速估算 token 数，不依赖外部 tokenizer。"""
    chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    other_chars = len(text) - chinese_chars
    return int(chinese_chars * 1.5 + other_chars * 0.25)
```

### 归档存储

压缩前的完整历史可选择性存入 SQLite（`conversation_archives` 表）：

```sql
CREATE TABLE conversation_archives (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    compacted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    original_turns INTEGER,
    summary TEXT,
    full_history_json TEXT,  -- 可选：完整历史
    compression_ratio REAL
);
```
