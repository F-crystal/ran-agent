# Hermes Playground Boundary

Status: CURRENT (2026-08-17); PLAN — no stage started

## Decision

Hermes stops being the all-in-one console for personal data and production
effects. It is demoted to a resettable playground shell for conversation,
emotional companionship and pluggable external-MCP play. Calendar, todo,
reminders, digest, Minutes/document writes and memory persistence move to a
deterministic command and adapter surface with real receipts. Emotional
companionship is a first-class playground function; its continuity comes from
the stable memory layer, not from the playground session.

## Current-State Facts (verified 2026-08-17)

1. Feishu write is not an MCP tool. It flows through reply-envelope
   `actionRequests` executed by trusted Node adapters
   (`replyBackend.mjs` `executeEnvelopeActionRequests`;
   `feishuCalendarClient.mjs`, `feishuMinutesDocumentClient.mjs`,
   `aiDailyDigestClient.mjs`, `todoClient.mjs`) with owner gating
   (`ACTOR_NOT_AUTHORIZED` for non-owner). A second unmediated write path is
   the `terminal` toolset: a real shell with `lark-cli` on PATH.
2. `external_mcp_gateway` exists with bounded grants, T4/T5 pending-action
   confirmation and profile-ranked policy, but is currently disabled
   (profile env + launcher override in `start_external_mcp_gateway.sh`).
   The model-facing surface is five diagnostic tools; runtime-authority tools
   are bridge-only.
3. Memory writes are already backend-curated. `personal_memory` MCP is
   query-only (`check_personal_memory_backend`, `recall_personal_memory`,
   `surface_relevant_context`). Writes = rule-based per-turn extraction
   (`memory_specialist.py`; LLM extractor off by default) + typed proposals
   (`memory.remember/correct/forget` -> `PersonalLearningStore`
   candidate->active lifecycle) + night promotion. Ombre Brain is a read-only
   recall source on `18001`; the owner-authorized S8 projector
   (`node_bridge/src/core/ombreProjectionService.mjs`) exists in source but is
   not composed in production, so Ombre content is currently a frozen
   snapshot. O2 and direct model-to-Ombre writes remain forbidden.
4. There is exactly one Hermes gateway/profile and the bridge targets one
   `HERMES_API_BASE_URL`. A second runtime is rejected: the stable surface
   needs no LLM. The boundary below is logical (toolset removal + action
   contraction + owner gating), not credential isolation; `lark-cli`
   identity, Unix users and systemd layout are unchanged.
5. A pre-Hermes short-circuit chain already exists in
   `replyBackend.mjs` `getReply` (environment-privacy commands, external-MCP
   stop, pending-action confirmation; `/checkin` in `index.mjs`). The
   deterministic command parser inserts at the head of that chain.
6. The Python backend still constructs the retired frontend chat runtime:
   `service.py` builds `OrchestratorAgent` (which instantiates
   `QwenAgentRuntime`, `ToolRegistry`, `LocalContextTools`, `ReplyReviewer`),
   yet the only HTTP entry (`/chat`) returns 410 and `handle_incoming_message`
   has no production caller. Its sole live consumer is `life_loop_job`
   (`jobs.py`) -> `evaluate_life_opportunities`, and that slice sends nothing
   (`outbound_messages=()`). `backend_qwen_enabled` defaults to `false`, so
   the "Qwen" name actually builds Hermes-gateway model clients; the real
   Qwen client path is dormant config-gated legacy.

## Boundary Contract

| Stable surface (deterministic, receipts, no NL fallback) | Playground surface (Hermes, resettable) |
|---|---|
| todo create/list/done/cancel | chat, emotional companionship |
| calendar create (+readback receipt) | read-only MCPs: search_hub, social_reader, media_reader, time, co_reading |
| reminder registration (Core, replay-safe) | sticker catalog, media_generation |
| AI daily digest (scheduled path) | `personal_memory` recall (read-only) |
| Minutes/document typed actions | external MCP via gateway, on-demand, side effects need confirmation |
| memory persistence (backend-curated) | `memory.remember/correct/forget` proposals (backend still curates) |
| all outbound sends (owner-gated) | no `terminal`, `file`, `session_search`, `playwright` |

## Target Request Flow

```text
WeChat / Feishu / Desktop
  -> channelHub (owner check, existing)
  -> replyBackend.getReply
      -> [new] strict command parser (head of short-circuit chain)
          match    -> trusted adapter -> real receipt (effectId) -> done
          no match -> Hermes (playground tool surface)
            calendar/todo NL -> reply with the exact command text
            external MCP side effects -> pending-action confirmation
```

