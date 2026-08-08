---
name: topology-work-planning
description: Plan and coordinate staged or parallel project work from a canonical dependency topology. Use when ordering roadmap stages, resuming a multi-stage plan, delegating independent tasks, assigning write ownership, integrating parallel changes, or updating sequence and status documents after work completes.
---

# Topology Work Planning

## Plan

1. Read the nearest `AGENTS.md` and the canonical topology it names. In this
   repository, use `docs/governance/active_sequence.md`.
2. Reconcile the topology with current code, runtime evidence, and public status
   documents. Let fresh facts outrank a stale schedule.
3. Compute the ready frontier: include only incomplete nodes whose dependencies
   are complete. Keep dependent nodes serial and follow the canonical priority
   within that frontier unless the owner changes it.
4. Parallelize nodes only when they share the same ready frontier, have no
   dependency relationship, and have disjoint write scopes. Assign one explicit
   owner to each write scope and leave a small discoverable coordination note.
5. Integrate completed nodes in topology order. After each integration, verify
   its exit evidence and recompute the ready frontier before starting dependents.

## Close The Loop

- In the same archive that advances a node, update the canonical topology and
  every affected runtime, feature, plan, and completion-status document.
- Mark related plans complete or superseded; do not leave authoritative progress
  only in chat or resume from an older plan.
- Remove temporary coordination state after integration when its retention is no
  longer required.

## Stop Or Reorder

Stop and repair or explicitly reorder the topology when fresh facts invalidate a
dependency, exit evidence fails, write scopes overlap, a required approval is
missing, or the owner changes priority. Record a material reorder in the
canonical topology before resuming downstream work.
