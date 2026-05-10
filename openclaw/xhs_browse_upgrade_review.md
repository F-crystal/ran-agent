# 小红书浏览能力升级方案评估

**文档状态**: 只读调研方案  
**创建时间**: 2026-05-10  
**评估范围**: OpenClaw 小红书浏览能力架构升级

---

## 1. 当前项目现状判断

### 1.1 现有架构概览

当前 OpenClaw 通过以下链路处理小红书内容读取：

```
WeChat → Node Bridge → social_reader MCP → jobson-xhs-mcp → 小红书 API
```

**关键组件**:

| 组件 | 位置 | 作用 |
|------|------|------|
| social_reader MCP Server | `/opt/ran_agent/node_bridge/src/socialReaderMcpServer.mjs` | 统一社交平台读取入口 |
| XHS 后端配置 | `XHS_MCP_COMMAND`, `XHS_MCP_ARGS_JSON` 环境变量 | 指定 jobson-xhs-mcp 启动方式 |
| Cookie 凭证 | `XHS_COOKIE` 环境变量 | 小红书登录态 |
| 核心工具 | `read_social_post`, `read_social_post_deep` | 读取单篇笔记内容 |

### 1.2 现有环境变量配置

```bash
# 现有 XHS 相关配置
XHS_COOKIE='<redacted>'                           # 小红书 Cookie (敏感)
XHS_MCP_COMMAND=uvx                               # MCP 后端启动命令
XHS_MCP_ARGS_JSON='["--from","jobson-xhs-mcp","xhs-mcp"]'  # jobson-xhs-mcp
PERSONAL_AGENT_XHS_ENABLED=true                   # 个人代理 XHS 开关
PERSONAL_AGENT_XHS_PROVIDER=social_reader         # 使用 social_reader 作为提供器
PERSONAL_AGENT_XHS_USE_SOCIAL_READER=true         # 显式启用 social_reader
PERSONAL_AGENT_XHS_MCP_COMMAND=uvx                # 个人代理 XHS MCP 命令
PERSONAL_AGENT_XHS_MCP_ARGS_JSON='["--from","jobson-xhs-mcp","xhs-mcp"]'
```

### 1.3 现有代码结构分析

**socialReaderMcpServer.mjs 关键函数**:

- `xhsServerConfig(env)` (行 340): 返回 XHS MCP 后端配置
- `readXhsPost(...)` (行 1341): 核心 XHS 笔记读取逻辑
- `callBackendMcpTool('xhs', 'get_note_content', ...)` : 调用 jobson-xhs-mcp 的 get_note_content 工具
- `callBackendMcpTool('xhs', 'get_note_comments', ...)` : 调用获取评论工具

**现有 MCP 工具列表** (`buildSocialReaderTools()`):

| 工具名 | 用途 |
|--------|------|
| `resolve_social_url` | 解析社交分享链接并识别平台 |
| `read_social_post` | 读取社交帖子内容 |
| `read_social_post_deep` | 深度读取帖子 (含媒体分析) |
| `read_music_share` | 读取音乐分享链接 |
| `check_social_login` | 检查社交平台登录状态 |

### 1.4 现有风控处理逻辑

代码中已包含错误检测 (`xhsBackendTextError` 函数, 行 222):

- `cookie 已失效` / `invalid cookie` → `LOGIN_REQUIRED`
- `验证码` / `风控` / `captcha` → `CAPTCHA_OR_RISK_CONTROL`
- `获取失败` → `BACKEND_MCP_ERROR`

当 jobson-xhs-mcp 失败且 `SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true` 时，会降级到 `wanyi-watermark` 通用解析器。

---

## 2. 是否建议直接替换 jobson-xhs-mcp

### 2.1 结论：**不建议直接替换**

**理由**:

1. **稳定性风险**: jobson-xhs-mcp 是当前经过验证的稳定后端，直接替换可能导致现有 `read_social_post` 链路完全失效
2. **回滚成本高**: 若新后端有问题，需要修改环境变量并重启服务才能回滚
3. **无并行验证期**: 直接替换无法在同一时间段内对比新旧后端的效果
4. **违反约束**: 用户明确要求"保留现有 jobson-xhs-mcp 作为 read_social_post 稳定后端"

