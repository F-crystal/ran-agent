# 现状联通性报告（主链）

Status: HISTORICAL SNAPSHOT. Superseded by `docs/governance/current_runtime_status.md` and `openclaw/openclaw.personal-system.json`; do not use model/provider values in this file as current runtime truth.

日期：2026-04-14
范围：按 `docs/governance` 当前真相验证关键链路契约

## 基准文档

- `AGENTS.md`
- `docs/governance/doc_status.md`
- `docs/governance/current_runtime_status.md`
- `docs/governance/constraints.md`

## 验证项与结果

### 1) OpenClaw 配置契约

历史目标契约：
- 前台单一说话者 OpenClaw，当时主模型链仍按 Claude CLI primary 与 fallback 链路描述；当前合同已改为 `docs/governance/current_runtime_status.md` 中的 `provider=claude_code` + bare model。
- 启动入口 `./start_openclaw.sh`
- Claude 主链通过本机 Claude Code CLI 与 `~/.claude/settings.json` 运行；Qwen 只保留给后台知识维护路径使用。

验证方式：
- 配置结构检查：`jq` 读取 `openclaw/openclaw.personal-system.json`
- 启动脚本检查：`start_openclaw.sh`
- 环境注入检查：`source .env.local` 后查看 key 变量（脱敏）

结果：`已通（配置层，历史快照）`
- 当时 `agents.defaults.model.primary` 使用 Claude CLI primary。
- 当时 `agents.list[0].model.primary` 使用 Claude CLI primary。
- `agents.defaults.model.fallbacks = []`
- `agents.defaults.cliBackends.claude-cli.command` 指向本机 `claude`
- `start_openclaw.sh` 为标准入口，并允许通过本机 `claude` / `codex` CLI 可用性启动主链与第一层 fallback；Qwen env 仅用于后台知识维护。

备注：
- 已做本地 gateway chat completion smoke：
  - 网关启动日志显示当时的 Claude CLI primary model。
  - 本地 `POST /v1/chat/completions` 成功返回 `OK`
  - 当 `claude-cli` 缺少第三方 provider env 时，运行时会自动降级到 `codex/gpt-5.4-mini`
- 这仍不等同于完整线上稳定性证明，但已覆盖本地真实主链与 fallback 行为。

### 2) node_bridge 测试契约

目标契约：
- Node bridge 走 OpenClaw 网关 `/v1/chat/completions`
- 保持后端 ingest 可选写入

验证方式：
- 运行：`npm --prefix node_bridge test`
- 代码路径检索：`node_bridge/src` 中 `/v1/chat/completions` 与 `/chat` 使用情况

结果：`已通`
- 测试总计 `36`，通过 `36`，失败 `0`
- 桥接客户端命中 `node_bridge/src/openclawGatewayClient.mjs` 的 `/v1/chat/completions`
- 未发现 node_bridge 直接调用 Python `/chat` 的主路径实现

### 3) Python backend 接口契约

目标契约：
- `GET /health` 返回 200
- `POST /chat` 返回 410（前台路径退役）
- `GET /tools/knowledge/state` 可用
- `POST /tools/knowledge/run` 可触发 knowledge maintenance

优先验证尝试：
- `PYTHONPATH=src pytest -q tests/test_http_server.py`
- `PYTHONPATH=src pytest -q tests/test_knowledge_agent.py`

结果：`已通（测试与实现一致）`
- `tests/test_http_server.py` 当前已对齐 `BackendHttpController` 契约
- 实测结果：`8 passed`
- `tests/test_knowledge_agent.py` 实测结果：`2 passed`

可执行替代验证（已执行）：
- 以 `./start_python.sh` 启动后端，实测接口：
  - `GET /health` -> `200`, body `{"status": "ok"}`
  - `POST /chat` -> `410`, body 含 `frontend /chat path retired`
  - `GET /tools/knowledge/state` -> `200`, 返回状态 JSON（含 `pending_knowledge_maintenance` 等字段）
  - `POST /tools/knowledge/run` 路由已由单测覆盖，返回结构化维护结果（`plan`/`apply`/`auto`，action/status/inbox 前后/pending 等字段）

替代验证结果：`已通（运行时契约）`

### 4) Task 1 端到端联调 smoke

目标契约：
- 可本地复现启动 Python backend
- 可本地复现启动/复用 OpenClaw gateway
- 可调用 `/tools/knowledge/state` 与 `/tools/knowledge/run`
- 可验证 `openclaw/openclaw.personal-system.json` 的 heartbeat 配置
- 可验证 `HEARTBEAT.md` 位于仓库根，且 OpenClaw 读取过它

验证方式：
- 脚本：`./scripts/connectivity_smoke.sh`
- 直接证据补充：
  - `npx openclaw health --json --timeout 10000`
  - `npx openclaw system event --text "connectivity smoke heartbeat" --mode now --expect-final --json --timeout 30000`
  - `rg -n 'HEARTBEAT.md|HEARTBEAT_OK|heartbeat' .openclaw_state/agents/personal-system/sessions -g '*.jsonl'`

