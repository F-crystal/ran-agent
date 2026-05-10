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


---

## 18. v3.1 执行前修订意见

### 18.1 最终架构确认

| 决策点 | 最终确认 |
|--------|----------|
| 是否直接替换 jobson-xhs-mcp | ❌ **不替换**，保留作为稳定后端 |
| 现有 `XHS_MCP_*` 配置 | ✅ **保留** `XHS_MCP_COMMAND` / `XHS_MCP_ARGS_JSON` / `XHS_COOKIE` |
| `read_social_post` 链路 | ✅ **继续走** jobson-xhs-mcp 稳定旧链路 |
| `read_social_post_deep` 链路 | ✅ **继续走** jobson-xhs-mcp + media_reader |
| 新增 browse/search/profile 能力 | ✅ **作为独立可选后端**接入 |
| OpenClaw 调用方式 | ✅ **只调用** social_reader facade 暴露的稳定工具 |
| OpenClaw 与第三方 MCP 关系 | ✅ **不直接依赖**第三方小红书 MCP 原始工具名 |
| 第三方 browse MCP 接入方式 | ✅ **通过 adapter 映射**接入 |

**架构核心原则**：
- OpenClaw → social_reader facade → (jobson-xhs-mcp | browse adapter) → 小红书 API
- OpenClaw **不感知**底层 MCP 的具体工具名
- browse adapter **负责**工具名映射、响应归一化、错误码转换

---

### 18.2 最终环境变量命名

采用贴合现有 `XHS_MCP_*` 风格的命名：

```bash
# --- XHS Browse (Optional) ---
# 主开关
XHS_BROWSE_ENABLED=false

# 后端配置
XHS_BROWSE_MCP_COMMAND=
XHS_BROWSE_MCP_ARGS_JSON=

# Cookie 配置（不直接存 Cookie 值）
XHS_BROWSE_MCP_COOKIE_ENV=XHS_COOKIE

# 超时与限流
XHS_BROWSE_MCP_TIMEOUT_MS=60000
XHS_BROWSE_MAX_RESULTS=5
XHS_BROWSE_MAX_ITEMS=5
XHS_BROWSE_MIN_INTERVAL_MS=30000
XHS_BROWSE_MAX_CALLS_PER_SESSION=10

# 功能级开关
XHS_BROWSE_SEARCH_ENABLED=true
XHS_BROWSE_NOTE_ENABLED=true
XHS_BROWSE_USER_ENABLED=false
XHS_BROWSE_FEED_ENABLED=false
```

**特别说明**：

| 要点 | 说明 |
|------|------|
| **不建议** `XHS_BROWSE_MCP_COOKIE` 存真实 Cookie | 避免 Cookie 冗余存储和泄露风险 |
| **推荐** `XHS_BROWSE_MCP_COOKIE_ENV=XHS_COOKIE` | 仅存储变量名，代码读取时动态获取 |
| **默认复用** 现有 `XHS_COOKIE` | 不复制 Cookie 值，减少敏感数据暴露 |
| **日志禁止打印** Cookie 值 | 也不得打印 `XHS_BROWSE_MCP_COOKIE_ENV` 指向的真实内容 |
| **`.env.local`** | 由用户手动配置，代码/agent **不自动修改** |

---

### 18.3 默认启用策略修正

| 工具 | 默认状态 | 控制开关 | 说明 |
|------|----------|----------|------|
| `xhs_browse_probe` | ✅ **可用** | 无（始终可用） | 用于探测后端状态 |
| `xhs_browse_search` | ⚠️ **受控** | `XHS_BROWSE_ENABLED` | 搜索功能，默认开启但受主开关控制 |
| `xhs_browse_note` | ⚠️ **受控** | `XHS_BROWSE_ENABLED` | 笔记详情，受主开关控制 |
| `xhs_browse_user` | ❌ **关闭** | `XHS_BROWSE_USER_ENABLED=true` | 用户主页，需显式启用 |
| `xhs_browse_feed` | ❌ **关闭** | `XHS_BROWSE_FEED_ENABLED=true` | 推荐流，高风险，需显式启用 |

**限制策略**：

| 功能 | 默认数量 | 硬上限 | 翻页策略 |
|------|----------|--------|----------|
| `search` | 5 条 | 10 条 | ❌ 不允许自动翻页 |
| `user/profile` | 5 条 | 10 条 | ❌ 不允许自动翻页 |
| `feed` | 5 条 | 10 条 | ❌ 不允许自动翻页，❌ 不允许循环刷 |

