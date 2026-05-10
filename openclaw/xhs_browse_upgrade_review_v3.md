# 小红书浏览功能升级方案评审 v3（加强版）

## 文档状态说明

| 项目 | 说明 |
|------|------|
| **文档类型** | 只读调研方案 |
| **创建时间** | 2026-05-10 |
| **版本** | v3（加强版） |
| **本轮修改** | 仅新增本文档，未修改任何代码/配置 |
| **旧文件状态** | `openclaw/xhs_browse_upgrade_review.md` 未被覆盖或修改 |
| **代码修改** | 无 |
| **环境变量修改** | 无（`.env.local` 未修改） |
| **依赖安装** | 无 |
| **服务重启** | 无（systemd / OpenClaw / node 服务未重启） |

---

## 1. 当前项目现状判断

### 1.1 现有架构概览

当前 OpenClaw 通过以下链路处理小红书内容读取：

```
OpenClaw Agent → social_reader MCP Server → jobson-xhs-mcp → 小红书 API
```

**核心组件**:

| 组件 | 位置 | 作用 |
|------|------|------|
| social_reader MCP Server | `node_bridge/src/socialReaderMcpServer.mjs` | 统一社交平台读取入口 |
| XHS 后端配置 | `XHS_MCP_COMMAND`, `XHS_MCP_ARGS_JSON` 环境变量 | 指定 jobson-xhs-mcp 启动方式 |
| Cookie 凭证 | `XHS_COOKIE` 环境变量 | 小红书登录态 |
| 核心工具 | `read_social_post`, `read_social_post_deep` | 读取单篇笔记内容 |

### 1.2 当前环境变量配置（脱敏）

#### `.env.local` 实际配置（敏感值已脱敏）

| 变量名 | 值（脱敏） | 用途 |
|--------|-----------|------|
| `XHS_MCP_COMMAND` | `uvx` | XHS MCP 后端启动命令 |
| `XHS_MCP_ARGS_JSON` | `'["--from","jobson-xhs-mcp","xhs-mcp"]'` | XHS MCP 后端启动参数 |
| `XHS_COOKIE` | `<hidden>` (已配置，非空) | 小红书登录 Cookie |
| `PERSONAL_AGENT_XHS_ENABLED` | `true` | 个人代理 XHS 功能开关 |
| `PERSONAL_AGENT_XHS_PROVIDER` | `social_reader` | 个人代理 XHS 提供器 |
| `PERSONAL_AGENT_XHS_USE_SOCIAL_READER` | `true` | 显式启用 social_reader |
| `PERSONAL_AGENT_XHS_MCP_COMMAND` | `uvx` | 个人代理 XHS MCP 命令 |
| `PERSONAL_AGENT_XHS_MCP_ARGS_JSON` | `'["--from","jobson-xhs-mcp","xhs-mcp"]'` | 个人代理 XHS MCP 参数 |
| `SOCIAL_READER_GENERIC_FALLBACK_ENABLED` | `true` (默认) | 通用解析器降级开关 |
| `SOCIAL_READER_MCP_TIMEOUT_MS` | `15000` (默认) | MCP 后端超时 |

### 1.3 当前代码实际读取的 XHS / social_reader 变量清单

从 `node_bridge/src/socialReaderMcpServer.mjs` 代码分析：

| 变量名 | 默认值 | 用途 |
|--------|--------|------|
| `SOCIAL_READER_MCP_TIMEOUT_MS` | `90000` | MCP 后端调用超时 |
| `XHS_MCP_COMMAND` | `'uvx'` | XHS MCP 后端启动命令 |
| `XHS_MCP_ARGS_JSON` | `['--from', 'jobson-xhs-mcp', 'xhs-mcp']` | XHS MCP 后端启动参数 |
| `XHS_COOKIE` | `''` | 小红书登录 Cookie |
| `SOCIAL_READER_GENERIC_FALLBACK_ENABLED` | `'true'` | 通用解析器降级开关 |

---

## 2. 旧方案可继承点和需要修正点

