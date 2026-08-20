## Why

Hermes is now the companion foreground, but every direct proactive path still resolves and sends through a Feishu-specific owner target. The owner has chosen WeChat and Telegram as the actual foregrounds, so delivery must follow one trusted owner-selected presentation binding without weakening the existing one-event/one-effect and attention-policy guarantees.

## What Changes

- Replace Feishu-specific proactive target lookup with one trusted owner presentation binding reused by structured companionship, governed external-MCP notifications, and any still-authorized visible Core schedule.
- Support WeChat as the first active proactive destination using the authenticated owner/account identity already held by the WeChat bridge; do not learn or replace the owner binding from an arbitrary first DM.
- Add Telegram as a complete authenticated frontend and delivery adapter, including owner allowlisting, ChannelHub/Hermes normalization, durable outbox delivery, typed outcome evidence, and bounded inbound polling lifecycle.
- Require each proactive event to resolve to exactly one configured destination. WeChat and Telegram may both accept conversations, but proactive delivery does not mirror or fall back across channels.
- Keep the ran-agent daily digest disabled, keep generic check-ins and direct Python proactive text retired, and preserve the existing evidence, quiet-time, cadence, stop, dedupe, budget, and no-resend gates.
- **BREAKING**: after staged acceptance, Feishu stops being an active conversation or proactive-delivery frontend. Physical deletion of Feishu source, configuration, credentials, runtime state, or recovery evidence remains a later, separately authorized cleanup.

## Capabilities

### New Capabilities

- `owner-presentation-binding`: Resolve every visible proactive effect through one explicit, trusted, owner-selected WeChat or Telegram binding while preserving single-route delivery and receipt semantics.
- `telegram-frontend`: Provide an owner-only Telegram conversation and delivery adapter that participates in the existing identity, ChannelHub, Hermes, media boundary, and durable outbox contracts.

### Modified Capabilities

None. This repository has no existing OpenSpec capability specifications to amend.

## Impact

- Node bridge channel validation, identity mapping, ChannelHub/Hermes payload normalization, runtime binding state, proactive-event ingress, Core visible-schedule binding, adapter dispatch, durable outbox evidence, startup/shutdown composition, and focused tests.
- Python proactive-event producers stop declaring Feishu as their destination; policy and evidence fields remain unchanged.
- Production configuration gains one explicit proactive binding selection plus owner-only Telegram credentials and identity allowlist. Telegram implementation is gated by a read-only production reachability check: direct Bot API access is acceptable, or a separately owner-approved existing proxy path may be used when direct access fails.
- Governance documents must describe WeChat/Telegram as the active foregrounds, Feishu as retired-but-retained pending separate deletion authority, and daily digest/reminder ownership without reopening retired Hermes work effects.
