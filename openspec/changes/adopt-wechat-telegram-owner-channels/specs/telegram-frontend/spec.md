## ADDED Requirements

### Requirement: Telegram implementation is gated by production reachability
Telegram implementation MUST NOT begin until a read-only production check establishes either direct reachability to the official Telegram Bot API or reachability through an explicitly owner-approved existing proxy path.

#### Scenario: Direct Bot API is reachable
- **WHEN** the read-only gate completes a bounded TLS/HTTP probe without exposing credentials or private response data
- **THEN** the Telegram implementation node becomes ready for direct long-poll and send operations

#### Scenario: Direct Bot API is unreachable
- **WHEN** the read-only gate cannot reach the official Bot API from production
- **THEN** implementation remains blocked pending an explicit owner decision on an existing approved proxy path

#### Scenario: Owner-approved existing proxy path is verified
- **WHEN** direct reachability fails, the owner approves an existing proxy path, and a bounded tecserver probe reaches the official Bot API through that path
- **THEN** the Telegram implementation node becomes ready and injects the proxy only into Telegram requests without global proxy environment or webhook fallback

### Requirement: Owner-only Telegram identity
The Telegram frontend MUST accept conversation traffic only from one explicitly bootstrapped owner user and private chat that map to the existing global owner identity.

#### Scenario: Owner private message
- **WHEN** an update comes from the configured owner user in the configured private chat
- **THEN** the bridge normalizes and submits it to ChannelHub as platform `telegram`

#### Scenario: Foreign, group, channel, or bot message
- **WHEN** an update comes from any unconfigured user, group, channel, or bot
- **THEN** the bridge drops it before ChannelHub and does not mutate owner identity or presentation binding

#### Scenario: Owner has not started the bot chat
- **WHEN** the owner has not yet opened the bot's private chat and sent a message
- **THEN** the system does not activate a Telegram presentation binding or claim proactive reachability to that owner

#### Scenario: Verified owner update is awaiting authorization
- **WHEN** a matching private owner update supplies candidate user and chat identity
- **THEN** the system requires a separate protected binding transaction and does not bind solely because the update arrived

### Requirement: Protected Telegram configuration
The Telegram bot token and raw owner identifiers MUST remain in owner-only configuration or protected runtime state and MUST NOT appear in logs, public documentation, committed files, or delivery evidence.

#### Scenario: Startup diagnostics
- **WHEN** the Telegram bridge starts or fails configuration validation
- **THEN** diagnostics expose only bounded status and non-reversible identifier hashes

#### Scenario: Missing token or owner identity
- **WHEN** required Telegram credentials or trusted owner identity are absent
- **THEN** the bridge fails closed without polling, sending, or enabling Telegram as the active binding

### Requirement: Bounded long-poll lifecycle
The Telegram frontend SHALL use one bounded long-poll loop composed with the existing Node bridge lifecycle and SHALL persist its acknowledged update offset atomically.

#### Scenario: Webhook is configured
- **WHEN** startup preflight reports a non-empty Telegram webhook URL
- **THEN** the long-poll bridge fails closed without deleting the webhook or starting `getUpdates`

#### Scenario: Normal update processing
- **WHEN** one owner update is handled successfully
- **THEN** the bridge advances the stored offset so the update is not delivered to ChannelHub again after restart

#### Scenario: Shutdown
- **WHEN** the Node bridge receives its normal stop signal
- **THEN** the Telegram poll is aborted and no second polling loop remains active

#### Scenario: Poll transport failure
- **WHEN** polling encounters a transient transport or rate-limit response
- **THEN** the bridge follows bounded server guidance or backoff without spawning another loop or changing presentation binding

### Requirement: Telegram conversation isolation
Telegram messages SHALL receive stable Telegram-specific conversation and Hermes session keys while mapping the trusted sender to the same global owner used by WeChat.

#### Scenario: Same owner across platforms
- **WHEN** the configured owner converses through WeChat and Telegram
- **THEN** both identities map to the same global owner while their conversation and Hermes session keys remain platform-scoped

#### Scenario: Telegram payload validation
- **WHEN** a normalized Telegram payload lacks its required platform, private-chat, sender, message, or timestamp fields
- **THEN** ChannelHub or its boundary validator rejects it as invalid input

### Requirement: Telegram text delivery produces typed evidence
The Telegram adapter SHALL send text through the selected owner binding and translate an authoritative Bot API response into typed durable delivery evidence.

#### Scenario: Authoritative send success
- **WHEN** the Bot API returns a successful message result
- **THEN** the adapter records sent evidence derived from the returned message identifier without exposing the token or raw private identifiers

#### Scenario: Ambiguous send outcome
- **WHEN** the connection fails without an authoritative Bot API response after the request may have crossed the effect boundary
- **THEN** the adapter returns terminal ambiguous evidence and the outbox does not resend on Telegram, WeChat, or Feishu

#### Scenario: Telegram is not the active binding
- **WHEN** Telegram is configured for conversation but the committed proactive presentation binding selects WeChat
- **THEN** proactive delivery does not call the Telegram send API

### Requirement: Telegram v1 is text-only
The first Telegram frontend version SHALL support private text messages and SHALL fail explicitly for unsupported media instead of silently downloading, converting, or forwarding it.

#### Scenario: Text message
- **WHEN** the owner sends or receives a supported text message
- **THEN** the bridge preserves the text through the normal ChannelHub and delivery contracts

#### Scenario: Unsupported media
- **WHEN** a Telegram update or outbound request contains unsupported media
- **THEN** the bridge returns or records a bounded unsupported-media result without treating the content as successfully processed
