# Hermes Immutable Release Deployment

Status: CURRENT (2026-07-11)

This is the production deployment contract for `/opt/ran_agent`. A branch is
only a way to discover a release; the deploy unit is always one immutable
40-character commit SHA. The transaction uses **stage-and-switch** (option A):
it archives the SHA to `/opt/ran_agent-release/stages`, gates that stage,
snapshots the active checkout and runtime, then changes `/opt/ran_agent` only
inside the transaction. This is smaller and safer than adding a second
worktree/service-pointer topology to the existing systemd deployment.

Never run `git pull`, `git switch`, `git checkout`, `git reset`, or `git
clean` as a pre-deploy action in `/opt/ran_agent`.

`--apply` and `--rollback` interrupt the four core services and any active
managed optional service briefly. Every other step below is read-only except
`git fetch`, which updates local remote tracking objects only.

## 0. First Enablement Bootstrap

Use this section exactly once when the active checkout predates the deployment
entry scripts. It extracts a small, verified framework from the already-fetched
candidate into a private temporary directory; it does not add files to
`/opt/ran_agent`, switch HEAD, or make the production worktree dirty. All
later releases use the normal main/candidate entries below.

| Purpose | Command | Expected result / stop condition |
|---|---|---|
| Enter the checkout | `cd /opt/ran_agent` | Stop if this is not the active production checkout. |
| Activate the managed Python environment | `source /opt/ran_agent/.venv/bin/activate` | The command succeeds. |
| Confirm the old checkout is clean | `git status --short` | No output. Any output stops bootstrap. |
| Fetch only the reviewed candidate object | `git fetch --no-tags origin codex/hermes-dual-spec-implementation` | Fetch succeeds; production HEAD and files remain unchanged. |
| Resolve its immutable SHA | `git rev-parse --verify refs/remotes/origin/codex/hermes-dual-spec-implementation^{commit}` | Record the full SHA as `CANDIDATE`; stop on failure. |
| Extract the bootstrap source outside the checkout | `git show CANDIDATE:scripts/bootstrap-hermes-release.sh > /tmp/ran-agent-bootstrap.sh` | Replace `CANDIDATE` with the recorded SHA. Only `/tmp` changes. |
| Verify bootstrap source digest | `printf '%s  %s\n' '073ddecae4336e9be457f6e9c1aef14d2877d9f35e14045a12eedacf424d14c6' /tmp/ran-agent-bootstrap.sh | sha256sum -c -` | Expect `OK`. Stop on any mismatch; do not execute the file. |
| Make the temporary file owner-only | `chmod 700 /tmp/ran-agent-bootstrap.sh` | Succeeds. |
| Validate the staged framework without service interruption | `bash /tmp/ran-agent-bootstrap.sh --dry-run CANDIDATE` | Prints `bootstrap-ok candidate=…`; stop on failure. |
| Apply through the common transaction (**service interruption**) | `bash /tmp/ran-agent-bootstrap.sh --apply CANDIDATE` | Prints the ordinary transaction result and then `bootstrap-ok`. Retain its snapshot path; any failure auto-rolls back once snapshotting begins. |

The bootstrap validates the exact SHA, rejects every dirty worktree, obtains
only `bootstrap-hermes-release.sh`, `deploy-hermes-release.sh`, and
`resolve-hermes-service-node.sh` from that commit, and checks each source
against `docs/governance/hermes_release_bootstrap.v1.sha256` in the candidate.
It invokes the same `deploy-hermes-release.sh` transaction as normal releases;
there is no second persistent deployment mechanism.

## 1. Deployment Preflight

Run these one at a time from the server. Stop on an unexpected result; do not
repair the checkout with a Git reset.

| Purpose | Command | Expected result / stop condition |
|---|---|---|
| Enter the active checkout | `cd /opt/ran_agent` | The command succeeds. Stop if this is not the production checkout. |
| Record active revision | `git rev-parse HEAD` | One SHA. Keep it with the release record. |
| Record active symbolic ref | `git symbolic-ref -q HEAD || true` | A branch ref or no output for detached HEAD; both are valid observations. |
| Check worktree | `git status --short` | No output. Any output stops the release. |
| Resolve the service Node | `bash scripts/resolve-hermes-service-node.sh` | Prints an absolute Node path from `ran-agent-node.service`; do not substitute interactive-shell `node`. |
| Check the resolved Node | `ABSOLUTE_NODE_PATH --version` | **Need server confirmation:** replace `ABSOLUTE_NODE_PATH` with the previous result; Node must be 22.13 or later. |
| Check Python runtime | `/opt/ran_agent/.venv/bin/python --version` | Python 3.10 or later. Stop otherwise. |
| Check core services | `systemctl is-active ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service` | Each line says `active`. Stop and investigate otherwise. |
| Check filesystem capacity | `df -h /opt /opt/ran_agent /opt/ran_agent-release` | Enough space for a full state snapshot plus candidate archive. Stop if any target is unavailable or space is insufficient. |
| Confirm real environment sources without values | `sudo systemctl cat ran-agent-node.service | sed -n 's/^[[:space:]]*EnvironmentFile=-\\?\\([^[:space:]]*\\).*$/\\1/p'` | One or more owner-readable environment-file paths. Stop if absent. |
| Confirm required secret is nonempty without printing it | `sudo systemctl cat ran-agent-node.service | sed -n 's/^[[:space:]]*EnvironmentFile=-\\?\\([^[:space:]]*\\).*$/\\1/p' | while read -r f; do sudo awk -F= '$1=="RAN_AGENT_INTERNAL_CONTROL_SECRET" && length(substr($0,length($1)+2))>0 {ok=1} END{exit !ok}' "$f" && echo present; done` | At least one `present`. Do not replace this with a command that prints the value. |

