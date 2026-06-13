# Hermes Action Contract Gate

Status: D-package pending action / confirmation current as of 2026-06-14.

## Why Not Prompt Only

Hermes can produce action hallucinations: the reply says an action was completed,
but the runtime has no matching tool result, media marker, artifact, save result,
or outbound send result. Prompt rules are useful hints, but they are not runtime
evidence. The Node bridge therefore records an action contract for each reply
before the final response leaves the reply backend. In `enforce` mode, the
bridge can replace unsupported action claims with a short, honest fallback. In
`repair` mode, the bridge may make one low-risk repair attempt before falling
back to the same safe rewrite.

## Action-Bearing Responses

An action-bearing response is any response that claims or implies an external
operation, including reading a link, reading media, sending a sticker, generating
media, saving state, deleting/updating state, or sending something to an
external destination. Ordinary chat remains `intent=none`.

## Contract Shape

Each contract records:

- `intent`: one of `none`, `social_read`, `media_read`, `sticker_send`,
  `media_generate`, `memory_write`, or `external_send`.
- `required_evidence`: marker, artifact, tool result, save result,
  authorization, or outbound result expected for the intent.
- `observed_evidence`: sanitized runtime evidence visible to Node.
- `final_claims`: sanitized claim categories detected in the final reply.
- `gate_decision`: `observe_only`, `pass`, `rewrite`, or `disabled`.
- `rewrite_reason`: sanitized reason categories such as
  `missing_required_evidence`, `partial_success_claim_mismatch`, or
  `outbound_failed_success_claim`.
- `original_claim_types`: sanitized claim categories detected before any
  rewrite.
- `evidence_satisfied`: whether the observed evidence satisfies the detected
  action intent.
- `missing_evidence`: evidence categories still missing.
- `partial_success_detected`: whether any runtime evidence reports partial
  success.
- `final_action`: `observe_only`, `pass_through`, `safe_rewrite`,
  `repair_success`, `repair_failed_safe_rewrite`,
  `repair_skipped_high_risk`, or `disabled`.
- `repair_attempted`: whether a low-risk repair executor ran.
- `repair_type`: the sanitized intent repaired, such as `social_read`.
- `repair_status`: `skipped`, `success`, `partial_success`, `failed`,
  `blocked_high_risk`, or `max_attempts_exceeded`.
- `repair_evidence_added`: sanitized evidence categories added by repair.
- `repair_error_code`: sanitized error code if repair did not succeed.
- `pending_action_id`: pending action id when a confirmation flow is active.
- `pending_action_type`: sanitized action type such as `sticker_save`.
- `pending_action_status`: `pending`, `cancelled`, `executed`, `failed`, or
  `expired`.
- `confirmation_detected`: whether the current message was interpreted as a
  confirmation/cancellation.
- `confirmation_result`: `explicit_authorization`, `confirmed`, `cancelled`, or
  empty.
- `execution_status`: `success`, `failed`, or empty.
- `execution_evidence_added`: sanitized evidence categories added by execution.

Logs use:

```text
[hermes-action-contract] {...}
```

The log does not include user text, provider tokens, cookies, absolute paths, or
raw tool payloads. Marker evidence is summarized as source/kind/stickerId or
source/type/fileName. Tool evidence is summarized as tool name, status, artifact
id hash, and error code.

## Modes

```env
HERMES_ACTION_GATE_ENABLED=true
HERMES_ACTION_GATE_MODE=observe
HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS=1
HERMES_ACTION_PENDING_ENABLED=true
HERMES_ACTION_PENDING_TTL_MINUTES=30
```

- `observe`: log contracts only; do not rewrite replies and do not retry tools.
- `enforce`: rewrite clearly inconsistent replies safely before sending.
- `repair`: if evidence is missing for a low-risk action claim, make at most one
  repair attempt, update the evidence ledger, then re-run the gate. Failure uses
  the same safe downgrade as `enforce`.

Temporary disable:

```env
HERMES_ACTION_GATE_ENABLED=false
```

## Safe Rewrite Scope

B package rewrites only when the final reply claims an action that runtime
evidence does not support, or when partial/failed evidence conflicts with a
success claim.

- `social_read`: no successful/partial tool evidence means the reply must not
  claim the link was read. Partial evidence becomes a partial-read statement.
