# 撤销 `ran-agent` Linux 身份、保留 O2 功能任务书

Status: HISTORICAL IMPLEMENTATION PLAN (2026-08-05)

This plan is retained as execution history, not current runtime or deployment
authority. Current facts live in `docs/governance/current_runtime_status.md`.

你是执行者，本文件是唯一任务来源；拿不准的写入 `BLOCKED.md` 后继续。换会话先读 `PROGRESS.md`，每完成一项立即更新。目标是让 Node、Ombre、Hermes 恢复同一个既有运行身份（生产默认 `ubuntu`），删除未授权账号创建与双身份耦合，完整保留 O2。冲突时按“数据与回滚安全 > O2 行为 > 删除复杂度 > 速度”裁决。“只允许/禁止”是硬规则；建议可替换但须记录理由。

## 我替领导拍的板

- 猜的：本轮只改仓库并本地验证，不部署、不访问服务器、不删账号；代价是生产切换另需授权。
- 猜的：复用 `RUNTIME_USER/RUNTIME_GROUP`，默认 `ubuntu`；不引入 `DynamicUser`、用户级 systemd、容器、ACL、sysusers/tmpfiles 或新存储布局。
- 猜的：保留 root + 单一服务身份的可移植发布 gate；删除的是 `ubuntu/ran-agent` 双服务身份，不删除项目要求的 root/non-root 验证。
- 猜的：账号删除另立任务；旧回滚点退役前让账号闲置。禁用 `userdel -r`/`--remove-home`，因其 home 是 `/opt/ran_agent`。

## 界限

只允许改：`scripts/` 中 apply/deploy/accept/release-gate、Ombre token/runtime/real-process verifier、Ombre 诊断及旧身份 verifier；`tests/test_ombre_steward_token.py`；`node_bridge/tests/{hermesReleaseScript,ombreCompatProductionWiring}.test.mjs`；README/README_en、Hermes README 双语；`docs/governance/{doc_status,current_runtime_status,hermes_release_deployment,server_runtime_commands,constraints,hermes_release_bootstrap.v1.sha256}`；以及 `PROGRESS.md`、`BLOCKED.md`。`AGENTS.md` 有领导既存修改，只读且交付时 diff 必须原样。`node_bridge/src/ombreCompat/**`、Steward patch/schema、其他 O2 测试只读。

不得误删：项目/服务名 `ran-agent-*`、`RAN_AGENT_*`/`.ran_agent_state`、`/internal/ran-agent/steward/v1`、`X-Ran-Agent-Steward-Token` 和 Steward 业务角色。禁止新依赖/身份抽象、手改 systemd、生产命令、commit/push/deploy。不得放宽 gate、skip、mock 身份边界、删测试或加 `|| true`。

## 现状与任务 0

2026-08-04 实测 HEAD `88078e8`；除领导的 `AGENTS.md` 外工作树干净。`a978444` 新增账号创建；其父版已用默认 `ubuntu` 的 `RUNTIME_USER/GROUP`。专用身份模式命中 32 处；Python 9 测试通过（Darwin 1 skip），release/O2 wiring 86+5 个测试退出 0，O2 全组 213 个测试为 212 pass/1 real-process skip。生产账号状态是 `SERVER_UNKNOWN`：snapshot 在 `--ensure-account` 前，rollback 不含 `userdel`。

先运行 `git status --short`、`git diff -- AGENTS.md` 和身份模式 `rg`，把目标/顺序/最大风险写进 ≤10 行的 `PROGRESS.md`。HEAD 或既存改动不符就将证据置于 `BLOCKED.md` 顶部，只做不受影响项。

## 任务 1：用测试冻结“一个服务身份、O2 不变”

先把固定 `ran-agent`/useradd 合同反转为：所有服务复用 runtime identity、部署源码无账号创建、token 仍为同一运行 UID/GID 的 `0600` 文件。测试临时 fixture 注入 `User=ran-agent`，先贴失败输出；实现后贴通过输出。保留 Git-less、read-only、`env -i`、root/non-root、真实 `0600/0700` 修复、token rotation/rollback/旧 token 拒绝与全部 O2 行为；非 root gate 改为 `ubuntu`，provider 检查不得因身份跳过。

## 任务 2：删除身份迁移，复用既有 runtime

删除 `groupadd/useradd/--ensure-account`、固定 `STEWARD_RUNTIME_USER/GROUP`、专用 NSS/home/shell/`/proc/status` verifier 与跨 UID runner；Node/Ombre unit、drop-in、O2 state、Ombre home/source/venv、`vault/ombre`、token owner、真实进程和 gate 统一走既有 runtime identity。旧 `99-ombre-steward-identity.conf` 必须被覆写/清除其 User/Group，但其中 O2 env 必须保留。所有权迁移只复用现有 release 的 snapshot→quiesce→apply→rollback 事务，递归覆盖嵌套 state；不得新增迁移框架。保留 `/proc/.../environ` 的 env/PID 漂移检查、Steward API auth/source identity、queue/projection/receipt/compatibility_delete。

## 任务 3：同步真实口径并收尾

删除“owner-authorized identity wiring”；标明 O2 保留、Linux 身份迁移撤销、生产账号未知。删掉 current 文档中为废弃双身份辩护的长史（Git 已保留），同步 README 双语并重算 bootstrap digest。未来顺序：ubuntu cutover/acceptance；闲置账号兼容旧 rollback；待旧身份 rollback 权威退役、无进程/文件残留且已有 ubuntu 回滚点后，再单独请求不带 `-r` 的删除授权。

## 规矩

Ponytail：优先复用父版/现有 runtime helper，预计净删约 250 行；若新增层或总行数上升，写 `BLOCKED.md` 解释。三次同一验收失败就换项；结果比基线差即回滚该项并如实记录。不得改坏 `AGENTS.md`、O2 源码、测试数或 skip 基线。

## 完成条件

用 `AUDIT_NODE=/Users/fengran/.nvm/versions/node/v22.22.2/bin/node`、`AUDIT_PYTHON=/Users/fengran/anaconda3/bin/python3` 运行：`"$AUDIT_PYTHON" tests/test_ombre_steward_token.py`；`"$AUDIT_NODE" --test node_bridge/tests/hermesReleaseScript.test.mjs node_bridge/tests/ombreCompatProductionWiring.test.mjs`；`"$AUDIT_NODE" --test node_bridge/tests/ombreCompat*.test.mjs`；对改动 shell 跑 `bash -n`；再跑 `git diff --check` 与 `"$AUDIT_PYTHON" scripts/workflow_guard.py verify --label ubuntu-runtime-identity -- "$AUDIT_PYTHON" tests/test_ombre_steward_token.py`。硬指标：部署源码对 `useradd|groupadd|User=ran-agent|Group=ran-agent|--user ran-agent|getpwnam\("ran-agent"\)|--ensure-account` 零命中，O2 213 测试不少于 212 pass/仅 1 个既有 real-process skip；且生产副作用为 0、`AGENTS.md` 与 O2 源码 diff 为 0。每条必须贴实际输出，红→绿证据也要贴；只说完成不算。`BLOCKED.md` 随交付提交，空则写“无”。完成全部，或最多三轮后停止并如实交付。
