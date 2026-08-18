# Vault Knowledge Governance

Status: CURRENT (2026-08-18)

## Scope And Authority

This file is the canonical policy for the repository-local Obsidian vault on
desktop and server. The knowledge runner must stay inside this `vault/` tree.
`CLAUDE.md` and `GEMINI.md` are minimal regular-file imports of this policy.

The vault manager curates a durable knowledge network; it is not a chat agent.
Its goals are traceability, evidence, reuse, useful links, and safe cleanup.
More text is not success.

## Storage Layers

```text
vault/
├── inbox/      # new, unprocessed material
├── raw/        # immutable source evidence
├── wiki/       # curated knowledge pages
│   ├── index.md
│   ├── log.md
│   ├── sources/
│   ├── concepts/
│   ├── projects/
│   ├── people/
│   ├── ideas/
│   ├── journal/
│   ├── outputs/
│   └── entities/
└── templates/
```

- `inbox/` is temporary intake. It may be incomplete or messy.
- `raw/` preserves original content, source, and time. Never rewrite raw
  evidence to make it cleaner.
- `wiki/` contains concise, sourced, connected pages. It is not a copy of raw
  material.
- Runtime memory, logs, databases, caches, credentials, cookies, and private
  provider state do not belong in committed vault documents.

## Page Contract

Every curated wiki page uses the closest template and has frontmatter with:

```yaml
---
type: source | concept | project | person | idea | journal | output | entity
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: seed | growing | active | stable | archived
tags: []
links: []
source_refs: []
---
```

Rules:

- Prefer `[[wikilinks]]` and existing canonical pages.
- Search before creating. Update an existing page when it owns the subject.
- Every durable claim points to one or more `source_refs` when evidence exists.
- Never invent a relationship, date, attribution, certainty, or source.
- Keep source pages factual. Put interpretation in concept/project/person/idea
  pages and label uncertainty.
- `wiki/index.md` is the useful entry point: active projects, recent sources,
  growing topics, and open loops.
- `wiki/log.md` records current maintenance state and recent curation, not a
  duplicate archive of every operation.

## Runner Modes

`vault_runner.sh` exposes exactly four actions:

### `plan`

- Read the current inbox recursively.
- Describe the bounded files, intended source/page links, and steps.
- Do not modify any file. This is prompt-enforced, not a Qwen CLI sandbox.

### `apply`

- Perform one small curation pass over current inbox items.
- Copy or move originals into the matching `raw/` area without rewriting them.
- Create or update one source page per retained source.
- For each high-value source, decide whether it updates an existing concept,
  project, person, or idea. If not, state why in the run result.
- Two or more sources about the same durable subject are a signal to update or
  create one small canonical page instead of accumulating isolated source pages.
- Update `wiki/index.md` and `wiki/log.md` only for real changes.
- Do not perform cleanup or a repository-wide rewrite.

### `cleanup`

- Touch only inbox items already proven `safe_to_cleanup`.
- An item is safe only when its raw copy exists, its source page exists, links
  resolve, required index/log updates are complete, and no unfinished step is
  recorded.
- If any condition is unknown, leave the inbox item in place.
- Do not use cleanup to ingest, grow, lint, or reorganize unrelated pages.

### `daily_carryover`

- Process only the latest `inbox/night_cycle_YYYY-MM-DD.md` selected by the
  runner.
- Update the appropriate daily/source entry and `wiki/log.md`.
- Archive the original under `raw/night_cycle/` and leave no selected copy in
  inbox after success.
- Do not process the rest of the backlog.

## State Machine

```text
new -> archived_to_raw -> source_created -> linked_or_deferred
    -> index_updated -> safe_to_cleanup -> cleaned
```

Never skip from `new` to `cleaned`. A model saying “done” is not evidence; the
required files and links must exist.

## Model And Cost Boundary

The runner is provider-neutral in Python and invokes the configured local
`qwen` CLI wrapper. Production currently routes knowledge maintenance through
Token Plan `qwen3.6-flash`; credentials come from the configured environment
variable and must never be written to prompts, output, wiki pages, or logs.

Do not tailor the knowledge architecture to an old model name. Use a linear,
small-step workflow because it is safer for every model:

1. one mode per invocation;
2. one bounded batch;
3. source before synthesis;
4. existing page before new page;
5. explicit verification before cleanup.

## Scan And Write Boundaries

- Respect the prompt's exact scope. Do not recursively inspect the whole vault
  when one item or directory is named.
- Ignore hidden runtime/task state except the runner-owned prompt files.
- Do not touch files outside `vault/`.
- Do not alter repository source, services, env files, permissions, or Git.
- Do not delete raw evidence.
- Do not expose private content in summaries; list paths and structural outcomes
  only when possible.
- Large refactors, duplicate merges, or broad lint passes require a separate
  explicit task and a recoverable plan.

## Output Contract

Return a compact structured result:

```text
mode: plan | apply | cleanup | daily_carryover
read: <bounded paths>
written: <actual paths>
linked: <canonical pages or deferred reason>
remaining: <unfinished inbox items or none>
status: ok | no_progress | blocked
```

Do not claim success when `apply` leaves the inbox unchanged or
`daily_carryover` leaves its selected note in inbox; the Python wrapper treats
those outcomes as `no_progress`.

## Capability Governance

Vault instructions and templates are project-local Markdown. They must not
register plugins, hooks, MCP servers, credentials, or host-global skills.
Executable capability changes follow the repository root `AGENTS.md` and its
agent-capability-governance rules.
