## ADDED Requirements

### Requirement: One committed active presentation binding
The system SHALL resolve every visible proactive effect through exactly one active, committed Core owner presentation binding whose platform is `wechat` or `telegram`.

#### Scenario: Active binding resolves
- **WHEN** an admitted proactive effect reaches the presentation boundary with one valid active binding
- **THEN** the system dispatches the effect only through the adapter named by that binding

#### Scenario: Binding is missing or unsupported
- **WHEN** the active binding is missing, inactive, ambiguous, or names an unsupported platform
- **THEN** the system fails closed without sending or recording a successful presentation effect

### Requirement: Trusted binding configuration
The system MUST create or change the active presentation binding only through a protected, revision-checked owner configuration transaction that validates the platform destination against existing trusted owner identity and platform credentials.

#### Scenario: Authorized binding change
- **WHEN** an authorized transaction supplies a protected WeChat or Telegram owner destination matching the trusted global owner
- **THEN** the system commits the new presentation binding with an explicit revision and makes it available to subsequent delivery work

#### Scenario: Inbound message cannot rebind delivery
- **WHEN** any inbound DM or other message arrives without an authorized binding transaction
- **THEN** the system does not create, replace, or select the active proactive presentation binding

#### Scenario: Stale binding revision
- **WHEN** a configuration transaction presents a revision that is not the currently committed revision
- **THEN** the system rejects the transaction without changing the active binding

### Requirement: Destination-independent producers
Structured companion candidates, governed external-MCP notifications, and any authorized visible Core schedule SHALL describe the effect and its evidence without selecting a delivery platform.

#### Scenario: Companion candidate is admitted
- **WHEN** Python submits a valid evidence-backed companion `ProactiveEvent`
- **THEN** Node applies existing admission and egress policy and resolves the active presentation binding at the delivery boundary

#### Scenario: Producer supplies a conflicting channel
- **WHEN** a producer includes a platform hint that conflicts with the active binding
- **THEN** the system ignores or rejects the hint and never routes outside the committed binding

### Requirement: One event produces at most one routed effect
The system MUST associate each admitted proactive event with one operation key, one destination binding revision, and at most one adapter route.

#### Scenario: Successful delivery
- **WHEN** the selected adapter returns authoritative success
- **THEN** the system commits one sent outcome with evidence for that adapter and binding revision

#### Scenario: Ambiguous delivery
- **WHEN** the selected adapter outcome is ambiguous
- **THEN** the system records terminal ambiguity and does not resend through WeChat, Telegram, or Feishu

#### Scenario: Adapter known failure
- **WHEN** the selected adapter returns a known failure before an effect is accepted
- **THEN** the system follows only the existing bounded outbox policy and does not invent a cross-channel fallback

### Requirement: Existing attention and evidence policy is preserved
Changing the presentation binding SHALL NOT bypass or weaken personal-learning evidence, watchlist evidence, quiet time, cadence, daily limit, stop state, dedupe, budget, reply parsing, generic-message suppression, or post-send receipt checks.

#### Scenario: Generic greeting reaches the new adapter boundary
- **WHEN** Hermes produces a generic proactive greeting without the required bounded context
- **THEN** the existing egress policy suppresses it before either WeChat or Telegram sends

#### Scenario: Quiet or stopped companion policy
- **WHEN** a valid candidate arrives during quiet time or while companionship is stopped
- **THEN** the system suppresses it regardless of the active presentation platform

### Requirement: Retired work remains retired
The channel migration MUST NOT reactivate ran-agent daily digest, direct Python proactive text, generic timer check-ins, or Hermes-owned reminder/work-action behavior.

#### Scenario: Daily digest remains disabled
- **WHEN** channel configuration changes or a retired digest schedule is encountered
- **THEN** the system keeps the ran-agent digest suppressed and leaves daily reports to Codex

### Requirement: Feishu leaves the active topology without implicit deletion
After replacement-channel acceptance, the system SHALL keep Feishu disabled for active conversation startup and proactive routing, while retaining its source and protected recovery state until a separate deletion is authorized.

#### Scenario: Replacement channel accepted
- **WHEN** the WeChat replacement binding passes production acceptance
- **THEN** Feishu startup and active owner routing are disabled without deleting Feishu artifacts

#### Scenario: Runtime rollback is required
- **WHEN** the authorized cutover transaction fails acceptance
- **THEN** the exact prior source and presentation-binding snapshot may be restored without enabling automatic runtime fallback

