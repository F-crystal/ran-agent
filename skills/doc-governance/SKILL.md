---
name: doc-governance
description: "文档治理：维护 AGENTS.md / CLAUDE.md / openclaw/AGENTS.md / README / docs/governance/ 等核心文档的口径一致、状态更新、瘦身原则。当用户说'更新文档''文档一致性''瘦身 AGENTS''治理文档清理'时使用。"
---

# Doc Governance

Status: CURRENT (2026-05-10)

## Use When

- 用户说"更新文档""文档一致性""瘦身 AGENTS""文档治理""治理文档清理"
- 需要检查 AGENTS.md / CLAUDE.md / openclaw/AGENTS.md / docs/governance/ 是否与代码实际状态一致
- 需要把 AGENTS.md / CLAUDE.md 中的详细内容拆分到治理文档或 skill
- 需要清理 docs/governance/ 下的历史快照或过期文档
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

- 根 AGENTS.md 和 CLAUDE.md 共享的内容：在两处都保持一致
- openclaw/AGENTS.md 的内容不应复制到根 AGENTS.md
- 详细内容只写一处（治理文档或 skill），其他文件用引用
- `docs/governance/` 内部也不重复：如果两个文档说同一件事，合并或删除较旧的那个

### 5. 中英文分离

- `README.md` / `openclaw/README.md`：中文
- `README_en.md` / `openclaw/README_en.md`：英文
- `docs/governance/` 内部统一使用英文（与代码和 AGENTS.md 一致）
- 两份 README 口径一致，不混用语言

### 6. docs/governance/ 管理规范

治理文档是公开发布面的一部分，不是归档：
- 历史快照（如 `*_2026-04-13.md`）只保留有参考价值的，其余删除
- 已完成的 checklist、一次性报告、过期的诊断记录应及时清理
- 保留的文档必须有准确的 `Status: CURRENT (YYYY-MM-DD)` 标注
- `current_runtime_status.md` 是详细运行时状态参考，控制在 ~150 行以内
- 每个治理文档应聚焦单一主题，不要把多个不相关的内容塞进一个文件
- `doc_status.md` 必须列出所有公开源文档，且与实际文件列表一致

## Checklist

当修改了核心组件（媒体管线、MCP 工具、WeChat bridge、session 配置等）后：

- [ ] 更新对应的 `docs/governance/` 文档（详细流程或状态）
- [ ] 检查 `AGENTS.md` 中的引用是否准确
- [ ] 检查 `CLAUDE.md` 中的引用是否准确
- [ ] 检查 `openclaw/AGENTS.md` 中的描述是否准确
- [ ] 更新 `README.md` 和 `README_en.md`（如果影响用户可见功能）
- [ ] 更新 `openclaw/README.md` 和 `openclaw/README_en.md`（如果影响 MCP 工具清单）
- [ ] 更新所有受影响文档的 `Status: CURRENT (YYYY-MM-DD)` 时间戳
- [ ] 检查 `docs/governance/doc_status.md` 的文件列表是否与实际一致
- [ ] 检查 `docs/governance/skills.md` 的 skill 列表是否与 `skills/` 目录一致
- [ ] 运行 `skills/archive-and-push` 归档

## Commands

```bash
# 检查文档一致性（关键词在各文件中的出现）
grep -rn 'KEYWORD' \
  AGENTS.md CLAUDE.md openclaw/AGENTS.md \
  README.md README_en.md openclaw/README.md openclaw/README_en.md \
  docs/governance/

# 检查状态标注
grep -rn 'Status:' AGENTS.md CLAUDE.md openclaw/AGENTS.md \
  docs/governance/*.md skills/*/SKILL.md

# 统计核心文档行数（监控瘦身效果）
wc -l AGENTS.md CLAUDE.md openclaw/AGENTS.md docs/governance/*.md

# 检查 docs/governance/ 文件列表是否与 doc_status.md 一致
ls docs/governance/*.md | sort
grep 'docs/governance/' docs/governance/doc_status.md

# 检查 skills/ 列表是否与 skills.md 一致
ls -d skills/*/SKILL.md | sed 's|skills/\(.*\)/SKILL.md|\1|' | sort
grep 'skills/' docs/governance/skills.md

# 检查是否有过期的历史快照未清理
find docs/governance/ -name '*2026-04*' -type f

# 检查 docs/governance/ 总行数（目标 < 400）
wc -l docs/governance/*.md | tail -1
```

## Boundaries

- 只操作仓库内文档文件（`*.md`）。
- 不修改运行时代码（`node_bridge/src/*`, `src/personal_agent/*`）。
- 不修改 `local_archive/`（部署文档由 archive-and-push 管理）。
- 归档使用 `skills/archive-and-push`，不直接 git commit。
- `docs/governance/` 内部的删除和合并需要确认没有其他文件引用被删内容。
