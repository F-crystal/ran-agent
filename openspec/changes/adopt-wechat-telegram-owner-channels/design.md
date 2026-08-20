## Context

The production runtime has one unified Hermes companion, one Core semantic writer, one managed wake, an existing Core presentation-binding model, and durable delivery evidence. Conversation ingress supports WeChat, Feishu, and optional Desktop, but the active direct proactive endpoint, external-MCP system queue, Core visible-schedule validation, and scheduled sender still resolve or dispatch Feishu explicitly.

The product decision is now WeChat plus Telegram for conversation, with exactly one owner-selected proactive destination. Feishu must leave the active topology after acceptance, but deleting its source, credentials, state, or recovery evidence is a separate irreversible cleanup. The ran-agent daily digest remains retired; reminders remain outside Hermes companionship; generic timer greetings and direct Python proactive text remain retired.

The owner is the sole stakeholder and recipient. The critical invariant is: one admitted proactive event produces at most one presentation effect on one trusted owner binding, with no implicit cross-channel retry.

## Goals / Non-Goals

**Goals:**

- Reuse the existing Core presentation binding as the runtime source of truth for the single active proactive destination.
- Make active proactive producers destination-independent and dispatch through the binding's platform adapter.
- Establish WeChat as the first non-Feishu proactive binding without trusting arbitrary inbound traffic.
- Add an owner-only Telegram text frontend and delivery adapter with durable outcome evidence.
- Retain the existing identity, evidence, attention, receipt, and terminal-ambiguity contracts.
- Retire Feishu from active startup and routing only after a staged replacement passes acceptance.

**Non-Goals:**

- Restoring ran-agent daily reports, generic check-ins, direct Python text delivery, or Hermes-owned work actions.
- Mirroring a proactive event to both WeChat and Telegram, or falling back to another channel after an uncertain send.
- Adding a second router, notification database, owner-identity store, or generic plugin framework.
- Telegram media parity, group-chat support, webhook hosting, public ingress, or multi-user bot operation in the first version.
- Physical deletion of Feishu code, configuration, credentials, runtime state, or historical evidence.
- Production apply, proxy installation, identity/permission changes, or risk acceptance as part of implementation authorization.

## Decisions

### 1. Core presentation binding remains the runtime authority

Deployment configuration will resolve a protected platform-specific owner destination and commit it as the existing active Core presentation binding. Runtime delivery reads that committed binding; it does not treat `identityMap`, a last inbound message, or a new `owner-presentation.json` file as destination truth.

`identityMap` continues to answer who is the trusted owner. The presentation binding answers where one visible effect is delivered. Keeping these responsibilities separate prevents a foreign or merely recent sender from replacing the proactive destination.

The existing Feishu Home DM state is not generalized into a second binding mechanism. Active callers move off it; it remains compatibility state until the later deletion decision.

Alternative considered: choose a raw destination from environment variables on every send. Rejected because it duplicates the committed Core binding, permits runtime drift, and weakens release-time validation. Environment or protected bootstrap input may select and prepare the binding during an authorized configuration transaction, but the committed binding is runtime truth.

### 2. Adapter dispatch is owned once at the presentation boundary

The existing scheduled/presentation delivery owner will dispatch by `binding.platform` to the existing WeChat sender or the new Telegram sender. Structured companion and governed external-MCP paths will resolve the same binding and use the existing durable outbox/receipt contract. Producers retain event kind, evidence, cadence, and policy fields but do not select a platform.

Only `wechat` and `telegram` are accepted for the new active topology. An unsupported, missing, inactive, or mismatched binding fails closed before a delivery reservation can be committed as sent.

Alternative considered: replace every `feishu` literal with `wechat`. Rejected because it repeats the current root cause and leaves Telegram to require another cross-cutting rewrite.

Alternative considered: create a general channel-router abstraction. Rejected because the existing presentation binding, adapter keys, ChannelHub, and durable outbox already provide the necessary seam.

### 3. WeChat destination comes from the authenticated SDK account transaction

The WeChat bridge already loads a protected account record containing `accountId` and `userId`, and its bot sends only to the logged-in user. The release/configuration transaction will combine that protected account identity with an existing versioned owner binding and seed the active Core presentation binding.

The binding is never created or changed merely because a DM arrived. WeChat proactive send still requires the SDK's valid cached `context_token`; absence is a known failed delivery and never triggers a Telegram or Feishu fallback.

### 4. Telegram v1 uses the official Bot API with bounded long polling

Telegram will be implemented with Node's existing platform primitives and `fetch`; no new dependency is planned. One bounded long-poll loop fits the current single-process bridge lifecycle and avoids a public webhook. Startup and shutdown compose with the existing Node bridge, and the polling offset is persisted atomically using existing state helpers.

Startup validates through the Bot API that no webhook is configured, requests only `message` updates, uses a positive long-poll timeout, and advances `offset` only after bounded processing. It fails closed instead of deleting or replacing a webhook automatically. Telegram documents `getUpdates` and webhook delivery as mutually exclusive and requires advancing the offset to prevent duplicates.

