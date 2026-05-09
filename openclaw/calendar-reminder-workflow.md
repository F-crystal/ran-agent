# 飞书日程创建流程（含 30 分钟提醒）

## 背景
`lark-cli calendar +create` 命令不支持直接设置提醒时间（reminders 字段），默认提醒是提前 5 分钟。用户要求所有日程默认提前 30 分钟提醒。

## 完整流程

### 步骤 1：创建日程
```bash
lark-cli calendar +create --summary "日程标题" --start "2026-05-01T10:10:00+08:00" --end "2026-05-01T18:10:00+08:00" --description "地点/备注"
```
记录返回的 `event_id`

### 步骤 2：设置 30 分钟提醒（必须执行！）
```bash
lark-cli api PATCH "/open-apis/calendar/v4/calendars/{calendar_id}/events/{event_id}" --data '{"reminders":[{"minutes":30}]}'
```

将 `{calendar_id}` 替换为你的主日历 ID，`{event_id}` 替换为步骤 1 返回的 event_id

## 主日历 ID
**（敏感信息，不在此文件中存储）**
- 请在执行时从 `lark-cli calendar list` 获取
- 或从飞书网页版日历设置中查看

## 检查清单
创建日程后，确认：
- [ ] 已执行步骤 2 设置提醒
- [ ] 提醒时间为 30 分钟
- [ ] 飞书 App 中验证提醒已生效

## 自动化建议
未来可以考虑：
- 创建 wrapper 脚本封装这两步
- 或在 SOUL.md 中添加强制检查点（SOUL.md 不提交到 GitHub）

---
最后更新：2026-04-30