### 2.2 推荐策略：**增量新增，可选切换**

- 保持 `XHS_MCP_COMMAND` / `XHS_MCP_ARGS_JSON` 不变
- 新增 `XHS_BROWSE_*` 系列环境变量作为可选后端
- 新后端仅用于新增的浏览/搜索能力，不影响现有读取链路
- 通过独立 MCP 工具命名空间实现隔离

---

## 3. 推荐架构设计

### 3.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw Agent                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   social_reader MCP Server                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  现有工具 (稳定后端)                                         ││
│  │  - resolve_social_url                                        ││
│  │  - read_social_post ──────────► jobson-xhs-mcp (XHS_MCP_*)  ││
│  │  - read_social_post_deep                                     ││
│  │  - check_social_login                                        ││
│  └─────────────────────────────────────────────────────────────┘│
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  新增工具 (可选浏览后端)                                      ││
│  │  - xhs_browse_search        ───────► XHS_BROWSE_* 后端      ││
│  │  - xhs_browse_note          ───────► XHS_BROWSE_* 后端      ││
│  │  - xhs_browse_user          ───────► XHS_BROWSE_* 后端      ││
│  │  - xhs_browse_feed          ───────► XHS_BROWSE_* 后端      ││
│  │  - xhs_browse_probe         ───────► 后端能力探测           ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐
    │ jobson-xhs-mcp  │             │ XHS_BROWSE 后端 │
    │ (稳定读取)       │             │ (可选浏览)       │
    │ get_note_content│             │ search_notes    │
    │ get_note_comments│            │ get_note_info   │
    │                 │             │ get_user_notes  │
    └─────────────────┘             └─────────────────┘
```

### 3.2 工具命名空间隔离

| 工具前缀 | 用途 | 后端依赖 | 可用性影响 |
|----------|------|----------|------------|
| `read_social_post` | 读取单篇笔记 | `XHS_MCP_*` (jobson) | 不受 XHS_BROWSE 影响 |
| `xhs_browse_*` | 搜索/浏览/用户主页 | `XHS_BROWSE_*` | 可选功能，失败不影响读取 |

### 3.3 后端选择逻辑

```
xhs_browse_* 工具调用
       │
       ▼
┌──────────────────────────────┐
│ 检查 XHS_BROWSE_COMMAND 是否  │
│ 已配置且非空                  │
└──────────────────────────────┘
       │
   ┌───┴───┐
   │       │
  是       否
   │       │
   ▼       ▼
调用      返回
XHS_BROWSE  error:
后端      "XHS_BROWSE 未配置"
```

---

## 4. 新增环境变量草案

### 4.1 环境变量列表

```bash
# =============================
# XHS_BROWSE 可选浏览后端配置
# =============================
# 注意：这些是可选配置，不设置时 xhs_browse_* 工具将不可用
# 不影响现有 read_social_post 功能

# XHS_BROWSE 后端启动命令 (示例：uvx, npx, python)
XHS_BROWSE_COMMAND=

# XHS_BROWSE 后端启动参数 (JSON 数组格式)
# 示例 1: 使用 uvx 启动某个 MCP 服务器
# XHS_BROWSE_ARGS_JSON='["--from","some-xhs-browse-mcp","xhs-browse"]'
# 示例 2: 使用 npx 启动
# XHS_BROWSE_ARGS_JSON='["-y","@scope/xhs-browser-mcp"]'
# 示例 3: 使用 python 启动本地脚本
# XHS_BROWSE_ARGS_JSON='["/opt/ran_agent/scripts/xhs_browser_mcp.py"]'
XHS_BROWSE_ARGS_JSON=

# XHS_BROWSE 后端 Cookie (如需登录态)
# 可与 XHS_COOKIE 相同，或使用独立浏览账号
# 注意：不要提交到版本控制
XHS_BROWSE_COOKIE=

# XHS_BROWSE 后端调用超时 (毫秒)
# 默认：60000 (60 秒)
XHS_BROWSE_TIMEOUT_MS=