结果：`已通`
- `scripts/connectivity_smoke.sh` 成功完成本地联调闭环。
- `start_python.sh` 与 `start_openclaw.sh` 已显式把本地 Qwen Code Node bin 放到 `PATH` 前面，避免 bash login shell 回落到系统 `node v16.17.0`，从而触发 `node:readline/promises` 解析错误。
- `GET /health` 返回 `{"status": "ok"}`。
- `POST /tools/knowledge/run` 依次以 `action=plan`、`action=apply`、`action=auto` 成功执行，三次请求都返回 `200`。
- `knowledge.run.plan` 返回 `status=ok`、`processed_inbox_count=0`、`pending_knowledge_maintenance=true`，并明确建议继续进入 `apply`。
- `knowledge.run.apply` 返回 `status=ok`、`processed_inbox_count=0`、`pending_knowledge_maintenance=true`，输出中出现 `run_shell_command` 与 `write_file` 的 non-interactive approval 警告。
- `knowledge.run.auto` 返回的 action 实际解析为 `apply`，同样是 `status=ok`、`processed_inbox_count=0`、`pending_knowledge_maintenance=true`，且出现相同的 non-interactive approval 警告。
- `npx openclaw health --json` 在项目配置下返回 `ok: true`，并读到当前 heartbeat 配置：
  - `every = 20m`
  - `activeHours = 08:30-23:30 (Asia/Shanghai)`
  - `tools.allow` 非空，包含 `read` / `web_search` / `web_fetch` / `session_status`
- `HEARTBEAT.md` 文件存在于仓库根。
- `HEARTBEAT.md` 读取证据来自 `.openclaw_state/agents/personal-system/sessions/8285a0c0-835c-44ff-a035-e9d1be323e17.jsonl`，其中可见 `Read HEARTBEAT.md`、`HEARTBEAT_OK`、以及 heartbeat 会话上下文。
- `npx openclaw system heartbeat last` 在这版 CLI 上返回 `null`，因此本次 heartbeat 证据以 session JSONL 日志为准。
- `npx openclaw system event --text "connectivity smoke heartbeat" --mode now --expect-final --json --timeout 30000` 返回 `{"ok": true}`。

联调脚本摘要：
- `backend.health: {"status": "ok"}`
- `knowledge.run.plan: http=200 action=plan status=ok processed=0 pending=true`
- `knowledge.run.apply: http=200 action=apply status=ok processed=0 pending=true`
- `knowledge.run.auto: http=200 action=apply status=ok processed=0 pending=true`
- `openclaw.health: ok=true`
- `heartbeat.config` 已确认与仓库配置一致
- `heartbeat.file` 已确认是仓库根 `HEARTBEAT.md`

## 已通 / 未通汇总

已通：
- OpenClaw 配置契约（配置层）
- node_bridge 测试契约
- Python backend 测试契约（`tests/test_http_server.py`）
- knowledge 维护单测契约（`tests/test_knowledge_agent.py`）
- Python 运行时接口契约（通过替代联调验证）
- Task 1 端到端联调 smoke（`scripts/connectivity_smoke.sh`）

未通：
- 无硬阻塞项（截至 2026-04-14 本次复核）

## 风险清单

1. OpenClaw 本地网关健康已覆盖，但完整在线聊天上游仍是单独风险面
- 现状：本次 smoke 已覆盖本地 gateway 启动、health 探活和 heartbeat 配置读取。
- 仍需关注：真实聊天 turn 的上游模型连通性、鉴权和网络抖动。

2. 知识维护 backlog 仍然存在
- 现状：`/tools/knowledge/state` 仍可返回 `pending_knowledge_maintenance=true`，本次 smoke 中 `inbox_count=14`，`plan` / `apply` / `auto` 都返回 `200`，但 `processed_inbox_count=0`，所以 backlog 未清掉。
- 现状：`apply` 与 `auto` 的输出里出现 `run_shell_command` / `write_file` 的 non-interactive approval 警告，说明当前运行方式下 Qwen Code 没拿到继续执行的批准。
- 路径：继续通过 `POST /tools/knowledge/run` 触发 `plan` / `apply` / `auto` 维护，但要用能完成 tool approval 的运行方式，或给出相应的交互式批准。
- 风险：如果仍以 non-interactive 方式跑 `apply` / `auto`，知识维护 backlog 会继续保留，不应把 `status=ok` 误读成“已清空”。

## 2026-04-15 补充运行时证据

- 额外尝试：在当前 sandbox 中直接启动 `openclaw gateway run`，并用一个不带 `tools` 的 `/v1/chat/completions` 任务提示做 smoke。
- 结果：运行时 `net.Server.listen()` 对 `127.0.0.1` 和 `0.0.0.0` 都返回 `EPERM`，网关无法进入监听状态。
- 结论：本次没有拿到 native todo 插件调用的可验证证据，也没有观察到新的 todo 持久化结果。