### 2.1 可继承点

| 内容 | 评价 | 建议 |
|------|------|------|
| 核心结论（不建议直接替换 jobson-xhs-mcp） | ✅ 正确 | 保留 |
| 增量新增策略 | ✅ 正确 | 保留 |
| 工具命名空间隔离思路 | ✅ 正确 | 保留 |
| 风险清单框架 | ✅ 有用 | 保留并扩展 |
| 降级策略思路 | ✅ 有用 | 保留并具体化 |
| 安全边界约束 | ✅ 必须 | 保留并强化 |

### 2.2 需要修正点

| 旧方案内容 | 问题 | 修正建议 |
|------------|------|----------|
| 假设 `xiaohongshu-api-mcp` 包名存在 | ❌ 未验证 | 明确要求隔离探测，不假设包名 |
| 环境变量命名 `XHS_BROWSE_*` | ⚠️ 与项目风格不完全一致 | 调整为 `XHS_BROWSE_MCP_*` 贴合 `XHS_MCP_*` 风格 |
| 分阶段实施计划 | ⚠️ 用户要求一步到位 | 改为按模块组织的最终方案 |
| 工具设计较简略 | ⚠️ 缺少详细 schema | 补充完整输入/输出 schema 和错误码 |
| 缺少 adapter 层设计 | ❌ 未考虑第三方 MCP 差异 | 新增 adapter 层设计 |

---

## 3. 当前 social_reader MCP 工具清单

| 工具名 | 用途 | 后端依赖 |
|--------|------|----------|
| `resolve_social_url` | 解析社交分享链接并识别平台 | 无（本地解析） |
| `read_social_post` | 读取社交帖子内容 | jobson-xhs-mcp (XHS) |
| `read_social_post_deep` | 深度读取帖子（含媒体分析） | jobson-xhs-mcp + media_reader |
| `read_music_share` | 读取音乐分享链接 | 网易云音乐 API |
| `check_social_login` | 检查社交平台登录状态 | jobson-xhs-mcp (XHS) |

**结论**: 当前**不支持**搜索、用户主页浏览、推荐流，需要新增工具。

---

## 4. 是否建议直接替换 jobson-xhs-mcp

### 4.1 结论

**❌ 强烈不建议直接替换**

### 4.2 原因

| 原因 | 详细说明 |
|------|----------|
| **稳定性风险** | jobson-xhs-mcp 是当前唯一经过验证的稳定后端 |
| **回滚成本高** | 直接替换会导致现有功能完全失效 |
| **无并行验证期** | 无法对比新旧后端效果 |
| **违反用户约束** | 用户明确要求保留现有稳定后端 |

---

## 5. 最终推荐架构

### 5.1 整体架构

```
OpenClaw Agent
       │
       ▼
social_reader MCP Server
       │
       ├─── 现有工具 (稳定后端: XHS_MCP_*)
       │    ├── read_social_post
       │    ├── read_social_post_deep
       │    └── check_social_login
       │
       └─── 新增工具 (可选浏览后端: XHS_BROWSE_MCP_*)
            ├── xhs_browse_probe
            ├── xhs_browse_search
            ├── xhs_browse_note
            ├── xhs_browse_user
            └── xhs_browse_feed (默认禁用)
```

### 5.2 模块划分

| 模块 | 职责 |
|------|------|
| 配置模块 | 读取和验证环境变量 |
| social_reader facade 模块 | 统一暴露 MCP 工具 |
| browse backend adapter 模块 | 适配候选 MCP 差异 |
| tools/list probe 模块 | 探测后端可用性 |
| 搜索工具模块 | 关键词搜索 |
| 用户主页工具模块 | 获取用户主页 |
| 推荐流工具模块 | 获取推荐流（默认禁用） |
| 限流模块 | 限制结果数量和超时 |
| 错误处理模块 | 统一错误码映射 |

---

## 6. 最终推荐环境变量命名方案

### 6.1 命名原则

采用 `XHS_BROWSE_MCP_*` 前缀，贴合现有 `XHS_MCP_*` 风格。

