# Hermes Immutable Release Deployment

Status: CURRENT (2026-08-01)

`USER_SUPPLIED_RUNTIME`: the known production repository SHA is
`bb66f1e6a8a400d599c7f86139107742bbedddc8`; this local O1 line has not
revalidated it online. The owner-supplied 2026-07-31 preflight reported a clean
worktree and all four core units active. Ombre O1 baseline
`1be3ee58919fb01f1c442d75ba2463e237fba0b2` is archived but undeployed. The
V4+O1 baseline `c52f8ba9b26338204e8ae189d1f1df5f3800e630` is archived and
pushed but undeployed. Node Receipt is deferred. O2 implementation
`a978444fc94f21c7d84df1e65e6fa8a8eb7dfdd7` passed independent v0.7
implementation review and is archived and pushed to `main`, but remains
undeployed. The current reviewed line adds owner-authorized production wiring:
source remains fail-off, while the formal release defaults to Flash with O2
enabled (Gate 5 not started or authorized; `total_delete` typed unsupported).
Package B.2/B.3 have not started.

This is the production deployment contract for `/opt/ran_agent`. A branch is
only a way to discover a release; the deploy unit is always one immutable
40-character commit SHA. The transaction uses **stage-and-switch** (option A):
it archives the SHA to `/opt/ran_agent-release/stages`, gates that stage,
snapshots the active checkout and runtime, then changes `/opt/ran_agent` only
inside the transaction. This is smaller and safer than adding a second
worktree/service-pointer topology to the existing systemd deployment.
The staged checkout is source-only. Persistent runtime state is resolved once
as `/opt/ran_agent/.ran_agent_state` (or the explicit
`RAN_AGENT_RELEASE_STATE_DIR`) and is passed separately to every apply,
acceptance, diagnostic, and rollback step.

Never run `git pull`, `git switch`, `git checkout`, `git reset`, or `git
clean` as a pre-deploy action in `/opt/ran_agent`.

## Release Lineage

The owner-supplied known production repository revision is
`bb66f1e6a8a400d599c7f86139107742bbedddc8`. Candidate
`834eabef5a2e8883d3237f7b35c96f70d1fac7a9` passed dry-run but its apply
stopped at the immutable pre-mutation gate because a provider-boundary test
named a desktop-only Hermes path. The transaction had not snapshotted state,
stopped services, activated code, or mutated runtime, so no rollback was
required. Keep later server acceptance evidence and snapshots in private
archives rather than copying them into this public contract.

Candidate `f6f6048029de6e4c73b5b8b11f1441069770786c` then reached the next
gate layer and stopped because release-test fixtures still assumed source Git
metadata and non-root `sudo` selection. It also failed before snapshot or
mutation. Deployable release tests must receive the candidate SHA and
privilege seam explicitly and remain valid under Git-less, read-only,
root/non-root, `env -i` execution as required by the repository `AGENTS.md`.
The remediated staged gate also fixes host-dependent temporary-directory group
inheritance, nested-shell state-directory leakage, and Python tests that found
Hermes only through an interactive `PATH`. Before another deployable candidate
is produced, the complete local staged `--all` gate must end with 378/378
Python tests, `hermes-release-smoke: all-ok`, and
`hermes-release-gate: ok`; an ordinary checkout test pass is not equivalent.

Candidate `8ff3ce43d6b90bf6f972a8293b83a912e5f9cb77` reached the O1 contract
tests and stopped because that test file ignored the gate-provided
`RAN_AGENT_PYTHON_BIN` and named a desktop-only Python executable. On the
server every contract subprocess therefore returned a spawn failure. This was
also an immutable pre-mutation gate failure: no snapshot, service interruption,
checkout activation, runtime mutation, rollback, Hermes upgrade, or model
switch occurred. The corrected test consumes the validated explicit Python
input, fails clearly on spawn errors, and has a regression assertion excluding
developer-machine paths.

Candidate `62fca911a09ea7246393cdedece048ee91b4abb5` then passed release smoke but
stopped in the immutable Python gate because the provider tests treated the
Hermes `Project:` source path as a virtual-environment path. On this host the
service-managed Hermes executable is under `/opt/ran_agent/.venv/bin` while its
editable source project is elsewhere; those paths are not required to share a
parent. The corrected gate derives the Hermes runtime Python from the verified
Lite/Full service executable's sibling, validates its provider imports, and
passes it explicitly to both provider tests and the acceptance diagnostic. A
missing runtime interpreter or service drift now fails before mutation. This
does not upgrade Hermes v0.13 or switch the Flash model.