Database and durable Node files live under the configured
`RAN_AGENT_RELEASE_STATE_DIR` (normally `/opt/ran_agent/.ran_agent_state`),
with any legacy SQLite files under `/opt/ran_agent/data`. Their exact active
paths are captured in each snapshot manifest; do not infer table names or copy
an individual database while services are running.

## 2. Automatic Backup And Rollback Point

The apply transaction creates one owner-only snapshot under
`/opt/ran_agent-release/snapshots/` and prints it as `snapshot=…`. It records:

- prior code SHA and symbolic ref;
- systemd units/drop-ins, all EnvironmentFile sources actually used by managed
  services, and Hermes homes/profiles;
- service active/enabled state;
- the complete Node durable state directory after managed services stop;
- SQLite/WAL/SHM migration files under `/opt/ran_agent/data`.

`/opt/ran_agent-release` is deliberately outside `STATE_DIR`; do not set
`RAN_AGENT_RELEASE_ARTIFACT_ROOT` or any manual `BACKUP_DIR` beneath the state
directory, or the release fails closed to prevent recursive archives.

| Purpose | Command | Expected result / stop condition |
|---|---|---|
| Check artifact location before deploy | `sudo test ! -e /opt/ran_agent/.ran_agent_state/snapshots && echo separate` | `separate`; if a custom artifact root is used, confirm it is outside the state directory. |
| Verify a printed snapshot later | `sudo test -s SNAPSHOT_DIR/prior-head -a -f SNAPSHOT_DIR/manifest -a -f SNAPSHOT_DIR/services && echo snapshot-ok` | Replace `SNAPSHOT_DIR` with the exact printed path; expect `snapshot-ok`. Stop if not. |

## 3. Formal Main Release

Only use this after the intended code is merged to `origin/main`.

| Purpose | Command | Expected result / stop condition |
|---|---|---|
| Validate main candidate without moving production | `source /opt/ran_agent/.venv/bin/activate && bash scripts/deploy-hermes-main.sh --dry-run` | Prints the resolved SHA and succeeds. A failure leaves `/opt/ran_agent` unchanged; stop. |
| Apply main (**service interruption**) | `source /opt/ran_agent/.venv/bin/activate && bash scripts/deploy-hermes-main.sh --apply` | Prints `apply-ok candidate=SHA snapshot=SNAPSHOT_DIR`. Any failure triggers automatic rollback; retain the printed snapshot and stop. |
| Confirm active SHA | `git rev-parse HEAD` | Equals the `candidate` SHA from apply output. Stop and use rollback if different. |
| Confirm blocking production acceptance | `source /opt/ran_agent/.venv/bin/activate && bash scripts/verify-hermes-release.sh --release` | Prints `blocking-ok`. Failure is a release failure; run explicit rollback. |

The main wrapper runs `git fetch --no-tags origin main`, resolves
`refs/remotes/origin/main` once, and passes that SHA to the common transaction.
It never pre-switches the active checkout.

## 4. Release Candidate

Use a candidate branch only for evaluation. It must not become a permanent
production source.

| Purpose | Command | Expected result / stop condition |
|---|---|---|
| Discover a remote candidate branch | `source /opt/ran_agent/.venv/bin/activate && bash scripts/deploy-hermes-candidate.sh --branch codex/example-candidate --dry-run` | Prints one candidate SHA; the active checkout remains unchanged. Stop on failure. |
| Apply that SHA (**service interruption**) | `source /opt/ran_agent/.venv/bin/activate && bash scripts/deploy-hermes-candidate.sh --branch codex/example-candidate --apply` | Prints candidate and snapshot. Failure auto-rolls back; stop. |
| Apply a specifically reviewed SHA | `source /opt/ran_agent/.venv/bin/activate && bash scripts/deploy-hermes-candidate.sh --commit 0123456789abcdef0123456789abcdef01234567 --apply` | Use only the real reviewed SHA; same transaction and stop rules. |
| Run optional specialty diagnostics | `source /opt/ran_agent/.venv/bin/activate && bash scripts/verify-hermes-release.sh --specialized` | Prints only `specialized-ok` or non-blocking `specialized-warning`; warnings do not change release status but must be recorded. |

