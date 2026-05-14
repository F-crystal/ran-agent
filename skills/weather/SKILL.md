---
name: weather
description: "实时天气查询（当前天气/短期预报）。当用户询问天气、温度、降雨、出行天气时使用。"
---

# Weather (Workspace Override)

## Use When

- 用户询问当前天气、体感温度、降雨概率、今天/明天预报
- 用户需要出行前天气判断

## Rules

- 优先给出简短结论，再补充关键细节（温度/天气现象/风力或降水）
- 涉及“今天/明天/周末”时，使用明确日期表达
- 如果地点不明确，只追问一个问题（例如“你想查哪个城市？”）
- 默认只走 `web_search` 即可完成天气问答；仅在用户明确要求“打开某个具体网址”时才尝试 `web_fetch`
- 不依赖 `exec`/`curl`，避免在 `messaging` 工具配置下失效

## Tool Calls

```javascript
// Current weather
await web_search({ query: "Shanghai weather today temperature precipitation", count: 5 });

// Tomorrow forecast
await web_search({ query: "Shanghai weather tomorrow forecast", count: 5 });

// Optional source verification (only when user explicitly asks to open URL)
await web_fetch({ url: "https://example.com/weather-source" });
```

## Notes

- 不使用 `~` 前缀路径；仅使用绝对路径或工作区相对路径。