### 6.2 变量清单

| 变量名 | 用途 | 必需/可选 | 默认值 | 是否敏感 |
|--------|------|-----------|--------|----------|
| `XHS_BROWSE_MCP_COMMAND` | Browse 后端启动命令 | 可选 | 空 | 否 |
| `XHS_BROWSE_MCP_ARGS_JSON` | Browse 后端启动参数 | 可选 | 空 | 否 |
| `XHS_BROWSE_MCP_COOKIE` | Browse 后端 Cookie | 可选 | 复用 `XHS_COOKIE` | 是 |
| `XHS_BROWSE_MCP_TIMEOUT_MS` | Browse 后端超时 | 可选 | `60000` | 否 |
| `XHS_BROWSE_MAX_RESULTS` | 搜索最大结果数 | 可选 | `10` | 否 |
| `XHS_BROWSE_MAX_ITEMS` | 用户主页最大项目数 | 可选 | `20` | 否 |
| `XHS_BROWSE_ENABLED` | 显式启用开关 | 可选 | `false` | 否 |

### 6.3 .env.example 模板

```bash
# --- XHS Browse (Optional) ---
# XHS_BROWSE_MCP_COMMAND=
# XHS_BROWSE_MCP_ARGS_JSON=
# XHS_BROWSE_MCP_COOKIE=   # never commit
# XHS_BROWSE_MCP_TIMEOUT_MS=60000
# XHS_BROWSE_MAX_RESULTS=10
# XHS_BROWSE_MAX_ITEMS=20
# XHS_BROWSE_ENABLED=false
```

---

## 7. 新增工具设计

### 7.1 xhs_browse_probe

| 属性 | 说明 |
|------|------|
| **用途** | 探测 browse 后端是否可用 |
| **默认启用** | 是 |
| **输入** | `{}` |
| **输出** | `{ ok, backend, command, tools_available }` |
| **错误码** | `XHS_BROWSE_NOT_CONFIGURED`, `XHS_BROWSE_BACKEND_UNAVAILABLE` |

### 7.2 xhs_browse_search

| 属性 | 说明 |
|------|------|
| **用途** | 搜索关键词笔记 |
| **默认启用** | 是 |
| **输入** | `{ query, max_results?, sort? }` |
| **输出** | `{ ok, query, results: [...], total_count }` |
| **限流** | `max_results` 最大 20 |
| **错误码** | `XHS_SEARCH_FAILED`, `XHS_AUTH_REQUIRED`, `XHS_RATE_LIMITED` |

### 7.3 xhs_browse_note

| 属性 | 说明 |
|------|------|
| **用途** | 获取笔记详情 |
| **默认启用** | 是 |
| **输入** | `{ note_id, include_images? }` |
| **输出** | `{ ok, note_id, title, content, images, user }` |
| **错误码** | `XHS_NOTE_READ_FAILED`, `XHS_AUTH_REQUIRED` |

### 7.4 xhs_browse_user

| 属性 | 说明 |
|------|------|
| **用途** | 获取用户主页笔记列表 |
| **默认启用** | 是 |
| **输入** | `{ user_id, max_items? }` |
| **输出** | `{ ok, user_id, user_info, notes: [...] }` |
| **限流** | `max_items` 最大 30 |
| **错误码** | `XHS_PROFILE_FAILED`, `XHS_AUTH_REQUIRED` |

### 7.5 xhs_browse_feed

| 属性 | 说明 |
|------|------|
| **用途** | 获取推荐信息流 |
| **默认启用** | **否**（高风险） |
| **输入** | `{ category?, max_items? }` |
| **输出** | `{ ok, category, feed: [...] }` |
| **限流** | `max_items` 最大 10 |
| **错误码** | `XHS_FEED_DISABLED`, `XHS_FEED_FAILED`, `XHS_RATE_LIMITED` |

---

## 8. 候选 browse MCP 隔离探测机制

### 8.1 tools/list 探测流程

