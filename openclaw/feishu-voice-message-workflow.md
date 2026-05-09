# 飞书语音消息发送流程

## 背景
飞书 CLI 支持发送语音消息（`--audio` 参数），但需要：
1. 本地有音频文件（OPUS 格式，单声道，16kHz 采样率）
2. 当前认证用户有 `im:resource` 权限

AI 本身没有 TTS（文本转语音）能力，需要借助外部 TTS 服务生成音频文件。

## 完整流程

### 步骤 0：环境准备（首次执行）
安装 TTS 工具（edge-tts，Microsoft Edge 的免费 TTS，无需 API key）：
```bash
pip3 install edge-tts --break-system-packages
```

确认 ffmpeg 已安装（用于格式转换）：
```bash
which ffmpeg
```

### 步骤 1：生成 TTS 音频（MP3 格式）
```bash
edge-tts --text "请吃晚饭" --voice zh-CN-XiaoxiaoNeural --write-media /tmp/message.mp3
```

可用声音选项：
- `zh-CN-XiaoxiaoNeural` - 女声"晓晓"（推荐）
- `zh-CN-YunjianNeural` - 男声"云健"
- `zh-CN-XiaoyiNeural` - 女声"晓伊"

### 步骤 2：转换为 OPUS 格式
飞书语音消息要求 OPUS 格式，单声道，16kHz 采样率：
```bash
ffmpeg -i /tmp/message.mp3 -acodec libopus -ac 1 -ar 16000 /tmp/message.opus -y
```

### 步骤 3：获取用户飞书 ID
```bash
lark-cli auth status
```
从输出中获取 userOpenId

或发送到群聊，获取 chat_id：
```bash
lark-cli im +chat-search --keyword "群聊名称"
```

### 步骤 4：发送语音消息
切换到音频文件所在目录：
```bash
cd /tmp
lark-cli im +messagesSend --user-id "<your-user-id>" --audio "./message.opus"
```

或发送到群聊：
```bash
cd /tmp
lark-cli im +messagesSend --chat-id "<your-chat-id>" --audio "./message.opus"
```

## 权限要求
当前认证用户需要以下权限之一：
- `im:resource`（推荐，已足够）
- `im:resource:upload`（上传文件的完整权限）

检查权限：
```bash
lark-cli auth check --scope "im:resource"
```

## 检查清单
发送前确认：
- [ ] 音频文件已生成（OPUS 格式）
- [ ] 已获取正确的 user_id 或 chat_id
- [ ] 权限检查通过

---
最后更新：2026-05-09
