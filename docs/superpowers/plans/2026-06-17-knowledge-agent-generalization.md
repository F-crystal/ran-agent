# Knowledge Agent Generalization Implementation Plan

Status: HISTORICAL IMPLEMENTATION PLAN (2026-08-18)

The provider-neutral knowledge path has landed. Current runtime facts live in
`docs/governance/current_runtime_status.md`; current vault policy lives in
`vault/AGENTS.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the knowledge-management agent provider-neutral, give Hermes a lightweight relevant-context surfacing path, and make knowledge maintenance less conservative without turning chat history into noisy real-time wiki churn.

**Architecture:** Keep the Python backend as the owner of memory, knowledge state, and maintenance scheduling. Replace Qwen-specific knowledge-runner assumptions with configurable command/env naming while keeping Qwen-compatible defaults. Expose a Hermes-facing surfacing tool through the existing personal-memory MCP, backed by the existing memory and vault recall endpoint.

**Tech Stack:** Python backend (`src/personal_agent`), Node MCP bridge (`node_bridge/src`), Hermes profile prompt docs, Python unittest, Node `node:test`.

---

### Task 1: Provider-Neutral Knowledge Agent Runner

**Files:**
- Modify: `src/personal_agent/config.py`
- Modify: `src/personal_agent/knowledge_agent.py`
- Modify: `src/personal_agent/runtime.py`
- Modify: `tests/test_knowledge_agent.py`

- [ ] **Step 1: Write tests for neutral naming and env forwarding**

Add assertions that `KnowledgeAgent` exposes provider-neutral terminology and forwards a configurable API key env var to `vault_runner.sh`.

- [ ] **Step 2: Implement minimal config aliases**

Add `knowledge_agent_runner_name`, `knowledge_agent_command`, `knowledge_agent_api_key_env_var`, and `knowledge_agent_timeout_seconds` to `AppConfig`, defaulting to the current Qwen-compatible values.

- [ ] **Step 3: Update runner logs and default command runner**

Keep `vault_runner.sh` as the default command, but replace Qwen-specific log messages and timeout/env lookups with the new neutral config names.

### Task 2: Hermes Relevant Context Surfacing

**Files:**
- Modify: `node_bridge/src/personalMemoryMcpServer.mjs`
- Modify: `node_bridge/tests/personalMemoryMcpServer.test.mjs`
- Modify: `hermes/profile/AGENTS.md`

- [ ] **Step 1: Add a surfacing MCP tool**

Expose `surface_relevant_context` as a read-only alias over `/tools/memory/recall`, with a description that tells Hermes to use it for familiar topics, hobbies, projects, people, or recurring themes even when the user does not explicitly say “search memory”.

- [ ] **Step 2: Preserve existing recall behavior**

Do not change backend response shape; return the same bounded `rendered_context`, `used_sources`, and `should_inject` fields.

- [ ] **Step 3: Update Hermes guidance**

Teach Hermes to call personal memory for “natural remembering” when a topic feels historically loaded, while still avoiding tool use for ordinary context-complete chat.

### Task 3: Tempered Knowledge Growth Cadence

**Files:**
- Modify: `src/personal_agent/config.py`
- Modify: `src/personal_agent/knowledge_agent.py`
- Modify: `tests/test_knowledge_agent.py`
- Modify: `vault/.qwen/tasks/apply_prompt.md`
- Modify: `README.md`
- Modify: `README_en.md`

- [ ] **Step 1: Add backlog age/count thresholds**

Add configurable thresholds for background maintenance: inbox item count and oldest item age. Defaults should trigger a small maintenance pass above ten pending items or at two hours of age.

- [ ] **Step 2: Make surfacing decision use thresholds**

Keep the existing interval check, but allow maintenance when the inbox is large enough or old enough.

- [ ] **Step 3: Nudge apply prompt toward concept growth**

Keep “small step” and no big-bang grow, but require the apply pass to record why a source was or was not woven into a concept/project/person page.

### Task 4: Verification

**Files:**
- Test: `tests/test_knowledge_agent.py`
- Test: `node_bridge/tests/personalMemoryMcpServer.test.mjs`
- Test: `tests/test_config.py` when dependencies are available

- [ ] **Step 1: Run targeted Python tests**

Run `PYTHONPATH=src python3 -m unittest tests.test_knowledge_agent`.

- [ ] **Step 2: Run targeted Node tests**

Run bundled Node `--test node_bridge/tests/personalMemoryMcpServer.test.mjs`.

- [ ] **Step 3: Run diff hygiene**

Run `git diff --check` and report any blocked baseline tests separately.
