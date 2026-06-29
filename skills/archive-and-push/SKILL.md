---
name: archive-and-push
description: "当用户说“归档”时使用：运行基线测试、检查敏感文件、初始化/提交 git、可选 dry-run、推送到 origin main，并在 local_archive/docs/ 生成本地归档记录。"
---

# Archive And Push

## Use When

- 用户说“归档”“把这轮存档”“准备推送归档”
- 需要把当前工作整理成可追溯提交并写本地归档记录
- 需要写部署记录或发布记录；这类记录默认放 `local_archive/docs/`，不要放进 public docs tree

## Checklist

- [ ] 运行基线测试
  - `PYTHONPATH=src pytest -q tests/test_http_server.py tests/test_knowledge_agent.py tests/test_config.py`
  - `npm --prefix node_bridge test`
- [ ] 先做 dry-run，确认敏感路径不会进入提交
  - `./scripts/archive_and_push.sh --dry-run --skip-tests`
- [ ] 检查输出摘要中的 `sensitive_present`、`stage_candidates`、`archive_record`
- [ ] 确认 `archive_record` 在 `local_archive/docs/governance/archive/` 下
- [ ] 如果仓库还没有初始化，允许脚本执行 `git init` 并切到 `main`
- [ ] 准备正式归档时执行 push 路径
  - `./scripts/archive_and_push.sh --push`
- [ ] 如需指定或修正远程，补上 SSH 或 HTTPS remote URL；脚本会对齐本地 `origin`
  - `./scripts/archive_and_push.sh --push --remote-url <git-url>`
- [ ] 如果工作区有其他人的并发改动，用 `--path` 精确归档本轮文件
  - `./scripts/archive_and_push.sh --push --path <file> --path <file>`

## Rules

- 不要把 `.env.local`、`.ran_agent_state/`、`data/`、`logs/`、`debug/`、`state/`、`.npm/`、`.pytest_cache/`、`.venv/`、`node_modules/`、`__pycache__/`、`*.pyc` 纳入提交。
- 不要把 `vault/.obsidian/workspace.json`、`vault/.qwen/settings.json`、`vault/.qwen/settings.json.orig` 纳入提交；公开树只保留 `.example.json`。
- 不要把 `local_archive/` 纳入提交。
- 不要在 public tree 新增 `docs/deployment/` 或 `docs/governance/archive/`；部署文档写到 `local_archive/docs/deployment/`，归档记录写到 `local_archive/docs/governance/archive/`。
- 如果 `origin` 不存在且没有提供 remote URL，停止并提示用户先配置远程。
- `--remote-url` 可用 SSH 或 HTTPS；如果 `origin` 已存在但不同，脚本会先 `remote set-url` 对齐。
- GitHub HTTPS/SSH 任一路径 push 失败时，脚本会推导另一种 URL、更新本地 `origin`、重试；重试成功后保留可工作的 URL。
- 脚本正式归档前会清空 index 并重新 stage。未传 `--path` 时 stage 允许范围内的全量工作区；传 `--path` 时只 stage 指定路径。
- 如果没有变更可提交，保留 dry-run 结果并报告 `nothing to commit`。
- 实际 push 只在用户准备好发布时执行；dry-run 只做预检。

## Commands

```bash
# Preflight
./scripts/archive_and_push.sh --dry-run --skip-tests

# Final archive
./scripts/archive_and_push.sh --push

# Final archive with explicit remote
./scripts/archive_and_push.sh --push --remote-url git@github.com:owner/repo.git
```

## Outputs

- 标准输出摘要必须包含：
  - `root`
  - `mode`
  - `tests`
  - `sensitive_present`
  - `stage_candidates`
  - `commit`
  - `push`
  - `archive_record`
- 默认归档记录路径：
  - `local_archive/docs/governance/archive/YYYY-MM-DD-archive-and-push.md`
- 默认部署文档路径：
  - `local_archive/docs/deployment/YYYY-MM-DD-<topic>.md`

## Boundaries

- 只操作仓库内文件。
- 不修改 `node_bridge/src/*` 与 `src/personal_agent/*` 之外的运行时代码。
- 不执行真实 push 作为默认动作。