---

### 18.4 `read_social_post` 与 `xhs_browse_note` 的边界

| 维度 | `read_social_post` | `xhs_browse_note` |
|------|-------------------|-------------------|
| **职责** | 用户给定 URL 的稳定读取 | browse/search 后端返回的 note_id 读取 |
| **后端** | jobson-xhs-mcp | browse adapter 后端 |
| **输入** | 完整 URL（如 `xiaohongshu.com/explore/xxx`） | `note_id` 或 `note_url` |
| **失败影响** | 不影响 browse 功能 | **不影响** `read_social_post` |
| **browse 后端不可用时** | 继续使用，不受影响 | 建议用户改用 `read_social_post` 读取具体链接 |

**核心原则**：
- **不允许**为了 browse 功能改坏 `read_social_post`
- `read_social_post` 是**稳定链路**，优先级最高

---

### 18.5 候选 MCP 探测机制

**探测工具**：`xhs_browse_probe`

**探测流程**：
1. 检查 `XHS_BROWSE_MCP_COMMAND` 是否配置
2. 启动后端（如未运行）
3. 调用 MCP `tools/list` 方法
4. 解析返回的工具列表
5. 尝试匹配候选工具名
6. 返回探测结果

**不假设**：
- ❌ 不假设 `xiaohongshu-api-mcp` 一定存在
- ❌ 不假设候选 MCP 命令名一定正确
- ❌ 不假设候选 MCP 工具名一定是 `search_notes` / `get_note_info` / `get_user_notes`

**返回结构**：

```json
// 成功
{
  "ok": true,
  "backend": "xhs_browse",
  "command": "uvx",
  "args": ["--from", "some-mcp", "mcp"],
  "available_tools": ["search_notes", "get_note_info", "get_user_notes"],
  "matched_tools": {
    "search": "search_notes",
    "note": "get_note_info",
    "user": "get_user_notes"
  }
}

// 未配置
{
  "ok": false,
  "error_code": "XHS_BROWSE_NOT_CONFIGURED",
  "message": "XHS_BROWSE_MCP_COMMAND not set"
}

// 后端启动失败
{
  "ok": false,
  "error_code": "XHS_BROWSE_BACKEND_UNAVAILABLE",
  "message": "Failed to start backend"
}

// 工具名不匹配
{
  "ok": false,
  "error_code": "XHS_BROWSE_TOOL_NOT_FOUND",
  "available_tools": ["unknown_tool_1", "unknown_tool_2"],
  "message": "No matching tools found for search/note/user"
}

// 协议不兼容
{
  "ok": false,
  "error_code": "XHS_BROWSE_PROTOCOL_ERROR",
  "message": "MCP protocol version mismatch"
}
```

**核心原则**：
- `tools/list` 结果**只用于** runtime adapter 映射
- `tools/list` 结果**不写入** `.env.local`
- 探测失败**不影响** `read_social_post`

---

### 18.6 Adapter 设计

**Adapter 职责**：

| 职责 | 说明 |
|------|------|
| 第三方工具名映射 | 将 OpenClaw 工具名映射到候选 MCP 的实际工具名 |
| 第三方返回结构归一化 | 将候选 MCP 的响应转换为 OpenClaw 标准结构 |
| 第三方错误码归一化 | 将候选 MCP 的错误码转换为 OpenClaw 标准错误码 |
| Cookie/token 脱敏 | 日志中不打印敏感信息 |
| timeout 控制 | 超时后返回 `XHS_TIMEOUT` |
| `max_results` / `max_items` 裁剪 | 确保不超过配置上限 |
| rate limit 检查 | 检查调用频率，超限返回 `XHS_RATE_LIMITED` |
| 后端不可用降级 | 返回结构化错误，不影响旧链路 |
| 异常封装 | 不把第三方 MCP 原始异常直接暴露给 OpenClaw |

**工具映射建议**（候选列表，非硬编码）：

```javascript
const TOOL_CANDIDATES = {
  'search': ['search_notes', 'search', 'query_notes', 'search_note'],
  'note': ['get_note_info', 'get_note', 'note_detail', 'get_note_content'],
  'user': ['get_user_notes', 'user_profile', 'user_homepage'],
  'feed': ['get_feed', 'explore', 'recommendation_feed']
};
```

---