# XHS_BROWSE 默认最大结果数 (搜索/信息流)
# 默认：10
XHS_BROWSE_MAX_RESULTS=

# XHS_BROWSE 默认最大项目数 (单次浏览)
# 默认：20
XHS_BROWSE_MAX_ITEMS=

# XHS_BROWSE 是否启用 (true/false)
# 默认：false (未配置 COMMAND 时自动禁用)
XHS_BROWSE_ENABLED=
```

### 4.2 .env.example 更新建议

在 `.env.example` 中添加以下注释模板 (不提交真实值):

```bash
# --- XHS Browse (Optional) ---
# XHS_BROWSE_COMMAND=
# XHS_BROWSE_ARGS_JSON=
# XHS_BROWSE_COOKIE=   # never commit
# XHS_BROWSE_TIMEOUT_MS=60000
# XHS_BROWSE_MAX_RESULTS=10
# XHS_BROWSE_MAX_ITEMS=20
# XHS_BROWSE_ENABLED=false
```

---

## 5. 预计修改文件清单

### 5.1 核心修改文件

| 文件路径 | 修改类型 | 说明 |
|----------|----------|------|
| `node_bridge/src/socialReaderMcpServer.mjs` | **新增工具** | 添加 `xhs_browse_*` 工具定义和实现 |
| `.env.example` | **新增变量** | 添加 XHS_BROWSE_* 环境变量模板 |
| `openclaw/xhs_browse_upgrade_review.md` | **新增文档** | 本方案文档 |

### 5.2 可选修改文件

| 文件路径 | 修改类型 | 说明 |
|----------|----------|------|
| `openclaw/openclaw.personal-system.json` | 可选 | 如需调整 MCP 配置 |
| `docs/governance/constraints.md` | 可选 | 记录浏览能力约束 |
| `scripts/` | 可选 | 如需添加后端启动脚本 |

### 5.3 不修改的文件

- `.env.local` - 用户自行配置
- 现有 `XHS_MCP_COMMAND` / `XHS_MCP_ARGS_JSON` 配置
- 现有 `read_social_post` 相关代码逻辑

---

## 6. MCP tools/list 隔离探测命令

### 6.1 探测 social_reader MCP 工具列表

```bash
# 方法 1: 通过 OpenClaw 会话状态查看
npx openclaw agent --json << 'EOF'
{"message": "列出 social_reader MCP 服务器提供的所有工具"}
EOF

# 方法 2: 直接调用 social_reader MCP server (需要 node_bridge 运行)
cd /opt/ran_agent
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
  node node_bridge/src/socialReaderMcpServer.mjs 2>/dev/null | \
  jq '.result.tools[].name'
```

### 6.2 预期输出 (升级后)

```json
[
  "resolve_social_url",
  "read_social_post",
  "read_social_post_deep",
  "read_music_share",
  "check_social_login",
  "xhs_browse_search",
  "xhs_browse_note",
  "xhs_browse_user",
  "xhs_browse_feed",
  "xhs_browse_probe"
]
```

### 6.3 验证工具隔离

```bash
# 验证 xhs_browse_probe 返回后端状态
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xhs_browse_probe","arguments":{}}}' | \
  XHS_BROWSE_COMMAND=uvx \
  XHS_BROWSE_ARGS_JSON='["--from","jobson-xhs-mcp","xhs-mcp"]' \
  node node_bridge/src/socialReaderMcpServer.mjs 2>/dev/null | \
  jq '.result'
```

---

## 7. 服务器验证命令

### 7.1 环境配置验证

```bash
# 检查当前 XHS 相关环境变量
cd /opt/ran_agent
grep -E "^XHS_|^PERSONAL_AGENT_XHS_" .env.local 2>/dev/null || echo "No XHS env vars in .env.local"

