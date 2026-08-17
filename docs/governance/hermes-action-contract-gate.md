# Hermes Action Contract Gate

Status: CURRENT (2026-08-08)

## Why Not Prompt Only

Hermes can produce action hallucinations: the reply says an action was completed,
but the runtime has no matching tool result, media marker, artifact, save result,
or outbound send result. Prompt rules are useful hints, but they are not runtime
evidence. The Node bridge therefore records an action contract for each reply
before the final response leaves the reply backend. It audits model declarations
and protected runtime evidence; it never selects an MCP action from user or
reply prose. In `enforce` mode, the bridge can replace unsupported action claims
with a short, honest fallback. In `repair` mode, only an explicitly injected,
bounded retry for an already declared trusted action may run before the same
safe rewrite.

`feishu.minutes_to_doc` is the single document-write action currently
registered. Hermes must first read an existing Minutes transcript, then declare
the transcript title, destination folder title, document title and bounded
DocxXML. Node grounds both titles in the current owner request, uniquely resolves
the existing resources under the authenticated user, creates the document in
that folder, and accepts success only after document readback. Ambiguous lookup
or unknown write state fails without automatic retry. If the first private
Minutes reply has no executable action because its envelope is invalid or its
action list is empty, Node may request exactly one strict Hermes replan
only when the current owner turn names both Minutes and a cloud document. The
replan reuses gathered content, calls no tool, accepts only the exact public
Minutes fields, and still fails closed before lark-cli if a model-owned field
such as `id` remains.

## Delivery Boundary

An action receipt proves only the action evidence named by its contract. It is
not by itself a universal delivery receipt for every response surface. The
durable text path records adapter delivery before timeline and backend
projection; non-durable or media paths require their own delivery semantics.
Do not infer that every assistant-history layer already has one proven
final-delivered canonical turn.

## Action-Bearing Responses

The semantic action source is one of: a `replyEnvelope.actionRequests`
declaration, a protected compatibility signal from an existing bridge/tool path,
or no action. Ordinary user text, URLs, images, emoji, and final reply wording
never select a tool or create an action intent. Natural-language success-claim
detection is defensive only: without a declaration or protected signal it can
downgrade an unverified completion claim, but cannot execute or retry an action.

## Contract Shape

Each contract records:

- `intent`: one of `none`, `typed_action`, `social_read`, `media_read`,
  `sticker_send`, `media_generate`, `memory_write`, `external_mcp_read`,
  `external_mcp_write`, or `external_send`.
- `required_evidence`: marker, artifact, tool result, save result,
  authorization, or outbound result expected for the intent.
- `observed_evidence`: sanitized runtime evidence visible to Node.
- `final_claims`: sanitized claim categories detected in the final reply.
- `contract_source`: `typed_action_request`, `protected_compatibility`, or
  `no_action`; `declared_action_types` remains separate from compatibility.
- `gate_decision`: `observe_only`, `pass`, `rewrite`, or `disabled`.
- `rewrite_reason`: sanitized reason categories such as
  `missing_required_evidence`, `unverified_success_claim`,
  `partial_success_claim_mismatch`, or
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
- `repair_trigger_source`: `typed_action_failure`,
  `typed_claim_missing_request`, `trusted_compatibility_partial`,
  `trusted_delivery_retry`, or `none`.
- `repair_session_scope`: `task` for bounded repair work, otherwise `none`.
- `repair_attempt_count` and `repair_recursive_blocked`: bounded retry
  telemetry; recursive model/repair loops are forbidden.
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
HERMES_ACTION_GATE_MODE=repair
HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS=1
HERMES_ACTION_PENDING_ENABLED=true
HERMES_ACTION_PENDING_TTL_MINUTES=30
```

- `observe`: log contracts only; do not rewrite replies and do not retry tools.
- `enforce`: rewrite clearly inconsistent replies safely before sending.
- `repair`: a missing-evidence claim is safely rewritten unless an existing
  typed/protected contract supplies one explicit bounded retry implementation.
  The bridge never guesses a tool, media object, marker, or action type from
  text. Failure uses the same safe downgrade as `enforce`.

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
- `external_mcp_read`: no successful `external_mcp_tool_result` means the
  reply must not claim an external MCP game/forum/browser state was read.
- `external_mcp_write`: no authorization plus successful
  `external_mcp_tool_result` means the reply must not claim a T4/T5 external
  MCP side effect was completed.

The safe rewrite is a neutral bridge notice: it must not use first-person bridge
persona text, action-gate internals, provider tokens, cookies, absolute paths,
tool traces, or raw artifact content.

Bridge-authored notices use `bridge_*` sources such as `bridge_action_gate`,
`bridge_action_repair`, and `bridge_pending_action`. They can be sent to the
user, but they are filtered out of Hermes recent/global assistant history so
Hermes does not later replay bridge safety text as its own personality.

## Bounded Repair Scope

Each reply has at most one repair attempt, controlled by
`HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS`. A repair plan is allowed only when
the action contract is already `typed_action_request` or
`protected_compatibility`, carries a completion claim, is not high risk, and a
caller injects the retry implementation. The plan retains the original
operation/idempotency scope; it is task-scoped and must not append ordinary
conversation/provider history or trigger a recursive repair.

Allowed compatibility normalization is intentionally narrow: attach an existing
bridge-owned media object through an existing trusted adapter when its transport
marker is missing; retry an interrupted delivery only inside its existing
idempotent outbox scope; or rewrite a complete claim as partial when a trusted
tool result is partial. Neither the bridge nor repair may fetch a URL, analyze
an image, pick a sticker, start media generation, or synthesize a marker merely
because a user or Hermes message contains related text.

Forbidden repair intents:

- `memory_write`: long-term memory writes, preferences, co-reading mutations,
  or saving media as a sticker.
- `external_send`: emails, forwards, replies to third parties, or bulk sends.
- `external_mcp_write`: forum comments, game actions, browser side effects, or
  arbitrary external MCP writes. These require pending action/待确认 or scoped
  grant and are never inferred from model text alone.
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

Production deploy defaults to repair mode:

```env
HERMES_ACTION_GATE_ENABLED=true
HERMES_ACTION_GATE_MODE=repair
HERMES_ACTION_PENDING_ENABLED=true
HERMES_ACTION_GATE_MAX_REPAIR_ATTEMPTS=1
HERMES_ACTION_PENDING_TTL_MINUTES=30
```

For temporary diagnosis-only mode:

```env
HERMES_ACTION_GATE_MODE=observe
```

For rewrite-only mode without repair attempts:

```env
HERMES_ACTION_GATE_MODE=enforce
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
