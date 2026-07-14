---
name: archive-and-push
description: "当用户要求归档、提交、合并 main 或推送时使用：由 scripts/archive_and_push.sh 执行可恢复的本地事务，并在 local_archive/ 写入日志、journal 与归档记录。"
---

# Archive And Push

## Use

- 用户要求归档、提交、推送或同步 GitHub 时，使用脚本作为唯一 Git 事务入口。
- 不要手工 checkout、merge 或 push 来绕过脚本，除非脚本已经报告不可恢复状态且用户明确授权。
- `main` 已推送到远端不等于生产已部署；部署必须走独立、明确授权的流程。

## Normal operation

```bash
./scripts/archive_and_push.sh --push
```

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