Candidate `414210f238215d0f8ef83175851b5ed311ad5d06` passed the complete immutable
gate, then stopped because the Steward identity verifier treated
`/etc/login.defs` allocation defaults as authority over an existing account.
The transaction reported `rollback-complete`, including optional-unit restore
handling, so the active production revision remained unchanged. The corrected
verifier leaves allocation to `groupadd --system` and `useradd --system`, then
validates the resulting or pre-existing account directly: non-root numeric
UID/GID, exact NSS/passwd/group agreement, frozen home and nologin shell, fixed
systemd names, and matching live process effective identity. It no longer
depends on host-specific `login.defs` contents.

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

During O1 candidate apply the staged `apply-hermes-runtime-split.sh
--preserve-runtime-shape` path also installs and verifies the pinned Ombre
upstream and recall-adapter units before Python/Lite/Full/Node. That apply step
does not use an interactive-shell `hermes`. Before mutation, the staged gate
resolves the installed Hermes v0.13 executable from both Lite and Full systemd
units in a clean, bounded environment, requires both units to resolve to the
same canonical executable, and binds the isolated real provider-boundary test
to that executable plus the `python` in the same service venv. The `Project:`
field reported by Hermes identifies source only and is never used to infer the
runtime venv. A missing interpreter, incompatible provider import closure,
mismatched service runtime, or non-v0.13 Hermes stops the release; it is not
repaired or upgraded implicitly. The ordinary non-preserve
drift-repair path still requires Hermes because it installs profiles and writes
Hermes units.

For the current Flash+O1+O2 candidate, that same preserve path converges the
four installed Lite/Full model blocks, six non-secret model-policy environment
keys, the shared DeepSeek provider plugin, and the managed O2 Node environment.
It retains the O1 recall-only MCP shape, identity projection, startup ordering,
rollback state machine, and retention policy. The snapshot includes both
installed provider plugin trees and all effective environment sources;
rollback restores the prior configs/env/plugin/O2 state together and remains
fail-loud if any restore stage fails.

V4 Pro remains an explicit evaluation input to the same transaction through
`RAN_AGENT_DEPLOY_HERMES_MODEL=deepseek-v4-pro`. Acceptance proves the selected
identifier and disabled-thinking final HTTP body for Lite and Full. This does
not create a second deployment or rollback state machine.

Before either bootstrap or normal apply snapshots/switches production, the
complete candidate archive provides `hermes-release-candidate-preflight.mjs`.
That stage-local code imports the candidate `identityMap.mjs`, not the active
checkout. On a real server dry-run it also reads the identity-map path from the
existing Node service EnvironmentFile and performs the owner-binding check
without printing the path, identity, hash, or secret. A missing owner binding
or incompatible candidate module therefore fails dry-run before service,
state, code, or checkout mutation.

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

O2 uses exactly one service identity: `ran-agent:ran-agent`. The privileged
apply path creates that system account/group when absent, rejects malformed or
conflicting existing identities, and installs effective `User=ran-agent` and
`Group=ran-agent` for Node and the patched Ombre source runner only. Legacy
runtime-user variables are consistency assertions and cannot override this
identity. Creation uses the host system-account entry points with the frozen
home `/opt/ran_agent` and shell `/usr/sbin/nologin`; an existing account must
have nonzero numeric UID/GID that agree across `id`, passwd, and group NSS
records, with its primary GID equal to the `ran-agent` group GID. The verifier
does not reinterpret `/etc/login.defs`: those values govern ID allocation by
the system account tools, not the authority of an already resolved account.
Any identity, home, shell, systemd, or live-process mismatch remains blocking.
Lite and Full retain their separately configured identity.

The transaction also refuses to begin if its private
`98-ombre-steward-rotation.conf` drop-in already exists or is a broken symlink.
This prevents an interrupted or foreign residue from being overwritten and
then silently removed during rollback.

## 2. Automatic Backup And Rollback Point

The apply transaction creates one owner-only snapshot under
`/opt/ran_agent-release/snapshots/` and prints it as `snapshot=…`. It records:

- prior code SHA and symbolic ref;
- systemd units/drop-ins, all EnvironmentFile sources actually used by managed
  services, and Hermes homes/profiles;
- Lite/Full DeepSeek provider plugin trees and all four installed model configs;
- service active/enabled state;
- the complete Node durable state directory after managed services stop,
  excluding `ombre-compat/secrets`;
- SQLite/WAL/SHM migration files under `/opt/ran_agent/data`.

The transaction resolves one canonical live state directory from
`RAN_AGENT_RELEASE_STATE_DIR`, defaulting to
`/opt/ran_agent/.ran_agent_state`. The patched checkout/home and Steward token
then exist only at `${RAN_AGENT_STATE_DIR}/ombre-brain` and
`${RAN_AGENT_STATE_DIR}/ombre-compat/secrets/steward-api-token`; an explicit
`OMBRE_BRAIN_HOME` that disagrees is rejected. The token is a non-symlink
regular file owned by `ran-agent:ran-agent` with mode `0600`.
Rotation first disables O2 ingress and stops Node, then saves the old token in
a root-owned `0700` transaction directory under
`/run/ran-agent-release-secrets`, atomically installs the new token, restarts
and authenticates Ombre, clears the temporary block, restarts Node with the
managed O2 posture, and runs read-only acceptance. That private
copy is never placed in a retained snapshot, manifest, archive, or release
record and is destroyed immediately after acceptance. On failure, ingress
remains disabled while files, state, code, and the old token are restored; the
temporary block is then cleared before the saved service active/inactive state
is restored. Any failed stage retains the `rollback-incomplete` fail-loud
result.

The services manifest additionally records each unit's systemd load state.
Retired optional units such as `ran-agent-xhs-browse.service` may therefore be
recorded as `not-found`. Rollback and quiescing skip an optional unit that was
absent at snapshot time (including legacy three-column manifests after a
current load-state check), rather than attempting to create, enable, stop, or
restart it. This preserves the public-only XHS sidecar/fallback topology and
does not restore the retired account-backed browse service.

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

Before the broker journey, blocking acceptance waits independently for the
lite and full Hermes `/v1/models` gateways. Each bounded attempt verifies the
unit remains active, reads that unit's current MainPID environment, prefers
`HERMES_API_KEY` and falls back only to `API_SERVER_KEY`, then requires an
authenticated HTTP 200. Connection failures and 5xx responses retry for at
most 120 seconds (two-second interval by default); 401/403, a missing key, an
invalid MainPID, or an inactive unit fails closed immediately. The bearer value
is written only to an owner-only temporary header file passed by filename to
curl, then removed on success, failure, or signal; it is never printed or put
in curl argv. `RAN_AGENT_RELEASE_GATEWAY_READY_TIMEOUT_SECONDS` and
`RAN_AGENT_RELEASE_GATEWAY_READY_INTERVAL_SECONDS` provide bounded operator
overrides.

Blocking acceptance also checks Node and Ombre effective systemd
`User`/`Group`, and each live MainPID's effective numeric UID/GID from
`/proc/<MainPID>/status` against `id -u/-g ran-agent`. It rechecks MainPID and
numeric identity to reject process exit or drift. Apply startup, final
acceptance, and rollback recovery use the same verifier. Acceptance also
checks their common canonical token path,
the token owner/mode/type contract, authenticated health with the new token,
rejection of the prior token, absence from the staged checkout and ordinary
snapshot/archive artifacts, and the root-only in-flight rollback directory.
For active O2 it additionally verifies canonical compatibility state/identity
paths, exact DeepSeek endpoint/model values, a nonempty shared provider key,
and `ran-agent:ran-agent:0700` state ownership without making a model or memory
write canary. Any mismatch fails the release and restores the snapshot's prior
O2 posture without weakening O1 recall-only behavior.

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
  Node dynamically), use the confirmed production executable
  `/opt/nodejs/node-v22.22.2-linux-x64/bin/node` as `RAN_AGENT_NODE_BIN` for the
  deploy command; do not use `command -v node` from an interactive shell;
- that the selected executable reports Node 22.13+ and supports `node:sqlite`;
- that the candidate SHA and the bootstrap SHA-256 above are the reviewed
  release values before executing `/tmp/ran-agent-bootstrap.sh`.