1. 检查 `XHS_BROWSE_MCP_COMMAND` 是否配置
2. 启动后端（如未运行）
3. 调用 MCP `tools/list` 方法
4. 解析返回的工具列表
5. 返回可用工具和后端状态

### 8.2 异常处理

| 场景 | 错误码 | 降级行为 |
|------|--------|----------|
| 后端启动失败 | `XHS_BROWSE_BACKEND_UNAVAILABLE` | 不影响 read_social_post |
| 工具名不匹配 | `XHS_BROWSE_TOOL_NOT_FOUND` | 返回可用工具列表 |
| 协议不兼容 | `XHS_BROWSE_PROTOCOL_ERROR` | 记录日志，返回错误 |
| Cookie 失效 | `XHS_AUTH_REQUIRED` | 用户手动更新 |

---

## 9. 后端适配层设计

### 9.1 工具名映射

```javascript
const BROWSE_TOOL_MAP = {
  'search': ['search_notes', 'search', 'query_notes'],
  'note': ['get_note_info', 'get_note', 'note_detail'],
  'user': ['get_user_notes', 'user_profile', 'user_homepage'],
  'feed': ['get_feed', 'explore', 'recommendation_feed']
};
```

### 9.2 错误码映射

| 候选 MCP 错误 | OpenClaw 错误码 |
|--------------|-----------------|
| `LOGIN_REQUIRED` | `XHS_AUTH_REQUIRED` |
| `RATE_LIMITED` | `XHS_RATE_LIMITED` |
| `RISK_CONTROL` | `XHS_RISK_CONTROL` |
| `TOOL_NOT_FOUND` | `XHS_BROWSE_TOOL_NOT_FOUND` |

---

## 10. 完整代码修改清单

### 10.1 预计修改文件

| 文件路径 | 修改类型 | 说明 |
|----------|----------|------|
| `node_bridge/src/socialReaderMcpServer.mjs` | 新增工具 | 添加 `xhs_browse_*` 工具定义和实现 |
| `.env.example` | 新增变量 | 添加 `XHS_BROWSE_MCP_*` 模板 |
| `openclaw/xhs_browse_upgrade_review_v3.md` | 新增文档 | 本方案文档 |

### 10.2 不应修改的文件

| 文件 | 原因 |
|------|------|
| `.env.local` | 用户自行配置 |
| `XHS_MCP_COMMAND` / `XHS_MCP_ARGS_JSON` 读取逻辑 | 保持 read_social_post 稳定 |
| `read_social_post` 相关代码 | 保持现有链路不变 |
| `jobson-xhs-mcp` 配置 | 不被替换 |

---

## 11. 完整服务器验证命令

### 11.1 启动 social_reader MCP

```bash
cd /opt/ran_agent
./scripts/start_social_reader_mcp.sh
```

### 11.2 tools/list 探测

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | \
  node node_bridge/src/socialReaderMcpServer.mjs 2>/dev/null
```

### 11.3 xhs_browse_probe 测试

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xhs_browse_probe","arguments":{}}}' | \
  XHS_BROWSE_MCP_COMMAND=uvx \
  XHS_BROWSE_MCP_ARGS_JSON='["--from","some-mcp","mcp"]' \
  node node_bridge/src/socialReaderMcpServer.mjs 2>/dev/null
```

### 11.4 read_social_post 回归测试

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_social_post","arguments":{"url":"https://www.xiaohongshu.com/explore/xxx"}}}' | \
  node node_bridge/src/socialReaderMcpServer.mjs 2>/dev/null
