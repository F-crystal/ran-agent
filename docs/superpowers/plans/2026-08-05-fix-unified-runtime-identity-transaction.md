# 修复统一 runtime identity 的迁移与回滚事务

Status: HISTORICAL IMPLEMENTATION PLAN (2026-08-05)

This plan is retained as execution history, not current runtime or deployment
authority. Current facts live in `docs/governance/current_runtime_status.md`.

你是执行者，本文件是唯一任务来源。目标：修正当前“删除 `ran-agent` Linux 身份迁移、保留 O2”差量中的事务漏洞，使稳态只有一个既有非 root runtime identity（生产目标默认 `ubuntu:ubuntu`），同时允许切换期间安全读取旧身份资产、失败时恢复旧快照。禁止部署、提交、推送、删除账号或操作服务器。

## 已证实问题

1. P0：`backup_steward_token` 在切换前按目标 `ubuntu` 校验 token；若线上 token 仍属 `ran-agent`，快照和停服后必然失败。
2. P0：回滚始终按目标身份恢复 token、校验 unit；恢复出的旧 `User=ran-agent` 快照会失败，和“暂留旧账号保证回滚”矛盾。
3. P1：`resolve_runtime_identity` 接受 UID/GID 0；实测 `root:wheel` 可通过，所谓 non-root gate 可退化成 root。
4. P1：原 `/proc/<pid>/status` 有效 UID/GID 门禁被删。现测试把 status 写成 999/999，却仍断言 acceptance 通过。
5. P2：两个 Python CLI 的 `--runtime-group` 固定默认 `ubuntu`，与 shell 的“默认跟随 runtime user”不一致。
6. P2：根目录 `PROGRESS.md`、`BLOCKED.md` 未忽略且内容已过时；文档还提前声称 rollback intact，并删掉了与本任务无关的失败候选事实。

## 第一性原理与硬边界

- “稳态单身份”不等于“迁移事务没有来源身份”。事务必须分别保存 `source identity`、`target identity`；接受后只剩 target，回滚时恢复 source。
- source 必须在停服前从 Node/Ombre 生效 unit 与稳定 MainPID 只读解析，二者须同名、同非零 UID/GID、进程有效 UID/GID 相符；不得信任任意 env 猜测。
- target 默认 `ubuntu:ubuntu`，必须已存在、主组一致、UID/GID 非 0；所有校验在 snapshot/停服/chown/token rotation 前完成。
- 旧 token 用 source 身份备份；切换后新 token 属 target；回滚先从已恢复 unit 解析 source，再把 token 恢复为 source 所有并验证实际进程。旧 `ran-agent` 账号只读使用，绝不创建、修改或删除。
- 保留 O2 API、token rotation/旧 token 拒绝、queue/projection/receipt、服务名与状态布局。禁止改 `node_bridge/src/ombreCompat/**`、Steward schema/patch、O1/O2 业务语义。
- 不恢复旧 verifier 的 `--ensure-account`。优先做一个最小通用 identity/process verifier 供 apply/deploy/accept 复用；不得新增框架或重复三份 `/proc` 解析。

## 执行顺序

1. 先把根目录两个状态文件移动到：
   `local_archive/runtime/task-state/remove-ran-agent-linux-account/{PROGRESS.md,BLOCKED.md}`。后续只更新这两个 ignored 文件；不得 force-add。用 `git check-ignore -v` 证明忽略，用 `git status --short -- PROGRESS.md BLOCKED.md` 证明根目录无残留。
2. 冻结四个红测：旧 owner token→ubuntu 切换并可回滚；旧 `ran-agent` snapshot 恢复；root target 在任何 mutation 前拒绝；unit 名称正确但 `/proc` 有效 UID/GID 错误必须拒绝。测试不得依赖真实新增账号。
3. 用最小改动实现 source/target/rollback identity 生命周期。快照或可信 root-owned transaction metadata 必须保存回滚所需身份；不能从未受信 env 回填。
4. 恢复数值进程门禁：校验 unit User/Group、NSS UID/GID、非 root、MainPID 前后稳定及 `/proc/<pid>/status` effective UID/GID。Linux root/non-root staged gate 都必须覆盖；Darwin 只允许保留既有平台 skip。
5. 让 Python group 缺省跟随传入 user；同步必要测试。文档只描述已由测试证明的目标/未知生产事实，恢复本任务误删的历史事实；账号删除仍写成独立授权后的未来步骤。
6. Ponytail 收口：优先净删；无账号管理命令；没有“为了以后”的抽象。`AGENTS.md` 是领导既存 diff，必须原样。

## 验收

使用 `AUDIT_NODE=/Users/fengran/.nvm/versions/node/v22.22.2/bin/node`、`AUDIT_PYTHON=/Users/fengran/anaconda3/bin/python3`：

```bash
"$AUDIT_PYTHON" tests/test_ombre_steward_token.py
"$AUDIT_NODE" --test node_bridge/tests/hermesReleaseScript.test.mjs node_bridge/tests/ombreCompatProductionWiring.test.mjs
"$AUDIT_NODE" --test node_bridge/tests/ombreCompat*.test.mjs
bash -n scripts/*.sh
git diff --check
git check-ignore -v local_archive/runtime/task-state/remove-ran-agent-linux-account/PROGRESS.md local_archive/runtime/task-state/remove-ran-agent-linux-account/BLOCKED.md
rg -n 'useradd|groupadd|userdel|--ensure-account' scripts
rg -n 'User=ran-agent|Group=ran-agent' scripts
"$AUDIT_PYTHON" scripts/workflow_guard.py verify --label unified-runtime-identity-transaction -- "$AUDIT_NODE" --test node_bridge/tests/hermesReleaseScript.test.mjs node_bridge/tests/ombreCompatProductionWiring.test.mjs
```

硬指标：四个红测转绿；root 目标零副作用拒绝；旧身份 rollback fixture 完整恢复 token ownership、服务和进程身份；O2 仍不少于 212 pass/仅 1 个既有 real-process skip；两条禁止模式检索零命中；`AGENTS.md` 与 O2 源码 diff 不增。完成后在 ignored `PROGRESS.md` 贴命令与实际结果；未完成项写 ignored `BLOCKED.md`。三次同因失败即停止，禁止用删测、增 skip、放宽 owner/mode 或改文档掩盖。