## Stage Plan

| Stage | Scope | Exit condition |
|---|---|---|
| T0 governance | this document; reposition `hermes/profile/AGENTS.md`; register stage in `active_sequence.md` | owner approves the boundary contract |
| T1 command surface | strict grammar parser in `replyBackend.mjs` short-circuit head; `/todo add\|list\|done\|cancel`, `/cal add`; reuse existing adapters/receipts; dumb grammar (parse failure -> usage text, never guess); per-line evaluation for merged WeChat batches; no token collision with `确认/取消` | focused tests (hit / syntax error / passthrough / receipt effectId / replay idempotency) + affected suites green |
| T2 profile tightening | remove `terminal`, `file`, `session_search`, `playwright` from companion allowlist; keep read-only MCPs, sticker, media_generation, `personal_memory`, gateway (default off) | minimal profile diff; affected suites green; owner resolves the Minutes-transcript read regression (currently terminal+lark-cli via `hermesGatewayClient.mjs`): accept loss or adapterize |
| T3 NL action contraction | drop calendar/todo/Minutes/document/digest action docs from the system instruction; per-action rejection in the action contract; keep `memory.remember/correct/forget` and sticker confirmation; model answers calendar/todo NL with the exact command text; update `hermes_action_compatibility.v1.json` | tests prove the model path cannot trigger calendar; command-path receipts unchanged |
| T4 memory & Ombre | 4a: recall contract gains emotional-continuity scenarios (unresolved threads, relationships, recurring preferences); 4b: write-recall-rate decision (enable `PERSONAL_AGENT_MEMORY_LLM_ENABLED` vs extend rules vs stronger proposal guidance); 4c: enable the S8 Ombre projector (`personal_learning_confirmed` -> `hold`, relationship summaries -> `grow`) as a separately authorized production change | new recall scenarios pass; 4c production evidence via server-runtime + delivery-evidence flow |
| T5 (optional) bounded proactive companionship | enumerable rules only (e.g. at most one unsolicited check-in per day, silence-first, stop on request) via the existing ProactiveEvent path | rules written into `hermes/profile/AGENTS.md`; no "moderate initiative" wording |
| T6 zombie-runtime excision | remove the retired frontend chat runtime from the Python backend: `qwen_agent_runtime.py`, `tool_registry.py`, `local_context_tools.py`, `reply_reviewer.py`, turn-level methods in `orchestrator_agent.py`, `service.handle_incoming_message`, dormant `QwenResponsesModelClient`; keep only the `evaluate_opportunities` slice used by `life_loop_job` (relocate into `life_loop`/`service`); rewrite the 4 coupled test files (`test_message_service.py`, `test_memory.py`, `test_chat_agent_opportunities.py`, `test_personal_learning.py`) | Python suite green with the 410 `/chat` contract intact; `jobs.py` life-loop path unchanged in behavior |

## Ombre Position

Ombre remains a derived read source for emotional and long-term relationship
context, never the authority for facts. Today it is a frozen snapshot (read
path active, projector not composed). Stage T4c is the single decision point
that makes it grow again; it requires its own production authorization and
evidence. Direct model-to-Ombre writes and O2 stay forbidden regardless.

## EverOS Note

No EverOS component exists in this repository; the string appears only as a
dummy `projectorId` in Core projection tests. Any future external product of
that kind enters as an external MCP through the gateway, on demand, never on
the stable surface.

## Non-Goals (Ponytail)

- No second Hermes runtime, gateway process or port.
- No dynamic MCP registration/autonomy platform; gateway stays as-is, default off.
- No changes to lark-cli credentials, Unix users/groups or systemd identity.
- No interference with F6OBS observation or S13 (deletion there stays separately authorized).
- No new Python runtime; the command surface reuses existing `/internal/*` adapter patterns.

## Risks

- T1->T3 dual-path window: NL and commands can both create calendar/todo;
  existing operationId/effectId idempotency is the mitigation, tests must
  cover it explicitly.
- The system-instruction change (T3) is the largest behavior surface: the
  guidance copy must be written as product copy or the companion reads as
  "suddenly dumber".
- Removing `terminal` also removes model-side self-inspection for debugging;
  that is an accepted cost of the demotion, reclaimed by temporarily
  installing a debug profile when needed.
