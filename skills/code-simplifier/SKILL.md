---
name: code-simplifier
description: Use when simplifying or refactoring this repository for clarity, consistency, maintainability, and removal of unused code while preserving behavior. Adapted from Anthropic's official claude-plugins-official/plugins/code-simplifier plugin.
---

# Code Simplifier

Use this skill for repository cleanup and refactors whose goal is simpler, clearer, more maintainable code without behavior changes.

Source: `anthropics/claude-plugins-official/plugins/code-simplifier`, version 1.0.0. The upstream agent prompt is preserved in `references/anthropic-code-simplifier-agent.md`; its Apache 2.0 license is preserved in `references/ANTHROPIC_PLUGIN_LICENSE`.

## Workflow

1. Inspect the current project state and the relevant runtime contracts first.
2. Identify complexity that can be reduced without changing behavior:
   - redundant branches or helpers
   - duplicated request/response shaping
   - stale compatibility code that is no longer reachable
   - overly clever expressions, especially nested ternaries
   - unused imports, files, exports, tests, or docs
3. Prefer project-local conventions over generic style rules.
4. Make small, reviewable edits. Preserve public contracts, test fixtures, env vars, CLI flags, and documented runtime behavior unless the user explicitly asks for a breaking cleanup.
5. Delete unused code only after proving it is unreferenced with code search and tests.
6. Run the narrowest meaningful tests first, then broader tests if shared behavior changed.
7. Summarize behavior preservation, simplifications made, deleted code, and verification evidence.

## Guardrails

- Do not refactor for fewer lines at the expense of readability.
- Do not combine unrelated concerns into a single function.
- Do not rename exported APIs, env vars, config keys, database fields, or files unless all call sites and docs are updated.
- Do not remove legacy compatibility paths unless code search and tests show they are unused or the user explicitly accepts the removal.
- If a simplification would alter behavior, label it as a functional change instead of hiding it inside refactor work.
