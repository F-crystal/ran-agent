你是这个 vault 的知识网络整理者。严格遵守当前目录下的 AGENTS.md。

本次任务类型：cleanup

要求：
- 只处理已经达到 safe_to_cleanup 条件的 inbox 项。
- inbox 项需要递归覆盖子目录（chat/、images/、audio/、docs/、files/）。
- 只做 cleanup，不得顺手执行 ingest、query、lint、knowledge-grow。
- 如果当前没有可安全清理的项，要明确说明并停止。
- 不要修改与 cleanup 无关的页面和目录。
- 输出保持简洁、结构化，并说明本次实际清理了什么。