# 检查 XHS_BROWSE 配置是否存在
grep -E "^XHS_BROWSE_" .env.local 2>/dev/null || echo "XHS_BROWSE not configured (expected)"
```

### 7.2 social_reader MCP 服务健康检查

```bash
# 启动 social_reader MCP 并测试 tools/list
cd /opt/ran_agent
timeout 5 node node_bridge/src/socialReaderMcpServer.mjs << 'EOF' || true
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
EOF
```

### 7.3 后端连通性测试 (配置 XHS_BROWSE 后)

```bash
# 测试 xhs_browse_probe 工具
cd /opt/ran_agent
timeout 10 node node_bridge/src/socialReaderMcpServer.mjs << 'EOF' || true
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"xhs_browse_probe","arguments":{}}}
EOF
```

### 7.4 现有 read_social_post 回归测试

```bash
# 确保 XHS_BROWSE 未配置时 read_social_post 仍正常工作
cd /opt/ran_agent
unset XHS_BROWSE_COMMAND XHS_BROWSE_ARGS_JSON
timeout 30 node node_bridge/src/socialReaderMcpServer.mjs << 'EOF' || true
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_social_post","arguments":{"url":"https://www.xiaohongshu.com/explore/xxx"}}}
EOF
```

---

## 8. 风险清单

### 8.1 低风险 (可接受)

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| XHS_BROWSE 后端不可用 | 中 | 仅浏览功能不可用 | 工具返回明确错误，不影响 read_social_post |
| XHS_BROWSE 超时 | 中 | 单次请求失败 | 设置合理 timeout (默认 60s)，带超时错误码 |
| Cookie 失效 | 中 | 浏览功能返回 LOGIN_REQUIRED | 错误检测 + 用户手动更新 |

### 8.2 中风险 (需关注)

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 新工具与现有工具命名冲突 | 低 | tools/list 混乱 | 严格使用 `xhs_browse_*` 前缀隔离 |
| 环境变量解析错误 | 低 | 后端启动失败 | JSON 解析加 fallback 和错误处理 |
| MCP 协议不兼容 | 低 | 工具调用失败 | 遵循标准 MCP protocolVersion |

### 8.3 高风险 (需避免)

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 修改 XHS_MCP_* 配置 | **禁止** | read_social_post 失效 | 明确文档约束，代码中不改动 |
| 新后端替代旧后端 | **禁止** | 稳定链路中断 | 增量新增，不替换 |
| Cookie 泄露 | 中 | 安全风险 | 不打印/记录 Cookie，.env.local 不提交 |
| 高频采集触发风控 | 中 | 账号受限 | 限制 max_results/max_items，低频使用 |

---

## 9. 降级策略

### 9.1 自动降级

```
xhs_browse_* 调用
       │
       ▼
┌─────────────────────────────┐
│ XHS_BROWSE_COMMAND 为空？    │
└─────────────────────────────┘
       │
   ┌───┴───┐
   │       │
  是       否
   │       │
   ▼       ▼
返回       调用后端
error:     │
"未配置"   ▼
       ┌─────────────────┐
       │ 调用成功？       │
       └─────────────────┘
              │
          ┌───┴───┐
          │       │
         是       否
          │       │
          ▼       ▼
       返回结果  返回 error
```

### 9.2 手动降级/禁用

```bash
# 方法 1: 清空 XHS_BROWSE_COMMAND
export XHS_BROWSE_COMMAND=""

# 方法 2: 设置 XHS_BROWSE_ENABLED=false
export XHS_BROWSE_ENABLED=false

