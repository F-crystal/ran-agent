---
name: archive-and-push
description: "当用户要求归档、提交、合并 main 或推送时使用：由 scripts/archive_and_push.sh 执行可恢复的本地事务，并在 local_archive/ 写入日志、journal 与归档记录。"
---

# Archive And Push

Status: CURRENT (2026-07-18)

## Use

- 用户要求归档、提交、推送或同步 GitHub 时，使用脚本作为唯一 Git 事务入口。
- 不要手工 checkout、merge 或 push 来绕过脚本，除非脚本已经报告不可恢复状态且用户明确授权。
- `main` 已推送到远端不等于生产已部署；部署必须走独立、明确授权的流程。

## Normal operation

```bash
./scripts/archive_and_push.sh --push
```

默认归档名支持同一天重复执行：首个事务使用日期名，后续事务保留旧记录并自动追加 transaction ID。操作者不需要为了日常多次提交手工传 `--record`。若事务停在 `archive/running`、`archive/failed` 或 `archive/interrupted`，使用同一个 `--resume <transaction-id>`；脚本必须先验证已推送提交与本地、远端引用，并且只能在验证现有记录不属于该事务后选择事务专属路径，不得覆盖、移动或删除旧记录。

事务互斥使用 macOS/Linux 内核文件锁；最后一个继承同一 lock FD 的进程退出后，内核自动释放锁，锁文件中的旧 PID 仅供诊断，不得要求操作者手工删除“stale lock”。脚本不信任环境 marker：进入事务前必须验证继承 FD 与 owner-only regular lock inode 一致且实际持锁。并发第二个调用必须在创建 journal、选择 archive path 或执行 Git 操作前失败。

Python 解析顺序是显式 `ARCHIVE_PYTHON_BIN`、仓库 `.venv/bin/python`、最后才是 `PATH` 中的 `python3`；执行真实事务前必须通过 Python 版本门禁。不要让旧系统 Python 在运行中途用环境异常替代受控失败。

正式 archive record 必须留在 canonical `local_archive` 目录内，以标准库 hard-link 原子 no-replace 方式发布；目标已存在时只允许验证同一事务记录，不得覆盖。跨文件系统发布必须 fail-closed。

脚本会持久化三类不同用途的本地记录：

- `local_archive/docs/governance/archive/*.md` 是供维护者阅读的正式 Markdown archive record；
- `local_archive/runtime/archive-and-push/<transaction-id>/transaction.json` 是机器 resume journal；
- 同一事务目录的 `validation-record.json` 是可校验的 validation evidence。

它们不能互相替代。测试输出中断或调用通道丢失时，不要猜测测试是否完成，也不要盲目重跑。

## Existing trusted validation

仅当操作者已持有脚本生成的、同一仓库真实路径、同一 HEAD、干净工作树且校验通过的记录时，才使用：

```bash
./scripts/archive_and_push.sh --push --reuse-validation /absolute/path/to/validation-record.json
```

`--reuse-validation` 会拒绝不匹配的路径、HEAD、工作树、checksum 或未通过的基线结果。

## Interrupted or failed transaction

1. 先读取 `local_archive/runtime/archive-and-push/<transaction-id>/transaction.json` 和对应日志；reused validation 必须以 journal 中已持久化的 provenance 为准。
2. 仅在 journal 的 phase/status 表明可安全恢复时执行：

   ```bash
   ./scripts/archive_and_push.sh --resume <transaction-id>
   ```

3. 若 journal、当前 Git 状态或 `origin/main` 不一致，停止并报告；不要 reset、rebase、force push 或手工 merge/push。

## Target branch advancement and multiple worktrees

merge 阶段从不在 source worktree checkout `main`。脚本先检查 ancestry：`main` 不是 feature 的 ancestor 时，在任何 checkout/merge mutation 之前记录 `merge/failed` + failure code 64（受控分叉失败，供 divergence recovery 使用）。线性情况下：

