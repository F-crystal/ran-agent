# 2026-05-15 Final Settled AI周报 Format

This is the concrete output format confirmed by 陛下. When producing a weekly AI digest for WeChat bridge, match this exactly.

## Structure

```
📦 模型发布/更新（{N} 条）

• **{Title}** — {Source}（{time}）
  {1-line summary, only for top 3 items}
• **{Title}** — {Source}（{time}）

📊 行业动态（{N} 条）
...
📱 产品发布/更新（{N} 条）
...
📄 论文研究（{N} 条）
...
💡 技巧与观点（{N} 条）
...

🔗 原文链接（精选）
• {title snippet} → {url}
• {title snippet} → {url}
  … 共 {N} 条，全部原文见 aihot.virxact.com
```

## Concrete Example (from 05/15 actual output)

```
📦 模型发布/更新（5 条）

• **inclusionAI/ARGenSeg-8B** — 蚂蚁 inclusionAI：HuggingFace 新模型（今天）
  包容性AI团队发布ARGenSeg-8B，主打开源和开放科学，推动技术民主化。
• **Granite Embedding Multilingual R2** — Hugging Face（今天）
  IBM 开源多语言嵌入模型，32K 上下文 + Apache 2.0，定位企业级检索场景。
• **SenseNova U1 技术报告发布** — 商汤（今天）
  李沐团队发布 MoE 架构模型并开放权重，意在推动 AI 透明化。
• **inclusionAI/Ring-2.6-1T** — 蚂蚁 inclusionAI（昨天）
• **Kimi K2.6 登顶金融智能体基准榜首** — Kimi（昨天）
```

## Key Rules Observed

- Section order: models → industry → products → papers → tips
- Exactly top 3 per section get summary; items 4+ are title+source+time only
- Summary: ~80-100 chars, real takeaway sentence, plain text, indented 2 spaces
- Time on EVERY item: `（今天）` / `（昨天）` / `（M/D）`
- Time is relative to publish time, not current time
- No numbering globally
- Emoji section headers with count in `（）`
- URL block at very end, title snippet → full URL, max 12 shown
