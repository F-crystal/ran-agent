---
name: doc-governance
description: "文档治理：维护 AGENTS.md / CLAUDE.md / openclaw/AGENTS.md / README 等核心文档的口径一致、状态更新、瘦身原则。当用户说'更新文档''文档一致性''瘦身 AGENTS'时使用。"
---

# Doc Governance

## Use When

- 用户说"更新文档""文档一致性""瘦身 AGENTS""文档治理"
- 需要检查 AGENTS.md / CLAUDE.md / openclaw/AGENTS.md 是否与代码实际状态一致
- 需要把 AGENTS.md / CLAUDE.md 中的详细内容拆分到治理文档或 skill
- 需要更新 `Status: CURRENT (YYYY-MM-DD)` 时间戳
- 归档前的文档一致性检查

## Principles

### 0. 铁律：口径一致 + 状态及时

- **所有文件**的口径必须与当前代码状态一致。代码改了，文档必须同步改。
- **所有文件**的状态标注和内容必须及时更新。不能有"代码已变但文档还写着旧内容"的情况。
- 这两条是最高优先级原则，其他原则服从于此。

### 1. 轻 AGENTS/CLAUDE，重治理文档和 skill

AGENTS.md 和 CLAUDE.md 只保留：
- 执行范围和边界约束（Execution Scope, Security）
- 指向治理文档和 skill 的引用（Governance Docs）
- 不可省略的行为规则（Skills-First, Sub-Agent Rule, Live Lookup Rule）

详细实现、配置参数、流程说明等放到：
- `docs/governance/` 下的治理文档（如 `media-pipeline.md`）
- `skills/` 下的 skill（如 `archive-and-push`, `doc-governance`）

### 2. 口径一致

同一事实在以下文件中必须一致：
- `AGENTS.md`（根目录）
- `CLAUDE.md`
- `openclaw/AGENTS.md`
- `README.md` / `README_en.md`
- `openclaw/README.md` / `openclaw/README_en.md`
- `docs/governance/` 下的治理文档

如果一处更新，其他处必须同步。用 `grep` 检查关键词在各文件中的一致性。

### 3. 状态标注

每个文档头部必须有 `Status: CURRENT (YYYY-MM-DD)` 或 `Status: SUPERSEDED`。
- `CURRENT`：文档内容准确反映当前代码状态
- `SUPERSEDED`：文档内容已被更新文档替代

更新代码后，必须同步更新相关文档的状态标注。

### 4. 不重复

- 根 AGENTS.md 和 CLAUDE.md 共享的内容：在两处都保留，但保持一致
- openclaw/AGENTS.md 的内容不应复制到根 AGENTS.md
- 详细内容只写一处（治理文档或 skill），其他文件用引用

### 5. 中英文分离

- `README.md` / `openclaw/README.md`：中文
- `README_en.md` / `openclaw/README_en.md`：英文
- 两份内容口径一致，不混用语言

## Checklist

当修改了媒体管线、MCP 工具、WeChat bridge 等核心组件后：

- [ ] 更新 `docs/governance/media-pipeline.md`（详细流程）
- [ ] 检查 `AGENTS.md` 中的 Media Pipeline 引用是否准确
- [ ] 检查 `CLAUDE.md` 中的 Media Pipeline 引用是否准确
- [ ] 检查 `openclaw/AGENTS.md` 中的 Browser And Media Runtime 描述是否准确
- [ ] 更新 `README.md` 和 `README_en.md`（如果影响用户可见功能）
- [ ] 更新 `openclaw/README.md` 和 `openclaw/README_en.md`（如果影响 MCP 工具清单）
- [ ] 更新所有受影响文档的 `Status: CURRENT (YYYY-MM-DD)` 时间戳
- [ ] 运行 `skills/archive-and-push` 归档

## Commands

```bash
# 检查文档一致性（关键词在各文件中的出现）
grep -rn 'mimo_power\|inboundMessageBuffer\|入站消息聚合' \
  AGENTS.md CLAUDE.md openclaw/AGENTS.md \
  README.md README_en.md openclaw/README.md openclaw/README_en.md \
  docs/governance/media-pipeline.md

# 检查状态标注
grep -rn 'Status:' AGENTS.md CLAUDE.md openclaw/AGENTS.md \
  docs/governance/*.md

# 统计 AGENTS.md / CLAUDE.md 行数（监控瘦身效果）
wc -l AGENTS.md CLAUDE.md openclaw/AGENTS.md
```

## Boundaries

- 只操作仓库内文件。
- 不修改运行时代码（`node_bridge/src/*`, `src/personal_agent/*`）。
- 不修改 `local_archive/`（部署文档由 archive-and-push 管理）。
- 归档使用 `skills/archive-and-push`，不直接 git commit。
