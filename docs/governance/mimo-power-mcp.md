# MiMo Power MCP 配置文档

Status: CURRENT (2026-05-15)

## 概述

MiMo Power MCP 是一个多模态分析工具，通过 MiMo Token Plan API 提供图像、音频、视频和文本的深度分析能力。

## 环境变量配置

### 必需配置

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `MIMO_TOKEN_PLAN_API_KEY` | MiMo Token Plan API 密钥 | `tp-xxxxxxxx` |
| `MIMO_TOKEN_PLAN_OPENAI_BASE_URL` | API 基础 URL | `https://token-plan-cn.xiaomimimo.com/v1` |
| `MIMO_TOKEN_PLAN_EXPIRES_AT` | Token 过期时间 | `2026-06-09T23:59:00Z` |

### Endpoint 风格

| 变量名 | 值 | 默认值 | 说明 |
|--------|-----|--------|------|
| `MIMO_POWER_ENDPOINT_STYLE` | `chat` \| `responses` | `chat` | 选择 API endpoint 风格 |

- `chat`: 使用 `/chat/completions` endpoint（OpenAI Chat Completions 格式）
- `responses`: 使用 `/responses` endpoint（OpenAI Responses API 格式）

### Model Routing

| 变量名 | 说明 | 默认 fallback |
|--------|------|---------------|
| `MIMO_POWER_TEXT_MODEL` | 文本任务专用模型 | `MIMO_POWER_MODEL` → `mimo-v2.5-pro` |
| `MIMO_POWER_VISION_MODEL` | 视觉任务专用模型（image/video） | `MIMO_POWER_MULTIMODAL_MODEL` → 报错 |
| `MIMO_POWER_AUDIO_MODEL` | 音频任务专用模型 | `MIMO_POWER_MULTIMODAL_MODEL` → 报错 |
| `MIMO_POWER_MULTIMODAL_MODEL` | 多模态通用模型（fallback） | - |
| `MIMO_POWER_MODEL` | 兼容旧配置 | `mimo-v2.5-pro` |

### Model Routing 规则

1. 如果 `args.model` 显式传入，优先使用 `args.model`
2. 如果 `mode === "vision"` 或 assets 中有 image/video：
   - 优先 `MIMO_POWER_VISION_MODEL`
   - 其次 `MIMO_POWER_MULTIMODAL_MODEL`
   - 如果都没有，返回 `MIMO_VISION_MODEL_MISSING` 错误
3. 如果 `mode === "audio"` 或 assets 中有 audio：
   - 优先 `MIMO_POWER_AUDIO_MODEL`
   - 其次 `MIMO_POWER_MULTIMODAL_MODEL`
   - 如果都没有，返回 `MIMO_AUDIO_MODEL_MISSING` 错误
4. 普通文本任务：
   - 优先 `MIMO_POWER_TEXT_MODEL`
   - 其次 `MIMO_POWER_MODEL`
   - 最后使用默认 `mimo-v2.5-pro`

### 其他配置

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `MIMO_POWER_MAX_COMPLETION_TOKENS` | `8192` | 最大输出 token 数 |
| `MIMO_POWER_TIMEOUT_MS` | `600000` | 请求超时时间（毫秒） |
| `MIMO_POWER_MAX_LOCAL_FILE_BYTES` | `104857600` | 本地文件最大大小（100MB） |
| `MIMO_POWER_TASK_DIR` | `debug/mimo/tasks` | 任务结果保存目录 |
| `MIMO_POWER_ALLOWED_HOSTS` | 空 | 允许的资产主机列表（逗号分隔） |

## 使用示例

### 文本分析

```bash
MIMO_POWER_ENDPOINT_STYLE=chat \
MIMO_POWER_TEXT_MODEL=mimo-v2.5-pro \
mimo_power__analyze(task="总结这篇文章", mode="fast")
```

### 图像分析

```bash
MIMO_POWER_ENDPOINT_STYLE=chat \
MIMO_POWER_VISION_MODEL=mimo-v2.5 \
mimo_power__analyze(
  task="描述这张图片",
  mode="vision",
  assets=[{"type": "image", "url": "https://example.com/image.png"}]
)
```

### 音频分析

```bash
MIMO_POWER_ENDPOINT_STYLE=chat \
MIMO_POWER_AUDIO_MODEL=mimo-v2.5 \
mimo_power__analyze(
  task="转录这段音频",
  mode="audio",
  assets=[{"type": "audio", "url": "https://example.com/audio.mp3"}]
)
```

## 错误处理

| 错误码 | 说明 | 解决方案 |
|--------|------|----------|
| `MIMO_VISION_MODEL_MISSING` | 没有配置视觉模型 | 设置 `MIMO_POWER_VISION_MODEL` 或 `MIMO_POWER_MULTIMODAL_MODEL` |
| `MIMO_AUDIO_MODEL_MISSING` | 没有配置音频模型 | 设置 `MIMO_POWER_AUDIO_MODEL` 或 `MIMO_POWER_MULTIMODAL_MODEL` |
| `MIMO_TOKEN_PLAN_KEY_MISSING` | 缺少 API 密钥 | 设置 `MIMO_TOKEN_PLAN_API_KEY` |
| `MIMO_TOKEN_PLAN_EXPIRED` | Token 已过期 | 更新 `MIMO_TOKEN_PLAN_EXPIRES_AT` |
| `MIMO_REQUEST_FAILED` | API 请求失败 | 检查网络和 API 状态 |
| `URL_BLOCKED` | 资产 URL 被阻止 | 检查 `MIMO_POWER_ALLOWED_HOSTS` 配置 |

## 修改历史

### 2026-05-12

- 新增 `MIMO_POWER_ENDPOINT_STYLE` 配置，支持 `chat` 和 `responses` 两种 endpoint 风格
- 新增 Model Routing 功能，根据任务类型自动选择合适的模型
- 新增环境变量：`MIMO_POWER_TEXT_MODEL`, `MIMO_POWER_VISION_MODEL`, `MIMO_POWER_AUDIO_MODEL`, `MIMO_POWER_MULTIMODAL_MODEL`
- 默认 endpoint 保持为 `/chat/completions`
- 当 vision/audio 任务没有合适模型时，返回明确错误而不是发送给 text model

## 相关文件

- MCP 服务器：`node_bridge/src/mimoPowerMcpServer.mjs`
- 配置文件：`.env.local`
- 任务输出目录：`debug/mimo/tasks/`