- `media_read`: no media artifact/tool evidence means the reply must not
  describe the image, video, audio, or file content.
- `sticker_send`: no valid `RAN_MEDIA` sticker marker means the reply must not
  claim a sticker was sent. Valid markers are preserved.
- `media_generate`: no `WECHAT_MEDIA`, `RAN_MEDIA`, or artifact evidence means
  the reply must not claim generated media is ready.
- `memory_write`: no save/update result means the reply must not claim durable
  state was changed.
- `external_send`: no successful outbound result means the reply must not claim
  a message/email/forward was sent. Failed outbound evidence becomes a failure
  statement.

The safe rewrite does not expose action-gate internals, provider tokens,
cookies, absolute paths, tool traces, or raw artifact content.

## Automatic Repair Scope

Repair runs automatically inside the reply backend. The user does not run a
daily or per-message script. Each reply can attempt repair at most once, as
limited by `HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS`.

Allowed low-risk repair intents:

- `social_read`: call the existing social reader path once, usually
  `read_social_post_deep`, then add a sanitized tool result. Partial success is
  accepted as evidence, but the final reply must say it was partial.
- `media_read`: call the existing media context/media reader path once, then
  add artifact or tool-result evidence. The analysis artifact is evidence only;
  it is not sent as outbound WeChat media.
- `sticker_send`: call public sticker catalog tools only (`sticker_pick` and
  `sticker_attach`). It never calls save/update/delete and never sends more than
  one sticker.
- `media_generate`: only reattaches an existing generated media artifact or
  marker. It does not start a new expensive generation if no artifact exists.

Forbidden repair intents:

- `memory_write`: long-term memory writes, preferences, co-reading mutations,
  or saving media as a sticker.
- `external_send`: emails, forwards, replies to third parties, or bulk sends.
- `destructive_update`: deletes, overwrites, or bulk data changes.

High-risk intents are not repaired in `repair` mode. If evidence is missing,
the gate logs `repair_status=blocked_high_risk` and uses safe downgrade with
`final_action=repair_skipped_high_risk`.

Repair failure is never exposed as an internal tool trace. The user receives a
natural safe downgrade, while logs record sanitized `repair_status`,
`repair_type`, `repair_error_code`, and `repair_evidence_added`.

## Pending Action Scope

D package adds a separate confirmation lane for high-risk side effects. This is
not a general approval flow; ordinary chat, reading, media analysis, sticker
send markers, and media reattach repairs do not ask for confirmation.

Actions covered by pending/confirmation:

- `memory_write`: long-term memory writes and durable preference changes.
- `sticker_save`, `sticker_update`, `sticker_delete`: saving user media as a
  sticker, editing sticker metadata, or deleting stickers.
- `co_reading_write`: durable co-reading notes, comments, excerpts, or thread
  changes.
- `external_send`: email, forwarding, third-party sends, and bulk outbound
  sends.
- `destructive_update`: deletes, overwrites, and bulk durable changes.

Clear authorization may execute in `repair` mode when a safe executor exists:

- "记住这个", "以后记得..." -> `memory_write`.
- "保存这个为表情包", "把这张图加入表情包" -> `sticker_save`.
- "删除这个表情包" -> `sticker_delete`.
- "现在发送", "直接转发", "发吧" -> `external_send`, still subject to
  existing recipient/content safety checks.
- "把这段存到读书室批注" -> `co_reading_write`.

Ambiguous language creates a pending action instead of executing. For example,
"这个可以当表情包" asks whether to save; a normal image message or "这个方案不
错" stays ordinary chat and does not write memory.

## Pending State

Pending state is stored under the runtime state dir resolved by
`runtimeState.resolveStateDir()`:

```text
.ran_agent_state/action_contract/pending_actions.jsonl
.ran_agent_state/action_contract/pending_actions_index.json
```

`pending_actions.jsonl` is append-only. The index is a compact lookup view.
Each action stores only sanitized metadata:

```json
{
  "actionId": "act_...",
  "requestId": "req_...",
  "channel": "wechat",
  "conversationIdHash": "...",
  "profile": "ran-assistant-lite",
  "actionType": "sticker_save",
  "summary": "保存表情包",
  "status": "pending",
  "requiredConfirmation": true,
  "createdAt": "2026-06-14T00:00:00.000Z",
  "expiresAt": "2026-06-14T00:30:00.000Z",
  "sanitizedPayload": {
    "tags": ["开心"],
    "mediaRefs": [{ "refHash": "...", "type": "image/png" }]
  },
  "evidence": []
}
```

The state files must not contain user raw text, token/cookie values, absolute
paths, or arbitrary `filePath`. Media is represented by hash/ref only. For
sticker save, the Node process may keep a short-lived in-memory trusted media
context so that a later confirmation can call the sticker catalog without
persisting the original file path.

## Confirm And Cancel

Natural confirmations:

- "确认"
- "是的"
- "可以"
- "保存"
- "确认保存"
- "发吧"
- "删除吧"
- "就这样"

Natural cancellations:

- "取消"
- "算了"
- "不用了"
- "别保存"
- "别发"
- "不删了"

Confirmation only applies to the same channel and conversation. If there are
multiple pending actions in the same conversation, the bridge asks the user to
clarify. Expired actions are not executed. The default TTL is 30 minutes and can
be changed with `HERMES_ACTION_PENDING_TTL_MINUTES`.

## Execution Strategy

- `sticker_save`: calls the existing sticker catalog save path and accepts only
  trusted inbound media. The sticker catalog still enforces MIME, byte limit,
  and allowed source directories.
- `memory_write`: may call a safe memory writer when one is wired. Without a
  safe executor, the bridge fails safely and does not claim success.
- `sticker_update` / `sticker_delete`: owner-only sticker tools remain the
  execution boundary.
- `co_reading_write`: must use the co-reading write API/MCP when wired. It must
  not expose private note content in logs.
- `external_send`: must use the existing send adapter and record outbound
  result evidence. Missing recipient/content or send failure must not be
  described as success.
- `destructive_update`: requires explicit confirmation and a bounded executor.

`observe` and `enforce` may record candidates and rewrite false success claims,
but they do not auto-execute high-risk side effects. `repair` is the mode that
uses explicit authorization and pending confirmations.

## Rollout

Gradual rollout is controlled only by environment:

```env
HERMES_ACTION_GATE_ENABLED=true
HERMES_ACTION_GATE_MODE=observe
HERMES_ACTION_PENDING_ENABLED=true
HERMES_ACTION_PENDING_TTL_MINUTES=30
```

Then:

```env
HERMES_ACTION_GATE_MODE=enforce
```

Then:

```env
HERMES_ACTION_GATE_MODE=repair
HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS=1
```

Temporary disable:

```env
HERMES_ACTION_GATE_ENABLED=false
```

To inspect repair behavior, search service logs for
`[hermes-action-contract]` and read `repair_status`, `repair_type`,
`repair_evidence_added`, `pending_action_status`, `confirmation_result`,
`execution_status`, `final_action`, and `evidence_satisfied`.

To inspect pending state on a server, read the sanitized index:

```bash
node -e 'console.log(require("fs").readFileSync(".ran_agent_state/action_contract/pending_actions_index.json","utf8"))'
```

Disable pending action handling without disabling the whole gate:

```env
HERMES_ACTION_PENDING_ENABLED=false
```

No user-facing daily script is required. The reply backend creates pending
actions, interprets confirm/cancel replies, executes confirmed safe actions, and
records evidence automatically.

## Smoke Test

No daily script is required. The gate runs in the reply backend when enabled.
For smoke testing, send:

- Plain chat: expect `intent=none`.
- A Xiaohongshu or web link: expect `intent=social_read`.
- A media message: expect `intent=media_read`.
- A sticker response with `RAN_MEDIA`: expect `intent=sticker_send` and marker
  evidence.
- A generated media response with `WECHAT_MEDIA`: expect marker evidence.
- A user image with "这个可以当表情包": expect a pending confirmation prompt,
  not a saved sticker.
- A trusted user image with "保存这个为表情包": in `repair` mode, expect a
  sticker save result or a safe failure if the media is no longer available.
- "确认保存" in the same conversation: expect the latest pending action to run
  once, unless expired or ambiguous.
- "取消": expect the pending action status to become `cancelled`.

Inspect service logs for `[hermes-action-contract]`.