The blocking acceptance is `accept-hermes-release.sh` plus strict
`diagnose-proactive-events.sh`: service health, owner binding, bridge paths,
and configured broker journey must pass. `diagnose-lite-full.sh`,
`diagnose-external-mcp-gateway.sh`, and `diagnose-ombre-memory.sh` are
preserved as ordered specialty diagnostics. They are non-blocking because they
cover optional/provider-specific surfaces and may be unavailable by design.
Their detailed output is suppressed by the wrapper to avoid copying local
configuration or credentials into release logs; run an individual diagnostic
only under the server's restricted incident-log policy.

## 5. Difference Record And Acceptance Evidence

Before the staged gate, apply writes an owner-only difference record at
`/opt/ran_agent-release/archives/release-delta.<old-SHA>..<candidate-SHA>.txt`
and copies it into the snapshot. It is a name-status comparison from the live
production SHA to the candidate SHA, covering dependencies, profiles,
configuration templates, systemd/apply scripts, and database/migration paths.
It never compares `candidate^` to `candidate`.

| Purpose | Command | Expected result / stop condition |
|---|---|---|
| Read only changed paths | `sudo sed -n '1,160p' /opt/ran_agent-release/archives/release-delta.OLD..NEW.txt` | Replace `OLD` and `NEW` with actual SHAs. Expect only revision metadata and changed path names; stop if the record is missing. |
| Check services after apply | `systemctl is-active ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service` | All `active`. Otherwise rollback. |
| Read bounded logs | `sudo journalctl -u ran-agent-node.service -n 100 --no-pager` | Review errors only; do not export logs containing user content or secrets. |

## 6. Explicit Complete Rollback

Use rollback after any failed real smoke, missing core service, wrong active
SHA, or accepted release defect. Do not roll back code alone: the command
restores code/ref, configuration, durable Node state, SQLite files, and saved
service enable/active state as one transaction.

| Purpose | Command | Expected result / stop condition |
|---|---|---|
| Validate the snapshot before interruption | `sudo test -s SNAPSHOT_DIR/prior-head -a -f SNAPSHOT_DIR/manifest -a -f SNAPSHOT_DIR/services && echo ready` | Substitute the exact snapshot path; expect `ready`. Stop if not. |
| Restore complete snapshot (**service interruption**) | `bash scripts/deploy-hermes-release.sh --rollback SNAPSHOT_DIR` | Prints `rollback-ok snapshot=… restored=OLD_SHA`. Stop if it fails; do not attempt a partial Git-only restore. |
| Check restored revision | `git rev-parse HEAD` | Equals `OLD_SHA` in rollback output. Stop if different. |
| Check restored core services | `systemctl is-active ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service` | Must match saved service state; investigate any mismatch. |
| Re-run blocking confirmation | `bash scripts/verify-hermes-release.sh --release` | Must print `blocking-ok` when the previous runtime was healthy. |

## 7. Candidate To Main Closure

After a candidate passes real acceptance, merge its reviewed content to main
through the normal GitHub review process. Do not leave production tied to a
`codex-*` branch. Then repeat the **Formal Main Release** steps so the active
checkout is pinned to the immutable SHA resolved from `origin/main`. Record
both the candidate SHA and the final main SHA; they may differ if the merge
commit changes them.

If main deployment fails, use its own printed snapshot rather than reusing the
candidate snapshot. A snapshot belongs to exactly one deployment transaction.

## Server-Site Confirmation Required

The repository test suite uses mock `systemctl` output; it does not claim the
server's unit has been inspected. Before first apply, confirm on the server:

- whether `systemctl show --property=ExecStart --value ran-agent-node.service`
  exposes an absolute `…/node` executable, or `systemctl cat` has a direct
  `ExecStart=/absolute/path/node …` form;
- if neither form exists (for example the unit launches `bash` and resolves
  Node dynamically), provide the service's actual absolute executable only for
  that command: `RAN_AGENT_NODE_BIN=/absolute/path/node bash …`; do not use
  `command -v node` from an interactive shell;
- that the selected executable reports Node 22.13+ and supports `node:sqlite`;
- that the candidate SHA and the bootstrap SHA-256 above are the reviewed
  release values before executing `/tmp/ran-agent-bootstrap.sh`.
