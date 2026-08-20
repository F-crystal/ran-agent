## 1. Authorize And Anchor The New Topology

- [x] 1.1 On implementation authorization, add this change as the next incomplete node in `docs/governance/active_sequence.md`, preserving S13 cleanup as separately authorized work.
- [x] 1.2 Add focused failing tests proving one active binding, destination-independent producers, unsupported-binding failure, and no cross-channel resend before changing delivery code.
- [x] 1.3 Record the exact current source, binding revision, enabled frontend set, and zero/in-flight presentation-work preconditions needed for a reversible cutover without exposing private identifiers.

## 2. Reuse The Existing Presentation Binding

- [x] 2.1 Make the active Core owner presentation binding the only runtime destination source for structured companion, governed external-MCP, and authorized visible-schedule delivery.
- [x] 2.2 Replace Feishu-only presentation dispatch with platform dispatch through existing WeChat and presentation/outbox seams; reject missing, inactive, ambiguous, or unsupported bindings before sent evidence is committed.
- [x] 2.3 Remove platform selection from Python companion/reminder-compatible event producers and reject or ignore any producer hint that conflicts with the committed binding.
- [ ] 2.4 Extend Core visible-schedule validation and evidence generation to accept typed WeChat and Telegram bindings without introducing a parallel binding store or generic router framework.
- [x] 2.5 Update focused Node and Python tests to prove policy gates, operation keys, binding revisions, terminal ambiguity, and one-event/one-route behavior remain intact.

## 3. Establish WeChat As The Replacement Binding

- [ ] 3.1 Extend the protected configuration/release transaction to derive a WeChat presentation binding from `resolveWeixinAccountConfig` and a matching versioned owner identity; never bind from the first or latest DM.
- [x] 3.2 Map WeChat authoritative success, missing/expired context token, known pre-send failure, and ambiguous transport outcomes into the existing durable delivery states without fallback.
- [ ] 3.3 Add a real-process local integration check proving one admitted structured companion event reaches the authenticated WeChat bot once and a replay does not create a second effect.
- [ ] 3.4 Run focused suites and the applicable immutable release gate, then classify any remaining proof gaps before preparing deployment.

## 4. Reconcile And Deliver The WeChat Cutover

- [x] 4.1 Perform an adversarial review of binding authority, foreign-sender rebinding, duplicate effects, ambiguity, restart, rollback, environment drift, and release-gate portability.
- [x] 4.2 Reconcile `current_runtime_status.md`, `active_sequence.md`, READMEs, Hermes profile documentation, environment template, runbook, and document index with the reviewed source; do not claim production acceptance yet.
- [ ] 4.3 When separately requested, use `archive-and-push` to stage only intentional source, tests, OpenSpec artifacts, and public documents.
- [ ] 4.4 With separate production-apply authorization, deploy the immutable candidate, commit the WeChat owner presentation binding by expected revision, prove one synthetic non-duplicating effect, and disable Feishu bridge startup.
- [ ] 4.5 If acceptance fails, restore the exact source and binding snapshot; otherwise record WeChat as the active proactive destination and Feishu as retired-but-retained.

## 5. Gate Telegram Before Implementation

- [x] 5.1 Using `server-runtime`, run one bounded read-only production TLS/HTTP reachability probe to the official Telegram Bot API without a bot token, private identifier, proxy mutation, or response-body logging; direct access timed out and the approved proxy path was separately verified.
- [x] 5.2 When direct reachability fails, record the explicit owner decision to reuse the existing Mac Clash proxy path; do not add webhook, global proxy, or automatic cross-channel fallback.
- [x] 5.3 Record the bounded gate result and mark the Telegram implementation node ready because the owner-approved proxy gate passed, without changing production configuration.

## 6. Add The Owner-Only Telegram Text Frontend

- [x] 6.1 Extend platform normalization, identity bootstrap, stable conversation/session keys, ChannelHub/Hermes payload validation, and tests to recognize `telegram` only for a protected owner private-chat binding. Focused real-Core seam is green; Telegram remains conversation-only and is not in the active proactive binding.
- [x] 6.2 Implement one abortable `message`-only long-poll loop with empty-webhook preflight, positive timeout, atomic update-offset persistence, bounded `retry_after`/backoff handling, and normal Node bridge startup/shutdown composition using existing primitives. Revalidated with fixed normal API deadline and lifecycle-bounded preflight evidence.
- [x] 6.3 Reject foreign users, groups, channels, bots, malformed updates, and unsupported media before ChannelHub without logging raw tokens or private identifiers. Revalidated after transport-error sanitization.
- [x] 6.4 Implement text `sendMessage` delivery through the existing durable outbox contract, mapping authoritative returned message identifiers to sent evidence and uncertain transport outcomes to terminal ambiguity/no-resend. Revalidated with fixed normal API deadline, healthy slow-send, and independent-process no-replay evidence.
- [x] 6.5 Add focused unit and independent-process bridge/outbox integration checks for owner isolation, restart dedupe, session isolation from WeChat, text delivery, unsupported media, binding mismatch, shutdown, and no cross-channel fallback. The exact Telegram matrix passed 19/19 in an isolated tecserver Node process; the temporary candidate was removed.

## 7. Reconcile And Deliver Telegram

- [x] 7.1 Run the changed invariant tests, relevant Node suite, secret-output checks, and applicable immutable release gate; the workflow-guarded focused suite passed 410 checks, related Python/release tests passed 125 checks, and strict OpenSpec plus secret/global-proxy scans passed.
- [x] 7.2 Perform an adversarial review of Bot API effect ambiguity, update replay, owner spoofing, polling concurrency, rate limits, secret handling, and production network assumptions.
- [x] 7.3 Reconcile public runtime, topology, README/profile, environment, runbook, and OpenSpec status documents with the reviewed Telegram source; keep media parity explicitly out of scope.
- [ ] 7.4 When separately requested, use `archive-and-push` for the reviewed Telegram change.
- [ ] 7.5 With separate production-apply authorization, deploy Telegram credentials, have the owner start the private bot chat, verify the resulting owner update, commit its protected binding transaction, and leave WeChat as the active proactive destination unless the owner explicitly selects Telegram.
- [ ] 7.6 If the owner selects Telegram, change the single active presentation binding by expected revision, prove one synthetic non-duplicating effect, and confirm WeChat receives no mirrored send.

## 8. Observe Before Any Feishu Deletion

- [ ] 8.1 Observe the accepted topology for one Core writer, one managed wake, stable WeChat/Telegram ingress, no duplicate presentation effect, no cross-channel resend, and no active Feishu traffic.
- [ ] 8.2 Update the canonical status documents with observation evidence and close this OpenSpec change only after every accepted node is truthful.
- [ ] 8.3 If physical Feishu cleanup is still wanted, create a separate exact deletion proposal covering source, configuration names, credentials, runtime state, tests, documents, retention, and rollback; do not delete under this change.
