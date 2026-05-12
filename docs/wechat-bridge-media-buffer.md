# 微信桥接媒体缓冲逻辑升级

## 概述

微信桥接的媒体缓冲逻辑已升级为"显式引用强绑定 + 隐式引用软候选 + recent artifact 可追问"策略。

## 核心逻辑

### 1. 显式引用（Explicit Reference）

当用户发送媒体后，使用以下文本引用媒体时，会**强绑定**媒体并标记为已消费：

**匹配模式**：
- 用 mimo/MiMo/米模...
- 看看/看看这个
- 读...
- 分析...
- 刚才那张图/之前的图片...
- 图里是什么/图里有...
- 帮我看看/帮我分析...
- 这个文件/这个图片...
- 识别...

**行为**：
- `relation`: `explicit_ref`
- `confidence`: `1.0`
- `consumed`: `true`（媒体被消费，后续引用无法再绑定）

### 2. 隐式引用（Implicit Candidate）

当用户发送媒体后，在时间窗口内发送普通文本（未命中显式模式），会**软附加**最近媒体作为候选：

**示例**：
- 怎么样？
- 好看吗？
- 啥意思？
- 笑死
- 你看

**行为**：
- `relation`: `recent_candidate`
- `confidence`: `0.5`
- `consumed`: `false`（媒体未被消费，后续显式引用仍可绑定）
- `soft_used`: `true`

### 3. Deferred 合并

支持 text-ref 先于 media 到达的场景：

- **短窗口**（默认 30s）：text-ref 到达后等待 media，若在窗口内到达则立即合并
- **长窗口**（默认 120s）：text-ref 超时后保存 intent，media 在 TTL 内到达仍可合并

## 新增 Payload 字段

```javascript
payload.media_candidates = [
  {
    artifact_id: "artifact-xxx",
    file_path: "/path/to/file",
    type: "image",
    created_at: 1234567890,
    relation: "explicit_ref" | "recent_candidate",
    confidence: 1.0 | 0.5,
    source: "pending_media"
  }
]
```

## 配置项

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `WECHAT_TEXT_REF_WAIT_MS` | `30000` | text-ref 等待 media 的短窗口（ms） |
| `WECHAT_PENDING_TEXT_REF_TTL_MS` | `120000` | text-ref intent 的 TTL（ms） |
| `WECHAT_PENDING_MEDIA_TTL_MS` | `600000` | pending media 的 TTL（ms） |
| `WECHAT_MEDIA_REPLY_GRACE_MS` | `12000` | 媒体回复的宽限期（ms） |

## 测试覆盖

共 21 个测试用例，覆盖：
- ✅ 显式引用绑定与消耗
- ✅ 隐式引用软附加
- ✅ 隐式引用后显式引用仍可绑定
- ✅ pending 超时后不附带媒体
- ✅ text-ref 先到，media 后到（短窗口）
- ✅ text-ref 先到，media 后到（长窗口/TTL 内）
- ✅ text-ref intent 超时后不合并

## 兼容性

- **向后兼容**：原有显式引用行为不变
- **低风险**：仅修改缓冲逻辑，不影响 LLM 路由
- **Agent 自主**：Agent 收到 `recent_candidate` 后，可自主决定是否分析媒体

## 文件变更

- `node_bridge/src/inboundMessageBuffer.mjs` - 核心缓冲逻辑
- `node_bridge/tests/inboundMessageBuffer.test.mjs` - 测试用例

## Git Commit

```
feat(wechat-bridge): 显式引用强绑定 + 隐式引用软候选
```
