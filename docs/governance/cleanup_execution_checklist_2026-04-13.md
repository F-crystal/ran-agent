# Cleanup Execution Checklist (2026-04-13)

Status: COMPLETED (frontend compatibility shell removal)

## Immediate Classification (Now)

### Now Safe To Delete

- `start_qwen.sh` (legacy manual entry for qwen CLI; no runtime/test import dependency)

### Not Safe To Delete Yet

- None.

## Decision

Current repository is **safe** for direct deletion of the two cleanup candidates in `docs/governance/cleanup.md`:

- `src/personal_agent/openclaw_front_shell.py` (deleted 2026-04-13)
- `src/personal_agent/conversation_agent.py` (deleted 2026-04-13)

Updated status (2026-04-13): `src/personal_agent/orchestrator_agent.py` no longer imports or instantiates `ConversationAgent`; proactive wording no longer calls `ConversationAgent.generate_proactive_message`.

## Low-Risk Convergence Executed

- Remove stale entry scripts that have no runtime dependency (`start_qwen.sh`).
- Keep backend startup mainline unchanged (`start_python.sh` -> `src/personal_agent/http_runner.py` -> `src/personal_agent/http_server.py` -> `src/personal_agent/service.py`).
- Align docs and tests with backend-only runtime before any file deletion.

## Preconditions (Must Be True Before Deletion)

1. `src/personal_agent/orchestrator_agent.py` no longer imports `ConversationAgent`. (DONE 2026-04-13)
2. Proactive wording path no longer calls `ConversationAgent.generate_proactive_message`. (DONE 2026-04-13)
3. Active runtime path has no direct dependency on removed frontend-era internals. (DONE 2026-04-13)
4. Runtime docs and README no longer describe Python `/chat` as active mainline.
5. Node bridge remains on OpenClaw gateway path and backend ingest path still healthy.

## Ordered Execution Steps (Result)

1. **Decouple orchestrator from conversation agent**
   - Replace conversation-agent-based proactive wording with backend-safe stub or OpenClaw-side call boundary.
   - Keep behavior conservative: default `defer/silent` when confidence is low.

2. **Stabilize tests around backend-only contract**
   - Remove/replace tests that assert Python frontend/chat orchestration internals.
   - Keep tests for `/health`, `/ingest`, `/tools/*`, memory/reflection/night-cycle/life-loop state.

3. **Converge docs to active runtime truth**
   - Update README mainline from Python `/chat` to OpenClaw gateway path.
   - Mark `/chat` as retired (410) consistently.

4. **Run verification gate**
   - Python tests pass for backend runtime scope.
   - Node bridge tests pass for OpenClaw gateway + optional ingest flow.
   - Manual smoke: Python starts, `/health` 200, `/chat` 410, `/tools/knowledge/state` 200.

5. **Delete candidates in one small change set** (DONE 2026-04-13)
   - Deleted `src/personal_agent/conversation_agent.py`.
   - Deleted `src/personal_agent/openclaw_front_shell.py`.
   - Verified no remaining runtime references/imports under `src/`.

6. **Post-delete verification gate** (DONE 2026-04-13)
   - Confirmed no `rg` hits for deleted module imports in `src` and `docs/governance` active guidance.

## Risk Notes

- **Resolved:** deleting `conversation_agent.py` does not break orchestrator import/runtime path.
- **Medium risk:** stale tests may mask runtime regressions if not refocused on backend contract.
- **Low risk:** docs-only alignment can be done immediately and should be done first.

## Rollout Recommendation

- Apply steps in sequence across small PRs/changesets.
- Keep each step independently reversible.
- Do not combine deletion with behavior refactors in the same change set.