- 没有任何 worktree 持有 `main` 时，用 `update-ref` 原子推进 `refs/heads/main`，source worktree 停留在原 feature branch；
- `main` 由同一 repository 的另一个 worktree 持有时，脚本验证该 worktree 属于同一 Git common dir、checkout 的确实是 `main`、HEAD 等于 journal 绑定的 expected main、工作树与 staging 均干净、没有 merge/rebase/cherry-pick/revert 进行中，然后在该 worktree 内执行 `git merge --ff-only <feature>`；绝不要求释放、删除或切换该 worktree。

checkout/switch、merge、fetch、push 与 target worktree 验证的失败全部进入 journaled fail path；任何失败后 journal 不会停在 `running` 且无 failure code。

恢复入口在任何 fetch 前先保存不可覆盖的 `original_failure` 并追加 `recovery/preflight` attempt。入口 fetch 失败固定记录 `failure_stage=recovery_fetch`、failure code `96`、failed preflight history 与 failure summary；同一 transaction 在 origin 恢复后重新执行 preflight，不创建第二个 transaction。

## Explicit divergence recovery

普通事务和普通 `--resume` 始终只允许 `main` 通过 `--ff-only` 前进。feature 与 `main` 已从共同基线分叉时，脚本默认失败并保留 transaction；不会自动 merge，也不会把 feature branch 的任意后代当成可信提交。

只有操作者审核过分叉并明确选择恢复时，才运行：

```bash
./scripts/archive_and_push.sh \
  --resume <transaction-id> \
  --integrate-main-into-feature
```

该参数只能与 `--resume` 一起使用，不能与 `--skip-tests` 或 `--reuse-validation` 组合。恢复必须重新运行原事务验证证据中记录的 Python baseline 和 Node suite 精确命令。

### Transaction-bound validation commands

恢复验证只执行原事务 `validation-record.json` 中持久化的两条命令（`commands[0]`=Python，`commands[1]`=Node），按 journal 的 `validation_record_path` 与 `validation_record_checksum` 定位并核验。恢复调用环境中的 `ARCHIVE_PYTHON_TEST_COMMAND` / `ARCHIVE_NODE_TEST_COMMAND` 永远不能替换、弱化或补填这两条命令；存在不一致的环境值时脚本忽略它们，并在 journal 记录 `recovery_validation_command_override`（`policy: "ignored"`，含逐命令标记）。timeout 等与验证内容无关的运行参数仍可正常继承。

在任何 recovery merge 或 Git 推进之前，脚本必须确认：

- 原 validation evidence 存在，且文件 digest == record 内 `checksum` == journal `validation_record_checksum`；
- evidence 的 `head_sha` 等于 journal `validated_head`，repository 与本仓库一致，两条 baseline 均为 passed；
- `commands` 是两条非空可重放命令，其内容被 evidence checksum 覆盖；
- evidence 缺失、损坏、归属不符或原事务未保存可重放命令时 fail-closed（包括 `--skip-tests` 创建的事务）：不 merge、不移动 feature/main、不 archive、不 push，并把原因写入 `recovery_history`；绝不从当前环境补填命令。

### Legacy stuck transaction (merge/running, null failure code)

`--resume <id> --integrate-main-into-feature` 还接受且仅接受一种已知遗留状态：`phase=merge`、`phase_status=running`、`failure_code=null`，由旧版脚本在 target branch checkout 冲突时的骤然失败留下。资格审查与成功证据持久化严格分离：pure qualification 先只读验证 transaction/repository、source/commit、local/remote main、同 common-dir 的独立 main holder、相关 worktree safety、push/archive 未成功、archive record 不存在、validation path/checksum/repository/head/commands、common ancestor 与 checkout-conflict cause；此阶段不得创建 merge log、`legacy_recovery`、success reason 或 `recovery_authorized=true`。只有全部资格通过后，才可合成缺失的 `logs/merge.log`、记录 `legacy_recovery.evidence_source` 与 `legacy_merge_running_main_worktree_conflict`，并授权 recovery。已存在但不含精确 holder-conflict 的 merge log 不得降级为 topology probe；只有无 merge log 时才允许严格的同仓库 holder 拓扑探针。随后走标准 recovery merge、validation、main ff、push 与 archive 流程；成功完成后将原 journal 置为 `completed/succeeded`，原卡住状态保留在 `original_failure`、`legacy_recovery` 与 `recovery_history` 中。任一条件不满足即 fail-closed，不要求也不允许操作者手工编辑 transaction.json。