# 方法 3: 在 .env.local 中注释掉相关配置
# XHS_BROWSE_COMMAND=...
```

### 9.3 紧急回滚

如需完全移除 XHS_BROWSE 功能：

1. 从 `.env.local` 删除所有 `XHS_BROWSE_*` 配置
2. 从 `socialReaderMcpServer.mjs` 移除 `xhs_browse_*` 工具定义 (如已添加)
3. 重启 social_reader MCP 服务

**注意**: 现有 `read_social_post` 不受影响，无需回滚。

---

## 10. 实现约束 (必须遵守)

### 10.1 功能边界

- [x] 只读操作：不点赞、不收藏、不评论、不关注
- [x] 低频使用：用户显式触发，非自动/定时任务
- [x] 带限流参数：`max_results`, `max_items`, `timeout`
- [x] 可选启用：未配置时不报错，仅功能不可用

### 10.2 不设计的功能 (明确排除)

- [ ] Cookie 自动轮换
- [ ] 多账号备用
- [ ] 绕过风控机制
- [ ] 高频采集/爬虫
- [ ] 自动登录/刷新

### 10.3 代码约束

- 不修改 `xhsServerConfig()` 函数
- 不修改 `XHS_MCP_COMMAND` / `XHS_MCP_ARGS_JSON` 读取逻辑
- 不修改 `readXhsPost()` 函数
- 新增 `xhsBrowseServerConfig()` 独立配置函数
- 新增 `xhs_browse_*` 工具独立实现

---

## 11. 新增工具设计草案

### 11.1 xhs_browse_probe

**用途**: 探测 XHS_BROWSE 后端是否可用

**输入**:
```json
{}
```

**输出 (成功)**:
```json
{
  "ok": true,
  "backend": "xhs_browse",
  "command": "uvx",
  "tools_available": ["search_notes", "get_note_info", "..."]
}
```

**输出 (未配置)**:
```json
{
  "ok": false,
  "error_code": "XHS_BROWSE_NOT_CONFIGURED",
  "message": "XHS_BROWSE_COMMAND not set"
}
```

### 11.2 xhs_browse_search

**用途**: 搜索小红书笔记

**输入**:
```json
{
  "query": "关键词",
  "max_results": 10,
  "sort": "relevance"  // 或 "latest", "most_popular"
}
```

**输出**:
```json
{
  "ok": true,
  "query": "关键词",
  "results": [
    {"note_id": "...", "title": "...", "user": "...", "url": "..."}
  ],
  "total_count": 10
}
```

### 11.3 xhs_browse_note

**用途**: 获取笔记详情 (非评论)

**输入**:
```json
{
  "note_id": "...",
  "include_images": true
}
```

**输出**:
```json
{
  "ok": true,
  "note_id": "...",
  "title": "...",
  "content": "...",
  "images": ["url1", "url2"],
  "user": {"id": "...", "name": "..."}
}
```

### 11.4 xhs_browse_user

**用途**: 获取用户主页笔记列表

**输入**:
```json
{
  "user_id": "...",
  "max_items": 20
}
```

**输出**:
```json
{
  "ok": true,
  "user_id": "...",
  "user_info": {"name": "...", "followers": "..."},
  "notes": [...]
}
```

### 11.5 xhs_browse_feed

**用途**: 获取推荐信息流

**输入**:
```json
{
  "category": "default",
  "max_items": 10
}
```

**输出**:
```json
{
  "ok": true,
  "feed": [...]
}
```

---

## 12. 总结

### 12.1 核心决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 是否替换 jobson-xhs-mcp | **否** | 保持 read_social_post 稳定 |
| 新后端命名 | `XHS_BROWSE_*` | 与现有 `XHS_MCP_*` 清晰隔离 |
| 工具命名前缀 | `xhs_browse_*` | 与 `read_social_post` 隔离 |
| 后端选择逻辑 | 可选启用 | 未配置时不报错，仅功能不可用 |

### 12.2 实施优先级

1. **P0**: 在 `socialReaderMcpServer.mjs` 中新增 `xhs_browse_*` 工具定义
2. **P1**: 实现 `xhsBrowseServerConfig()` 和后端调用逻辑
3. **P1**: 更新 `.env.example` 添加环境变量模板
4. **P2**: 编写 `xhs_browse_probe` 探测工具
5. **P2**: 添加服务器验证命令到文档

### 12.3 验收标准

- [ ] `tools/list` 显示新增的 `xhs_browse_*` 工具
- [ ] 未配置 `XHS_BROWSE_COMMAND` 时，调用返回清晰错误
- [ ] 配置有效后端后，`xhs_browse_probe` 返回成功
- [ ] 现有 `read_social_post` 功能不受影响 (回归测试通过)
- [ ] `.env.local` 未被修改
- [ ] 无真实 Cookie/API key 被打印或记录

---

**文档结束**
