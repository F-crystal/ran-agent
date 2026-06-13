# Hermes Action Contract Gate Deployment

Status: CURRENT (2026-06-14)

## What This Deploy Solves

This deploy addresses Hermes action hallucination: the assistant may say it has
read, saved, sent, generated, or updated something even when Node has no matching
runtime evidence. The gate now sits in `replyBackend` before replies leave the
Node bridge.

Covered behavior:

- Low-risk reads and media/sticker marker repairs can be repaired once in
  `repair` mode.
- Unsupported claims are rewritten honestly in `enforce` mode.
- High-risk side effects use pending action / confirmation instead of automatic
  repair.
- Sticker save/update/delete, long-term memory writes, co-reading writes,
  external sends, and destructive updates no longer get silently claimed without
  evidence.
- Pending action state is sanitized and does not store user raw text, tokens,
  cookies, or absolute file paths.

## Deploy From The Server

Run from the production checkout:

```bash
cd /opt/ran_agent
source /opt/ran_agent/.venv/bin/activate
git pull --ff-only
bash scripts/apply-hermes-runtime-split.sh
```

The deploy script updates the root Node env and `node_bridge/.env.local` without
touching secrets, installs the Hermes lite/full runtime split, and restarts the
managed services. Do not hand-edit systemd units as the normal path.

## Required Env

The deploy script owns these non-secret defaults:

```text
HERMES_ACTION_GATE_ENABLED=true
HERMES_ACTION_GATE_MODE=observe
HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS=1
HERMES_ACTION_PENDING_ENABLED=true
HERMES_ACTION_PENDING_TTL_MINUTES=30
```

For active repair/confirmation rollout, change the mode locally after review:

```text
HERMES_ACTION_GATE_MODE=repair
```

`observe` records contracts but does not execute pending confirmations.
`enforce` rewrites false success claims but does not execute pending
confirmations. `repair` enables low-risk repair and high-risk explicit
authorization / confirmation execution.

## Runtime State

Pending actions live under the configured runtime state directory:

```text
.ran_agent_state/action_contract/pending_actions.jsonl
.ran_agent_state/action_contract/pending_actions_index.json
```

`pending_actions.jsonl` is append-only. The index is a compact lookup table.
Both files contain only sanitized fields such as action id, conversation hash,
action type, status, short summary, media ref hashes, and evidence categories.

Do not commit `.ran_agent_state/`.

## Smoke Checks

After deploy:

```bash
cd /opt/ran_agent
grep -E 'HERMES_ACTION_GATE|HERMES_ACTION_PENDING' /opt/ran_agent/.env.local
grep -E 'HERMES_ACTION_GATE|HERMES_ACTION_PENDING' /opt/ran_agent/node_bridge/.env.local
journalctl -u ran-agent-node.service -n 200 --no-pager | grep hermes-action-contract
```

Expected env lines:

```text
HERMES_ACTION_GATE_ENABLED=true
HERMES_ACTION_GATE_MODE=observe
HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS=1
HERMES_ACTION_PENDING_ENABLED=true
HERMES_ACTION_PENDING_TTL_MINUTES=30
```

Functional smoke in WeChat:

- Plain chat: expect no approval prompt.
- Send an image with "这个可以当表情包": expect a confirmation prompt, not an
  automatic save.
- Reply "确认保存" in the same conversation while in `repair` mode: expect one
  sticker save attempt.
- Ask for a sticker send: expect `RAN_MEDIA` to be resolved to media, not shown
  as raw text.
- Ask to read an XHS link: logs should show evidence/repair behavior; Hermes
  must not claim full content read without read evidence.

## Rollback

Disable only the action gate:

```text
HERMES_ACTION_GATE_ENABLED=false
```

Disable pending action handling while keeping telemetry:

```text
HERMES_ACTION_PENDING_ENABLED=false
```

Then rerun:

```bash
bash scripts/apply-hermes-runtime-split.sh
```

The pending action files are local runtime state. Rollback does not require
deleting them.

## Logs To Watch

Search for:

```text
[hermes-action-contract]
```

Key fields:

- `intent`
- `gate_decision`
- `final_action`
- `evidence_satisfied`
- `repair_status`
- `pending_action_type`
- `pending_action_status`
- `confirmation_result`
- `execution_status`
- `execution_evidence_added`

No log entry should contain user raw text, token/cookie values, or absolute
media paths.
