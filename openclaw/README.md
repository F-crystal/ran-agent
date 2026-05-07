# OpenClaw Integration Baseline

This directory holds pre-migration security and configuration artifacts for OpenClaw frontend adoption.

## Files

- `AGENTS.md`: OpenClaw-local runtime constraints for this subtree
- `openclaw.personal-system.json`: project-scoped OpenClaw config baseline
- `SECURITY_BOUNDARY.md`: explicit boundary and permission policy

## Important

- Replace `REPLACE_WITH_OWNER_WECHAT_USER_ID` before production use.
- Keep `OPENCLAW_STATE_DIR` inside this repository checkout.
- Do not relax `allowFrom` / `ownerAllowFrom` / `commands.allowFrom` beyond owner scope.