The bot token remains in the owner-only production environment. The owner Telegram user/chat identity is admitted only through the existing protected owner-bootstrap/release flow, extended to recognize `telegram`; inbound updates from any other chat, user, group, or bot are dropped before ChannelHub. Raw tokens and private identifiers are not logged.

Telegram bots cannot initiate a conversation with a user. Before Telegram can become an active presentation binding, the owner must open the bot's private chat and send `/start` or another message; one resulting verified owner update supplies the candidate user/chat identity to the explicit protected binding transaction. Receipt of that update alone never commits or selects the binding.

Telegram v1 supports text DM ingress and text egress. Unsupported media is rejected or represented as an explicit unsupported-media result; it is not silently converted, downloaded, or forwarded. Media parity can be proposed after real use demonstrates the need.

Successful `sendMessage` responses produce typed evidence using the returned message identifier. A transport failure with no authoritative response is terminal ambiguous/no-resend evidence. Known pre-send failures may follow the existing bounded outbox policy; Telegram does not add its own retry stack.

Before Telegram code begins, a read-only production gate must establish either direct reachability to the official Bot API or reachability through an explicitly owner-approved existing proxy path. Direct failure requires an explicit proxy decision; the verified Mac Clash path is reused only through the Telegram fetch dispatcher. No global `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`, webhook fallback, proxy manager, or second HTTP client is added.

These API assumptions were checked against the official [Telegram Bot API](https://core.telegram.org/bots/api) and [Introduction to Bots](https://core.telegram.org/bots) before this design was accepted.

### 5. One active destination means no mirror and no automatic fallback

WeChat and Telegram may both own isolated conversation sessions mapped to the same global owner. Exactly one committed presentation binding is active for proactive effects at a time. Changing it is an explicit, revision-checked configuration transaction, not a per-message model choice.

The operation key, reservation, outbox record, and evidence correspond to that single route. An ambiguous send is never retried on the other platform.

### 6. Existing proactive policy remains unchanged

Confirmed personal-learning evidence, watchlist evidence, quiet time, cadence, daily limits, stop state, dedupe, budget, egress parsing, and generic-message suppression remain prerequisites. The change moves delivery ownership; it does not broaden what Hermes may initiate.

Daily digest remains disabled. Reminder compatibility or deterministic-service code is not used to expand the Hermes companion surface.

## Risks / Trade-offs

- [WeChat context token can expire or be absent] → Report a known failed delivery, preserve the event state truthfully, and require a normal owner interaction to refresh the existing SDK context; never cross-channel fallback.
- [Telegram may be unreachable from production] → Run the read-only gate before implementation; stop for an explicit network decision rather than building a proxy/webhook stack speculatively.
- [Changing the active binding could orphan an in-flight effect] → Require no reserved/in-flight presentation work, use a revision-checked transaction, and verify the committed binding before restarting delivery.
- [Telegram `sendMessage` can fail after an uncertain network boundary] → Preserve terminal ambiguity/no-resend semantics even when this may lose one notification.
- [Text-only Telegram is less capable than WeChat] → Keep the first integration small and explicit; add media only after concrete use requires it.
- [Dormant Feishu code remains maintenance surface] → Disable it in the active topology, observe the replacement, then request a separately scoped deletion authorization.

## Migration Plan

1. Add focused failing tests for one binding, producer destination-independence, single-route dispatch, unsupported-platform failure, and no cross-channel resend.
2. Make the existing presentation delivery seam dispatch by the committed binding and move structured companion/external notification delivery off Feishu Home DM state. Keep current policy and operation keys unchanged.
3. Extend the protected bootstrap/release transaction to prepare a WeChat presentation binding from the authenticated SDK account and versioned owner identity. Rehearse locally without production mutation.
4. With separate production-apply authorization, snapshot the current binding, commit WeChat as the active binding, verify one synthetic non-duplicating delivery, then disable Feishu startup. Roll back source and the exact prior binding snapshot on failed acceptance; do not use Feishu as an automatic runtime fallback.
5. Run the separately authorized read-only Telegram Bot API reachability gate. Record only reachability and TLS/HTTP outcome, never credentials or response bodies containing private data.
6. If the gate passes, implement and test the Telegram text bridge, owner bootstrap, ChannelHub/Hermes normalization, polling lifecycle, outbound evidence, and restart behavior. If it fails, stop for a network decision.
7. With separate production-apply authorization, add the Telegram owner binding, verify inbound owner isolation, then optionally switch the single active proactive binding from WeChat to Telegram through the revision-checked transaction.
8. Reconcile current runtime, active sequence, README/profile, environment template, and runbook documents in the same archive as each accepted topology change.
9. After a fresh observation window, propose an exact Feishu deletion scope separately.

## Open Questions

- The Telegram implementation node is ready after the bounded gate records either direct Bot API reachability or the owner-approved existing proxy path; the current evidence uses the latter because direct access timed out.
- The initial active proactive destination after Telegram acceptance is an owner configuration choice; the default migration target is WeChat because its authenticated bridge already exists.