### Fail-closed preflight

脚本持有 transaction lock 后才执行恢复。开始 merge 前必须同时确认：

- journal 仍是 `merge/failed` 或等价的 `merge/interrupted`，且失败代码是 ff-only divergence（唯一例外是上一节描述的、经严格验证的 legacy `merge/running` + null code 状态）；
- 原事务未成功 push，未成功生成正式 archive record；
- `original_feature_branch` 存在，branch tip 精确等于 `original_feature_commit`；
- 不按 branch 名称猜测提交身份，也不接受未知后代；
- 本地 `main == origin/main`，并且 current main 是 original main target 的后代或与其相等；
- feature 与 current main 有可验证的共同祖先；
- feature/main 相关 worktree、index 均 clean；
- 没有 merge、rebase、cherry-pick 或 revert 正在进行；
- operator 显式传入 recovery 参数。

任一条件不成立时，恢复 fail-closed：不创建 merge commit、不移动 feature/main、不 archive、不 push，并把拒绝原因追加到 `recovery_history`。lock 已由其他进程持有时，不并发写 journal。

### Recovery topology and isolated worktree

恢复在 transaction-local detached worktree 中运行：

```text
local_archive/runtime/archive-and-push/<transaction-id>/recovery-worktree
```

该路径必须属于同一 Git common directory，并记录在 journal。merge 使用 preflight 锁定且再次核验过的 current main 精确 SHA，不使用运行中可能变化的符号 ref。拓扑固定为：

```text
base -- original feature ----------- recovery merge
    \-- current main --------------/
```

merge commit 第一父提交是 `original_feature_commit`，第二父提交是 `recovery_main_commit`，message 为 `merge: integrate main for archive recovery`。merge 成功后，原 feature branch 只允许 fast-forward 到该 merge commit；随后 `main` 只允许从锁定的 current main fast-forward 到同一提交。

禁止 rebase、squash、cherry-pick、force push、强制移动 ref 或人工修补 journal。发生冲突时不自动解决、不提交冲突状态；脚本记录 conflict paths、abort merge，并保留 transaction-local worktree 供诊断。

### Original commit and effective feature tip

恢复不改写旧事实：

- `original_feature_commit` 始终是原 feature tip；
- `original_main_commit`、`original_base_commit`、`original_validation_record` 和 `original_failure` 保留原事务证据；
- `effective_feature_tip` 只在双父 recovery merge 验证成功后指向新 merge commit；
- 原 `phase=merge`、`phase_status=failed`、failure fields 和原 validation record 不会被恢复流程覆盖或删除。

恢复后的 validation、main ff、archive 和 push 都使用 `effective_feature_tip`。普通 `--resume` 仍使用原精确 feature-tip 合同。

### Journal and validation evidence

恢复 journal 至少记录：

- `recovery_mode`, `recovery_authorized`, `recovery_requested_at`；
- `recovery_main_commit`, `recovery_common_ancestor`, `recovery_worktree`；
- `recovery_merge_commit`, `effective_feature_tip`；
- `recovery_validation_record`, `recovery_phase`, `recovery_failure_reason`；
- append-only `recovery_history` 和冲突时的 `recovery_conflict_paths`。

merge 后按 transaction-bound commands 重新运行完整 Python/Node validation。恢复门禁还核验 clean tree、固定的双父顺序、两侧祖先关系、feature/main refs、原 feature path allowlist、forbidden paths、merge tree 和 checksum manifest。新 evidence 写入 `recovery-validation-record.json` 与 `recovery-manifest.json`；不复用或覆盖原 validation record。journal 的 `recovery_validation_record` 额外记录 `command_source="original_validation_record"`、实际执行的两条命令、它们的 sha256 `command_checksums`、以及 `original_evidence_path` / `original_evidence_checksum`，使原验证证据与恢复验证结果分开可审计。已存在的恢复验证记录只有在 checksum、manifest、绑定命令和原 evidence 归属全部重新核验通过时才被接受；核验失败即 fail-closed，不会生成第二条矛盾的恢复验证记录。