### 18.7 限流策略

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `XHS_BROWSE_MIN_INTERVAL_MS` | `30000` (30 秒) | 两次调用最小间隔 |
| `XHS_BROWSE_MAX_CALLS_PER_SESSION` | `10` | 单 session 最大调用次数 |

**限流行为**：

| 场景 | 返回错误码 | 说明 |
|------|------------|------|
| 调用间隔 < `MIN_INTERVAL_MS` | `XHS_RATE_LIMITED` | 保护性限流 |
| session 调用次数 > `MAX_CALLS_PER_SESSION` | `XHS_RATE_LIMITED` | 保护性限流 |

**核心原则**：
- ✅ 这是**保护性限流**，不是绕过风控
- ❌ **不设计**随机等待（避免被误认为绕过策略）
- ❌ **不设计**多账号轮换
- ❌ **不设计**Cookie 自动轮换

---

### 18.8 工具设计修订

#### 18.8.1 xhs_browse_probe

| 属性 | 说明 |
|------|------|
| **默认启用** | 是（始终可用） |
| **依赖开关** | 无 |
| **输入 schema** | `{}` |
| **输出 schema** | `{ ok, backend, command, args, available_tools, matched_tools }` |
| **主要错误码** | `XHS_BROWSE_NOT_CONFIGURED`, `XHS_BROWSE_BACKEND_UNAVAILABLE`, `XHS_BROWSE_PROTOCOL_ERROR` |
| **timeout** | `XHS_BROWSE_MCP_TIMEOUT_MS` (默认 60000) |
| **后端不可用返回** | `{ ok: false, error_code: 'XHS_BROWSE_BACKEND_UNAVAILABLE' }` |
| **影响 read_social_post** | ❌ **不影响** |

#### 18.8.2 xhs_browse_search

| 属性 | 说明 |
|------|------|
| **默认启用** | 是（受 `XHS_BROWSE_ENABLED` 控制） |
| **依赖开关** | `XHS_BROWSE_ENABLED`, `XHS_BROWSE_SEARCH_ENABLED` |
| **输入 schema** | `{ query: string, max_results?: number (1-10), sort?: 'relevance'|'latest'|'popular' }` |
| **输出 schema** | `{ ok, query, results: [{ note_id, title, user, url, cover_image }], total_count }` |
| **主要错误码** | `XHS_BROWSE_DISABLED`, `XHS_SEARCH_FAILED`, `XHS_AUTH_REQUIRED`, `XHS_RATE_LIMITED` |
| **max_results** | 默认 5，硬上限 10 |
| **timeout** | `XHS_BROWSE_MCP_TIMEOUT_MS` |
| **rate limit** | `XHS_BROWSE_MIN_INTERVAL_MS`, `XHS_BROWSE_MAX_CALLS_PER_SESSION` |
| **后端不可用返回** | `{ ok: false, error_code: 'XHS_BROWSE_BACKEND_UNAVAILABLE' }` |
| **影响 read_social_post** | ❌ **不影响** |

#### 18.8.3 xhs_browse_note

| 属性 | 说明 |
|------|------|
| **默认启用** | 是（受 `XHS_BROWSE_ENABLED` 控制） |
| **依赖开关** | `XHS_BROWSE_ENABLED`, `XHS_BROWSE_NOTE_ENABLED` |
| **输入 schema** | `{ note_id: string, include_images?: boolean }` |
| **输出 schema** | `{ ok, note_id, title, content, images: [], user: { id, name }, create_time }` |
| **主要错误码** | `XHS_BROWSE_DISABLED`, `XHS_NOTE_READ_FAILED`, `XHS_AUTH_REQUIRED` |
| **timeout** | `XHS_BROWSE_MCP_TIMEOUT_MS` |
| **rate limit** | `XHS_BROWSE_MIN_INTERVAL_MS`, `XHS_BROWSE_MAX_CALLS_PER_SESSION` |
| **后端不可用返回** | `{ ok: false, error_code: 'XHS_BROWSE_BACKEND_UNAVAILABLE' }` |
| **影响 read_social_post** | ❌ **不影响** |

#### 18.8.4 xhs_browse_user