```

---

## 12. 风险清单

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| browse 后端不可用 | 中 | 仅浏览功能不可用 | 工具返回明确错误 |
| 候选 MCP 包名不确定 | 中 | 启动失败 | 隔离探测，不假设包名 |
| 工具名不匹配 | 中 | 调用失败 | adapter 层映射 |
| Cookie 失效 | 中 | 返回 AUTH_REQUIRED | 用户手动更新 |
| 风控/验证码 | 中 | 功能受限 | 降低频率或暂停 |
| 高频触发账号限制 | 中 | 账号受限 | 限制 max_results/max_items |
| 日志泄露 Cookie/token | 低 | 安全风险 | 不打印敏感变量 |
| 新工具影响旧链路 | 低 | read_social_post 失效 | 工具命名空间隔离 |

---

## 13. 降级策略

| 场景 | 降级行为 |
|------|----------|
| browse 后端不可用 | 返回 `XHS_BROWSE_BACKEND_UNAVAILABLE` |
| search 失败 | 返回 `XHS_SEARCH_FAILED` |
| feed 禁用 | 返回 `XHS_FEED_DISABLED` |
| user/profile 禁用 | 返回 `XHS_PROFILE_DISABLED` |
| read_social_post | 继续使用 jobson-xhs-mcp 旧链路 |
| browse 一键禁用 | 设置 `XHS_BROWSE_ENABLED=false` |

---

## 14. 回滚策略

| 操作 | 方法 |
|------|------|
| 关闭 browse 功能 | 设置 `XHS_BROWSE_ENABLED=false` |
| 恢复只使用 jobson-xhs-mcp | 删除 `XHS_BROWSE_*` 配置 |
| 禁用问题工具 | 从代码中移除对应工具定义 |
| 配置错误回退 | 恢复 `.env.local` 备份 |

---

## 15. 安全边界

### 15.1 明确禁止

- ❌ 不打印 Cookie/token
- ❌ 不自动轮换 Cookie
- ❌ 不多账号备用
- ❌ 不绕过风控
- ❌ 不高频采集
- ❌ 不开放写操作（点赞、收藏、评论、关注、发布）

### 15.2 必须遵守

- ✅ 所有 browse/search/profile 只读
- ✅ 有限结果数量
- ✅ 用户显式触发
- ✅ 推荐流默认禁用
- ✅ 带 timeout/max_results/max_items 限制

---

## 16. 错误码建议

| 错误码 | 含义 |
|--------|------|
| `XHS_BROWSE_DISABLED` | 功能未启用 |
| `XHS_BROWSE_BACKEND_UNAVAILABLE` | 后端不可用 |
| `XHS_BROWSE_TOOL_NOT_FOUND` | 工具名不匹配 |
| `XHS_BROWSE_PROTOCOL_ERROR` | 协议不兼容 |
| `XHS_SEARCH_FAILED` | 搜索失败 |
| `XHS_NOTE_READ_FAILED` | 笔记读取失败 |
| `XHS_PROFILE_DISABLED` | 用户主页功能禁用 |
| `XHS_PROFILE_FAILED` | 用户主页获取失败 |
| `XHS_FEED_DISABLED` | 推荐流功能禁用 |
| `XHS_FEED_FAILED` | 推荐流获取失败 |
| `XHS_AUTH_REQUIRED` | 需要登录 |
| `XHS_RISK_CONTROL` | 触发风控 |
| `XHS_RATE_LIMITED` | 频率限制 |
| `XHS_INVALID_ARGUMENT` | 参数无效 |
| `XHS_TIMEOUT` | 超时 |

---

## 17. 最终结论

### 17.1 核心回答

| 问题 | 答案 |
|------|------|
| 能不能直接替换 jobson-xhs-mcp | **不能**，必须保留 |
| 推荐的最终架构 | social_reader facade + 双后端隔离 |
| 需要新增哪些能力 | xhs_browse_search/note/user/feed/probe |
| 哪些能力默认关闭 | xhs_browse_feed（推荐流） |
| 如何保证 read_social_post 不受影响 | 工具命名空间隔离，后端配置独立 |
| 下一步实现方法 | 修改 socialReaderMcpServer.mjs 新增工具 |

### 17.2 实施要点

1. **保留** `XHS_MCP_*` 配置用于 `read_social_post`
2. **新增** `XHS_BROWSE_MCP_*` 配置用于浏览功能
3. **实现** adapter 层适配候选 MCP 差异
4. **限制** 结果数量和调用频率
5. **禁用** 高风险功能（推荐流）

---

**文档结束**