### Interruption and idempotent resume

恢复阶段通过 `recovery_history` 追加记录，包括：

- `recovery/preflight`
- `recovery/worktree-created`
- `recovery/merge-started`
- `recovery/merge-completed`
- `recovery/validation-started`
- `recovery/validation-passed`
- `recovery/main-ff-completed`
- `recovery/archive-generated`
- `recovery/push-completed`
- `recovery/completed` 或 `recovery/failed`

中断后使用完全相同的命令恢复。脚本根据 Git objects、refs、remote 和 journal 交叉验证已完成阶段：可识别“merge commit 已存在但 journal 尚未更新”“main 已 ff 但阶段尚未记录”“push 已成功但最终状态未写完”。它不会创建第二个 merge commit、第二个 transaction 或重复 push。正式 archive record 只在 push 成功后发布；push 前生成的待发布记录留在 transaction 目录。每次恢复调用（包括中断后的再次恢复）都会重新从原事务 evidence 绑定验证命令并重新执行全部 evidence 完整性检查；第二次调用的环境同样不能替换命令，也不会因为 journal 已进入 recovery 阶段而跳过检查。

`recovery/completed` 状态再次 resume 时，脚本仍会重新验证：recovery validation record 存在且 checksum 正确、`command_source` 为原 validation record、实际执行的 Python/Node 命令与重绑定命令一致、command checksums 一致、原 evidence path/checksum 归属一致、effective feature tip 与 recovery merge 拓扑一致、push 结果与 archive record 同 journal 及 Git 事实相符。completed 并不意味着跳过一致性检查；任一字段缺失、被篡改或与 Git/证据事实不一致时 fail-closed：返回非零并记录原因，不重新 merge、不移动任何 ref、不重新生成 archive record、不重复 push。校验全部通过时保持幂等返回：不重复执行验证命令、不创建新 commit、不产生第二份记录。

recovery manifest 的 checksum 必须由 canonical 内容重算（除 `checksum` 字段外的稳定排序紧凑 JSON 的 sha256），completed resume 不信任 manifest 自报 checksum：重算值必须同时等于 manifest 内 checksum 与 journal 保存的 manifest checksum，且 manifest 内容必须与 journal 记录的提交身份和 Git 实时事实（merge commit parents、tree、path allowlist）逐项一致。manifest、journal 与 Git commit topology 三方一致才可信；仅两个文件彼此一致不足以通过。

### Trust boundary

Owner 裁决（2026-07-19）：APPROVE_ARCHIVE_DIVERGENCE_RECOVERY_PROTOCOL，WITH_TRUSTED_LOCAL_OPERATOR_BOUNDARY。本协议正式信任边界：

- 覆盖运行中断、main/feature 分叉、过期或矛盾状态、环境变量替换验证命令、单份或未协调的 evidence 损坏；
- completed resume 必须核验已记录证据与 Git 状态；
- 不承诺抵抗拥有本机仓库与 transaction evidence 写权限的可信操作者蓄意联合改写 journal、manifest 与全部 checksum；具备该权限的主体同样可以修改脚本或 Git 状态，完整抗恶意篡改不能靠继续增加本地自校验实现。

“可信本机操作者联合伪造 journal + manifest + 双方 checksum”的剩余向量记录为非阻塞 future hardening，不在本协议内实施。

## Test exceptions

`--skip-tests` 不是默认恢复手段。确有明确、可报告的理由时，必须同时提供理由：

```bash
./scripts/archive_and_push.sh --push --skip-tests --skip-tests-reason "reason"
```

archive record 会将其标记为 `skipped`，绝不标记为 `passed`。

## Boundaries

- 所有 journal、测试日志、validation record、failure record 与 archive record 都必须位于本仓库的 `local_archive/` 下；不得创建与项目平级的 clone 或 archive 目录。
- 只有成功事务会生成正式 Markdown archive record；失败事务保留 journal 和事务目录内的 failure summary，不得冒充成功归档。
- 不要归档 `.env.local`、状态、日志、缓存、凭据或 `local_archive/` 本身。
- `--push` 才会执行 Git mutation；`--dry-run` 不会替代真实验证或事务恢复。