| 属性 | 说明 |
|------|------|
| **默认启用** | ❌ **否**（需 `XHS_BROWSE_USER_ENABLED=true`） |
| **依赖开关** | `XHS_BROWSE_USER_ENABLED` |
| **输入 schema** | `{ user_id: string, max_items?: number (1-10) }` |
| **输出 schema** | `{ ok, user_id, user_info: { name, avatar, followers }, notes: [{ note_id, title, cover_image }] }` |
| **主要错误码** | `XHS_BROWSE_DISABLED`, `XHS_PROFILE_DISABLED`, `XHS_PROFILE_FAILED`, `XHS_AUTH_REQUIRED` |
| **max_items** | 默认 5，硬上限 10 |
| **timeout** | `XHS_BROWSE_MCP_TIMEOUT_MS` |
| **rate limit** | `XHS_BROWSE_MIN_INTERVAL_MS`, `XHS_BROWSE_MAX_CALLS_PER_SESSION` |
| **后端不可用返回** | `{ ok: false, error_code: 'XHS_BROWSE_BACKEND_UNAVAILABLE' }` |
| **影响 read_social_post** | ❌ **不影响** |

#### 18.8.5 xhs_browse_feed

| 属性 | 说明 |
|------|------|
| **默认启用** | ❌ **否**（需 `XHS_BROWSE_FEED_ENABLED=true`） |
| **依赖开关** | `XHS_BROWSE_FEED_ENABLED` |
| **输入 schema** | `{ category?: 'default'|'food'|'travel'|'fashion', max_items?: number (1-10) }` |
| **输出 schema** | `{ ok, category, feed: [{ note_id, title, user, url }] }` |
| **主要错误码** | `XHS_BROWSE_DISABLED`, `XHS_FEED_DISABLED`, `XHS_FEED_FAILED`, `XHS_RATE_LIMITED` |
| **max_items** | 默认 5，硬上限 10 |
| **timeout** | `XHS_BROWSE_MCP_TIMEOUT_MS` |
| **rate limit** | `XHS_BROWSE_MIN_INTERVAL_MS`, `XHS_BROWSE_MAX_CALLS_PER_SESSION` |
| **后端不可用返回** | `{ ok: false, error_code: 'XHS_BROWSE_BACKEND_UNAVAILABLE' }` |
| **影响 read_social_post** | ❌ **不影响** |
| **额外限制** | ❌ 不允许自动翻页，❌ 不允许循环刷 |

---

### 18.9 错误码补全

统一错误码列表：

| 错误码 | 含义 | 触发场景 |
|--------|------|----------|
| `XHS_BROWSE_DISABLED` | 功能未启用 | `XHS_BROWSE_ENABLED=false` 或功能级开关关闭 |
| `XHS_BROWSE_BACKEND_UNAVAILABLE` | 后端不可用 | 后端启动失败、连接超时 |
| `XHS_BROWSE_TOOL_NOT_FOUND` | 工具名不匹配 | 候选 MCP 无对应工具 |
| `XHS_BROWSE_PROTOCOL_ERROR` | 协议不兼容 | MCP 协议版本不匹配 |
| `XHS_SEARCH_FAILED` | 搜索失败 | 搜索接口返回错误 |
| `XHS_NOTE_READ_FAILED` | 笔记读取失败 | 笔记详情接口返回错误 |
| `XHS_PROFILE_DISABLED` | 用户主页功能禁用 | `XHS_BROWSE_USER_ENABLED=false` |
| `XHS_PROFILE_FAILED` | 用户主页获取失败 | 接口返回错误 |
| `XHS_FEED_DISABLED` | 推荐流功能禁用 | `XHS_BROWSE_FEED_ENABLED=false` |
| `XHS_FEED_FAILED` | 推荐流获取失败 | 接口返回错误 |
| `XHS_AUTH_REQUIRED` | 需要登录 | Cookie 失效或缺失 |
| `XHS_RISK_CONTROL` | 触发风控 | 验证码、IP 限制 |
| `XHS_RATE_LIMITED` | 频率限制 | 调用间隔过短或 session 超限 |
| `XHS_INVALID_ARGUMENT` | 参数无效 | 输入参数校验失败 |
| `XHS_TIMEOUT` | 超时 | 后端调用超过 `XHS_BROWSE_MCP_TIMEOUT_MS` |
| `XHS_BACKEND_MCP_ERROR` | 后端 MCP 内部错误 | 候选 MCP 返回未知错误 |

---

### 18.10 服务器验证命令修正

**优先使用项目现有入口**：
- ✅ `scripts/start_social_reader_mcp.sh`
- ✅ `scripts/openclaw_with_env.sh agent`

**验证命令草案**：

#### 18.10.1 tools/list 验证

