# S12-R1B Web Routing Task

Status: CURRENT (2026-08-09)

Lifecycle: `LOCAL_VERIFIED` on the unarchived S12-R1 worktree. S12 and
production remain unchanged and not started.

## Objective

Make `search_hub` the sole generic web/research surface in the default
companion capability assembly. Keep provider fallbacks behind that surface and
keep browser automation as a separate explicit debugging capability. Prove the
route with the same DLM research shape that exposed the production defect.

## Verified starting facts

- `hermes/profile/AGENTS.md` and Node's injected system instruction already say
  ordinary web/research uses `search_hub`.
- `hermes/profile/config.companion.yaml` nevertheless exposes both the built-in
  `web` toolset and `mcp-search_hub` and retains a built-in `web` provider block.
- `search_hub` already owns typed `search`, `read`, and `research` tools and its
  Tavily/OpenCLI/provider policy. The built-in `web` surface is not required for
  those three accepted operations.
- The companion profile still exposes `mcp-playwright` as the accepted browser
  automation/debugging capability. R1B does not remove that distinct product
  surface or claim that Search Hub's currently unimplemented Playwright
  fallback replaces it.
- Production remains at S4 source `98fd8b38eb4bca9caa6f223f990f1bec3ab6cd0d`.

## Assembly truth principle

A prompt or document does not establish a runtime route. Every routing claim
must have all three forms of evidence:

1. declaration: the governed instruction names the canonical surface;
2. assembly: the default profile/toolset exposes no competing generic surface;
3. behavior: a representative request reaches the intended typed handler.

If any layer conflicts, the assembly is not accepted even when unit tests prove
the wording is present.

## Ordered work

```text
R1B-0 verified facts and lock
  -> R1B-1 remove companion built-in web toolset/provider block
  -> R1B-2 align profile template and diagnostics
  -> R1B-3 lock the assembly invariant in focused tests
  -> R1B-4 send a DLM research-shaped call through search_hub's real MCP handler
  -> R1B-5 focused/full affected validation and governance close-out
  -> bounded candidate archive
  -> independent exact-SHA review
  -> R1C
```

## Intended files

- `hermes/profile/config.companion.yaml`
- `hermes/profile/config.pro.template.yaml`
- `scripts/diagnose-hermes-tools.sh`
- `scripts/diagnose-search-hub.sh`
- focused profile/Search Hub tests
- the four canonical governance documents affected by R1B state

Do not modify legacy `config.yaml`/`config.lite.yaml`, production services,
credentials, Search Hub providers, document actions, CLI binaries, Ombre, Core
schema, external-MCP execution, or attention/presence composition in this node.

## Acceptance

- The default companion toolset contains `mcp-search_hub` and not the built-in
  `web` toolset; the companion file has no built-in `web.search_backend` or
  `web.extract_backend` block.
- Search Hub retains `search`, `read`, and `research`; its internal Tavily and
  governed provider settings remain available.
- Diagnostics report a competing built-in generic web surface as failure and
  report the intended companion assembly as passing.
- A synthetic DLM request invokes the real Search Hub MCP `research` handler,
  reaches a stubbed accepted provider, and returns typed structured evidence.
  No `web_extract`, `web_search`, or deferred `tool_describe` path participates.
- Focused profile, Search Hub router/MCP and affected release/source tests pass;
  shell syntax and `git diff --check` pass.
- Governance says R1B complete only after fresh evidence; R1C remains next and
  S12 remains not started.

## Follow-on boundaries

- R1C may implement the local semantic `document.write` effect before R1D, but
  it is not production-candidate complete until R1D confirms the exact Feishu
  provider and `lark-cli` contract selected for S12.
- R1E extends S10's accepted `external_poll -> hash-bound Core fact -> no send`
  seam into real external-MCP composition. It must not create a second external
  fact authority or grant an MCP provider owner-visible send authority.
- The `lark-cli` 1.0.66 versus 1.0.85 outcome is an R1D recorded decision, not
  an implicit R1B upgrade task. Full Ombre/provider abstraction stays deferred
  unless R1D finds an actual S12 compatibility blocker.

## Local completion evidence

- The companion profile no longer exposes the built-in `web` toolset or its
  provider block; `mcp-search_hub`, its three typed tools and the distinct
  `mcp-playwright` browser/debug surface remain.
- Both updated diagnostics report the intended source assembly as passing. The
  Search Hub MCP smoke returned its typed academic success/warning boundary.
- The DLM-shaped `tools/call` reached the real `research` handler, selected the
  accepted academic provider seam first and returned structured sources without
  `web_extract`, `web_search` or `tool_describe` participation.
- The complete affected Search Hub/profile Node set passed `62/62`; the
  companion profile/release Python set passed `43/43`; Shell syntax and
  `git diff --check` passed.
- No production profile, process, service, credential, CLI binary or source
  pointer changed. A bounded candidate archive is the next delivery boundary
  together with the still-unarchived R1A composition and the later R1B.1
  ordinary-chat envelope repair. Independent exact-SHA review follows; R1C is
  the next implementation node only after that review.
