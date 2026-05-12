# OpenClaw -- 前端 Agent 运行时配置

本目录包含 OpenClaw 前端 Agent 的运行时合约、配置基线和安全边界定义。OpenClaw 是整个个人助手系统的"大脑"，负责接收消息、调用工具、生成回复，并管理会话上下文与记忆。

## OpenClaw 在架构中的位置

```
Node Bridge (微信消息桥接)
      |
      v
   OpenClaw (前端 Agent 运行时)  <-- 本目录定义其行为
      |
      +-- MCP 工具调用 (媒体读取、社媒解析、媒体生成、深度分析等)
      +-- 会话上下文管理 (上下文裁剪、记忆注入、心跳)
      +-- 自然语言回复生成
      |
      v
   Node Bridge (微信消息回传)
```

OpenClaw 通过 `claude_code` provider 接入 `qwen3.5-plus` 模型，以本地网关模式运行在 `127.0.0.1:19123`。所有前端对话流量只走 `claude_code` 路由，不使用其他 provider 作为前台回退。

## 目录文件说明

### 核心运行时文件

| 文件 | 说明 |
|------|------|
| `AGENTS.md` | OpenClaw 运行时合约。定义人设演化、前台锁定、回复质量标准、心跳行为、待办/提醒规则、工具路由策略、媒体生成约定等。由 `bootstrap-extra-files` hook 在启动时注入。 |
| `openclaw.personal-system.json` | OpenClaw 网关与 Agent 配置。包含网关端口、模型定义、MCP 服务器、上下文裁剪策略、心跳参数、插件配置等。 |
| `SECURITY_BOUNDARY.md` | 工作区边界与权限策略。明确允许/谨慎/拒绝的操作级别，以及频道和命令的访问控制。 |

### 参考文档

| 文件 | 说明 |
|------|------|
| `HERMES_MEMORY.md` | Hermes 风格记忆预算参考 |
| `HERMES_RUNTIME.md` | Hermes 风格运行时上下文预算参考 |
| `HERMES_USER.md` | Hermes 用户画像参考 |
| `calendar-reminder-workflow.md` | 日历提醒工作流 |
| `feishu-voice-message-workflow.md` | 飞书语音消息工作流 |
| `time-context-checklist.md` | 时间上下文检查清单 |

## MCP 工具清单

OpenClaw 可调用以下 MCP 工具：

| MCP 服务器 | 用途 |
|------------|------|
| `media_reader` | 统一媒体读取 facade -- 图片 OCR、音频 ASR、视频分析。底层由 PaddleOCR、DashScope qwen3-vl-flash / qwen3-asr-flash、ffmpeg/ffprobe 支撑。 |
| `social_reader` | 社媒内容只读 facade -- B 站、小红书、微信公众号文章等平台内容解析。不控制播放器。 |
| `media_generation` | 媒体生成 -- 图片生成 (DashScope qwen-image) 和语音合成 (DashScope qwen3-omni-flash)。 |
| `mimo_power` | 深度多模态分析 -- 长上下文重任务、复杂截图/音频/视频/文档综合推理。依赖 MiMo Token Plan。 |
| `playwright` | 浏览器自动化 -- 动态页面、登录态检查、SPA 渲染、截图等交互场景。 |
| `time` | 时区感知时间查询，本地时区为 `Asia/Shanghai`。 |

### 媒体处理管线

微信入站媒体的处理遵循以下管线：

**上下文压缩策略 (Context Policy v1)**：默认开启紧凑模式，每轮最多注入 3 个媒体 artifact，每个紧凑渲染（≤180 字符）。优先级：`explicit_ref` > `current_media` > `recent_candidate` > `history`。可通过 `OPENCLAW_CONTEXT_POLICY=legacy` 回退。详见 `docs/governance/media-pipeline.md`。

```
入站媒体 (图片/音频/视频/文档)
      |
      v
  媒体缓冲区 (可信入站目录)
      |
      v
  媒体 Artifact (会话级媒体上下文)
      |
      v
  工具调用 (mimo_power / media_reader / social_reader)
      |
      v
  分析结果融入回复
```

本地 `file_path` 仅接受桥接层可信媒体目录中的文件；URL 媒体资产必须是远程 `http(s)` 地址。项目内的 `.env`、状态、vault 等文件不能作为媒体资产传给工具。

## 配置要点

### 模型与 Provider

- 活跃模型：`qwen3.5-plus`，通过 `claude_code` provider 路由
- 上下文窗口：120,000 tokens
- 最大输出：8,192 tokens
- Kimi 和 GLM 已退役，不在前台路由配置中

### 上下文管理

- 上下文裁剪模式：`cache-ttl`，TTL 10 分钟
- 软裁剪比例 25%，硬清比例 45%
- 保留最近 3 条助手回复
- 压缩模式：`safeguard`，保留 12,000 tokens 底线

### 心跳

- 间隔：90 分钟
- 活跃时段：08:30 - 23:30 (Asia/Shanghai)
- 心跳行为：检查待办、追踪提醒，无事则回复 `HEARTBEAT_OK`

### 会话重置

- 每日凌晨 04:00 自动重置
- `/new` 和 `/reset` 命令触发手动重置
- 会话连续性由记忆和每日上下文维持，不复用历史对话

## 部署注意事项

- 替换 `REPLACE_WITH_OWNER_WECHAT_USER_ID` 为实际微信用户 ID 后方可投入使用
- `OPENCLAW_STATE_DIR` 必须保持在本仓库检出目录内 (默认 `.openclaw_state/`)
- 不要放宽 `allowFrom` / `ownerAllowFrom` / `commands.allowFrom` 的权限范围，始终限定为 owner
- 网关令牌配置在 `node_bridge/.env.local`，不要提交到版本控制
- OpenClaw 配置保持项目本地化，不要外泄到其他项目