```bash
cd /opt/ran_agent

# 启动 MCP 服务（后台）
./scripts/start_social_reader_mcp.sh &
MCP_PID=$!

# 等待服务启动
sleep 2

# 发送 initialize + tools/list
cat <<'JSONRPC' | nc -q 1 127.0.0.1 <PORT>
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"notifications/initialized"}
{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}
JSONRPC

# 清理
kill $MCP_PID 2>/dev/null || true
```

#### 18.10.2 xhs_browse_probe 未配置测试

```bash
# 未配置 XHS_BROWSE_MCP_COMMAND 时
XHS_BROWSE_MCP_COMMAND= \
XHS_BROWSE_MCP_ARGS_JSON= \
# 应返回 XHS_BROWSE_NOT_CONFIGURED 或 XHS_BROWSE_BACKEND_UNAVAILABLE
```

#### 18.10.3 xhs_browse_search max_results 裁剪测试

```bash
# 请求 max_results=20（超过硬上限 10）
# 应自动裁剪为 10 并返回
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xhs_browse_search","arguments":{"query":"美食","max_results":20}}}
```

#### 18.10.4 xhs_browse_user 默认关闭测试

```bash
# 未设置 XHS_BROWSE_USER_ENABLED=true 时
# 应返回 XHS_PROFILE_DISABLED
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xhs_browse_user","arguments":{"user_id":"xxx"}}}
```

#### 18.10.5 xhs_browse_feed 默认关闭测试

```bash
# 未设置 XHS_BROWSE_FEED_ENABLED=true 时
# 应返回 XHS_FEED_DISABLED
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xhs_browse_feed","arguments":{}}}
```

#### 18.10.6 read_social_post 回归测试

```bash
# 确保 browse 功能不影响现有 read_social_post
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_social_post","arguments":{"url":"https://www.xiaohongshu.com/explore/xxx"}}}
```

#### 18.10.7 后端工具名不匹配测试

```bash
# 候选 MCP 返回的工具名与预期不匹配时
# 应返回 XHS_BROWSE_TOOL_NOT_FOUND 并附带 available_tools
```

#### 18.10.8 日志脱敏检查建议

```bash
# 检查日志中是否包含敏感信息
grep -i "cookie\|token\|sessdata\|id_token\|xsec" logs/*.log
# 应无匹配结果（或仅有变量名，无真实值）
```

---

### 18.11 明确不应修改的内容

| 项目 | 说明 |
|------|------|
| `.env.local` | ❌ **不修改**，由用户手动配置 |
| `XHS_MCP_COMMAND` | ❌ **不替换**，保持现有值 |
| `XHS_MCP_ARGS_JSON` | ❌ **不替换**，保持现有值 |
| `XHS_COOKIE` | ❌ **不复制**，browse 后端复用变量名 |
| `read_social_post` 代码 | ❌ **不改坏**，保持现有逻辑 |
| browse 后端影响旧链路 | ❌ **不允许**，工具命名空间隔离 |
| 写操作（点赞/收藏/评论/关注/发布） | ❌ **不开放**，只读能力 |
| Cookie 自动轮换 | ❌ **不设计** |
| 多账号备用 | ❌ **不设计** |
| 绕过风控策略 | ❌ **不设计** |
| 高频采集 | ❌ **不允许**，限流保护 |

---

### 18.12 实现前最终结论

| 问题 | 最终结论 |
|------|----------|
| v3 原方案是否可用 | ✅ **总体可用**，但需 v3.1 修订后才建议进入代码实现 |
| 最终推荐架构 | **social_reader facade + 旧 read 后端 (jobson) + 新 browse adapter 后端** |
| 默认开放哪些功能 | **probe / search / note**（受 `XHS_BROWSE_ENABLED` 控制） |
| 默认关闭哪些功能 | **user / feed**（需显式启用对应开关） |
| browse 失败影响 read_social_post | ❌ **任何 browse 失败都不能影响** `read_social_post` |
| 是否替换 jobson-xhs-mcp | ❌ **不替换**，保留作为稳定后端 |
| Cookie 处理策略 | **复用** `XHS_COOKIE`，不新增独立 Cookie 变量 |
| 限流策略 | **保护性限流**，`MIN_INTERVAL_MS=30000`, `MAX_CALLS_PER_SESSION=10` |

**实施前提**：
1. ✅ v3 原方案架构设计完成
2. ✅ v3.1 修订意见明确
3. ⏳ 等待用户确认后进入代码实现阶段

---

**v3.1 修订结束**
