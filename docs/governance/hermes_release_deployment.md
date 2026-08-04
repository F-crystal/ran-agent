# Hermes Immutable Release Deployment

Status: CURRENT (2026-08-04)

`USER_SUPPLIED_RUNTIME`: the 2026-08-03 apply attempt for candidate
`e85301fef053dd02d920af61fa5db01f2b381d3b` stopped before service mutation
because the old checkout did not contain the transitive-only
`@mozilla/readability` package. The active server SHA has not been re-observed
after that failure. The current release line declares the complete direct Node
runtime dependency closure, installs it from the candidate lock before the
snapshot boundary, and switches it with the candidate checkout. Ombre O1 baseline
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
it archives the SHA to `/opt/ran_agent-release/stages`, verifies the immutable
stage, and gates an identical root-owned read-only copy of that stage placed
under a traversable parent, because the artifact store itself stays
root-private (`0700`) and the `ran-agent` acceptance identity cannot traverse
it. The transaction then snapshots the active checkout and runtime, and
changes `/opt/ran_agent` only inside the transaction. This is smaller and safer than adding a second
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
is produced, the complete local staged `--all` gate must have no failures, any
skip must be an explicit server/root-only check, and it must end with
`hermes-release-smoke: all-ok` and `hermes-release-gate: ok`; an ordinary
checkout test pass is not equivalent.

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

Candidate `7649a9471b15b09e9aac25bed269a0e5d8b254dc` passed the immutable gate
and reached Ombre startup, then stopped before dependent services because the
startup contract obtained MainPID through `sudo systemctl` but socket process
metadata through unprivileged `ss -p`. A deployment account cannot reliably see
another service account's socket PID, so the ownership predicate could reject a
healthy listener. The corrected startup, acceptance, failure-context, and
specialty-diagnostic probes obtain socket metadata through the existing
privilege seam and keep the strict MainPID ownership requirement. The supplied
trace does not include the transaction's final rollback result; do not infer an
active candidate from it.

Candidate `8c259ddcd2a34e80400ac39e444876807960f689` then passed the immutable
gate and prepared the pinned Ombre 2.8.8 source, but the managed unit exited
before it acquired a PID or listener. The owner-supplied trace records
`rollback-complete`, so production again remained on the recorded SHA. The
root cause was not Ombre's health API: the `ran-agent` unit launched a wrapper
that re-read deployment-user `0600` repository env files under `set -e` and
exited on permission denial. The managed launcher now receives only explicit
validated argv/systemd inputs and never re-sources repository env files.
Preparation follows the exact upstream 2.8.8 commit, its hashed
`requirements.lock.txt`, and explicit `OMBRE_TRANSPORT=streamable-http` as
documented by the [pinned official README](https://github.com/P0luz/Ombre-Brain/blob/0e83d4671ce1629e03ad36bb9160235bf60dbd34/README.md).

Repeated failed transactions also copied the large live Ombre source, venv,
and cache state into each rollback payload. Completed `rollback_used`
transactions and legacy published directories without transaction state were
previously retained indefinitely, contributing to the
owner-reported disk pressure; the failed trace showed `54GB/59GB` used and
`3.3GB` available, while removal of seven state-less transactions reclaimed
about 15.7 GiB and restored 19GB available. The reviewed transaction now
classifies and
removes completed rollback payloads while preserving evidence and removes only
state-less final transaction directories that cannot be rollback authority;
corrupt-state, mounted, symlinked, current-production, or concurrently changing
snapshots remain untouched. Immediately after that staged prune, a mandatory capacity
gate measures allocated blocks and inodes for every snapshot source, including
the duplicated SQLite migration evidence, reserves candidate staging, and adds
the larger of 25% or 2 GiB byte headroom plus inode headroom. An insufficient
result stops before snapshot creation or service interruption.

The release lock is a root-owned `flock` acquired through a caller-owned FIFO,
so an `ubuntu` bootstrap never asks root to overwrite an unprivileged `/tmp`
regular file. Candidate and rollback checkouts run with `umask 022`; every
tracked regular file and parent directory is then verified against the Git
mode and `ubuntu` ownership contract. Historical root-owned restrictive paths
are repaired through no-follow file descriptors and revalidated, and the
actual Node entry plus dynamic dependencies are imported as `ran-agent` from
the read-only gate copy before runtime apply. The full Git-less gate executes
that verified copy under both root and `ran-agent`; a same-user local pass is
not deployable evidence.

A later server root gate failed five release-script tests before transaction
mutation because their identity-sensitive fixtures inherited the root gate's
private temporary tree and, in two cases, root EUID while modeling `ubuntu`
checkout actions. This was a test-fixture portability defect, not permission
drift in `/opt/ran_agent`. Such fixtures now use randomized literal `/tmp`
roots, explicitly establish owner and traversal modes, run checkout operations
as `ubuntu`, and pass `/tmp` explicitly to the cross-UID lock child. Do not
weaken the production root/`ubuntu`/`ran-agent` boundaries to make a fixture
pass. The corrected candidate still requires a fresh Linux-root staged gate
before apply.

Candidate `3ba6d712ceb464bcbb3068617212979c02bd0e9e` passed the root gate from
a manual `/tmp` extraction, but its apply stopped before snapshot, service, or
checkout mutation when the second pre-mutation gate ran as `ran-agent`: the
immutable stage lives under the root-private `0700` artifact store, so the
runtime identity received `Permission denied` before opening the gate script.
The release tests had masked this boundary by chmodding fixture artifact
parents to `0711`, proving a permission topology production never allows. The
reviewed transaction now extracts a second, secret-free copy of the verified
candidate archive under `/tmp`, seals it root-owned and read-only, proves it
byte-identical to the verified stage, and runs both the root and the
`ran-agent` gates plus the pre-mutation module-loadability probe against that
same copy; the copy is removed on every transaction outcome. The gate
filesystem is budgeted twice — an upfront estimate covering the copy and the
node_modules projection, and a measured check after dependency installation —
so a full disk stops the transaction before, not during, a copy. The copy is
also probed as the `ran-agent` identity for readability and non-writability
before the expensive root gate runs. The Linux-root regression keeps the
artifact store at `0700`, proves the stage unreadable to `ran-agent`, proves
the copy readable yet unwritable, and executes both gates before any runtime
write. A follow-up `ran-agent` gate rehearsal exposed an identity-map
test-isolation leak: the default identity map path bypassed every sandbox, so
root gates read production state silently while `ran-agent` received
`EACCES`; the isolated test env and the gate env matrix now pin
`RAN_AGENT_IDENTITY_MAP_PATH` into each sandbox. The same rehearsal then
reached the Hermes runtime resolution: the production v0.13 runtime is
editable-installed from the ubuntu home and unreadable to `ran-agent`, an
identity that never executes Hermes in production. A full classification of
the suite found five checks that require a non-`ran-agent` identity: the
provider-boundary and DeepSeek provider checks (ubuntu-owned Hermes
runtime), plus `hermesModelCutover`, `searchHubApplyScript`, and
`ombreCompatProductionWiring` (root-only apply tooling that chowns to the
ubuntu runtime user). The `ran-agent` gate carries an explicit flag that
prints a reasoned skip for exactly these five — all mandatory in the root
gate and in acceptance, both pinned off against environment inheritance —
while every other check still executes as `ran-agent`; unlisted files always
run.

`--apply` and `--rollback` interrupt the four core services and any active
managed optional service briefly. The verified payload-prune apply deletes only
classified completed rollback payloads. `git fetch` updates local remote
tracking objects only; the remaining observation and dry-run steps are
read-only.

## 0. First Enablement Bootstrap

Use the enablement steps when the active checkout predates the deployment entry
scripts. They extract a small, verified framework from the already-fetched
candidate into a private temporary directory; they do not add files to
`/opt/ran_agent`, switch HEAD, or make the production worktree dirty. Normal
later releases use the main/candidate entries below; explicit rollback reuses
the same candidate-extracted bootstrap authority so recovery never depends on
the checkout revision being restored.

| Purpose | Command | Expected result / stop condition |
|---|---|---|
| Enter the checkout | `cd /opt/ran_agent` | Stop if this is not the active production checkout. |
| Activate the managed Python environment | `source /opt/ran_agent/.venv/bin/activate` | The command succeeds. |
| Confirm the old checkout is clean | `git status --short` | No output. Any output stops bootstrap. |
| Fetch only the reviewed candidate object | `git fetch --no-tags origin codex/hermes-dual-spec-implementation` | Fetch succeeds; production HEAD and files remain unchanged. |
| Resolve its immutable SHA | `git rev-parse --verify refs/remotes/origin/codex/hermes-dual-spec-implementation^{commit}` | Record the full SHA as `CANDIDATE`; stop on failure. |
| Extract the bootstrap source outside the checkout | `git show CANDIDATE:scripts/bootstrap-hermes-release.sh > /tmp/ran-agent-bootstrap.sh` | Replace `CANDIDATE` with the recorded SHA. Only `/tmp` changes. |
| Verify bootstrap source digest | `printf '%s  %s\n' 'b6800f3e23e7c448c463c4b9c52e4e16dbb5a662d28bc28551251d08fce0bb3b' /tmp/ran-agent-bootstrap.sh | sha256sum -c -` | Expect `OK`. Stop on any mismatch; do not execute the file. |
| Make the temporary file owner-only | `chmod 700 /tmp/ran-agent-bootstrap.sh` | Succeeds. |
| Validate the staged framework without service interruption | `bash /tmp/ran-agent-bootstrap.sh --dry-run CANDIDATE` | Prints `bootstrap-ok candidate=…`; stop on failure. |
| Apply through the common transaction (**service interruption**) | `bash /tmp/ran-agent-bootstrap.sh --apply CANDIDATE` | Prints the ordinary transaction result and then `bootstrap-ok`. Retain its snapshot path; any failure auto-rolls back once snapshotting begins. |

The bootstrap validates the exact SHA, rejects every dirty worktree, obtains
only the six files named by
`docs/governance/hermes_release_bootstrap.v1.sha256` from that commit, and
checks every source against that candidate-owned manifest.
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

Apply and explicit rollback hold one non-blocking global release lock from
their first artifact/pointer read through success or rollback cleanup. Apply
also requires a concrete Python 3.12 executable and all real-process gate
assets before snapshot, service interruption, or checkout activation. The
immutable pre-mutation gate runs in `code-only` mode and forbids live Ombre
inputs; after prepare, a required real-process gate runs the pinned source,
venv, Git, patch, and server probes as `ran-agent`, never as root. Root remains
only the transaction/ownership orchestrator and does not execute bytes writable
by the service account.

## 0.1 Completed Rollback Payload Recovery

Use the repository script only. Do not delete snapshot directories or `files/`
trees by hand.

| Purpose | Command | Expected result / stop condition |
|---|---|---|
| Inspect reclaimable payloads after the script is active | `sudo bash scripts/prune-hermes-release-artifacts.sh --dry-run` | Use only after this reviewed script exists in the active checkout. Only completed, verified `rollback_used` snapshots may say `PRUNE_PAYLOAD`; current production and uncertain state must say keep/skip. Stop on any error. |
| Reclaim verified payloads after the script is active | `sudo bash scripts/prune-hermes-release-artifacts.sh --apply` | Use only after this reviewed script exists in the active checkout. Removes only each eligible `files/` payload. Transaction state, manifest, service evidence, and other audit files remain. |
| Observe capacity | `df -h /opt /opt/ran_agent /opt/ran_agent-release` | Record the usage. A low pre-prune value is not the final decision: bootstrap/apply first reclaims only verified payloads, then its mandatory gate decides whether a complete new snapshot plus headroom fits. Do not delete uncertain artifacts manually. |

The old production checkout does not contain this script, and `git fetch` does
not place candidate files in the worktree. Its immediate recovery authority is
the reviewed bootstrap/apply path: that transaction runs the candidate-staged
pruner while already holding the global release lock and before creating its
new snapshot. A fresh post-prune capacity gate then either proves enough space
or stops before any snapshot copy, service stop, or checkout change. The
transaction can therefore recover eligible failed payloads without first
making another large state copy, while still failing safely if recovery is not
enough.

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
| Check the resolved Node | `ABSOLUTE_NODE_PATH --version` | **Need server confirmation:** replace `ABSOLUTE_NODE_PATH` with the previous result; Node must be 22.19 or later. |
| Check Python runtime | `/opt/ran_agent/.venv/bin/python --version` | Python 3.10 or later. Stop otherwise. |
| Check core services | `systemctl is-active ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service` | Each line says `active`. Stop and investigate otherwise. |
| Observe filesystem capacity | `df -h /opt /opt/ran_agent /opt/ran_agent-release` | Record the value and stop if a target is unavailable. The apply transaction's post-prune capacity gate is authoritative; it may reclaim verified completed payloads first and otherwise fails before interruption. |
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

Every `present` or `migration-present` entry is committed only after its copy
finishes in a temporary path and is atomically renamed inside the snapshot.
The complete durable-state tar follows the same rule. A partial cp/tar result
therefore never enters the manifest and rollback never treats it as authority.
After services stop and the Node/state-migration payloads are added, apply
atomically rewrites the in-progress transaction state with the final manifest
digest and verifies the complete published snapshot again. Candidate checkout
cannot begin while that quiesced rollback authority is stale or incomplete.

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
After a complete rollback, the transaction marks the snapshot
`rollback_used`, runs the verified payload pruner, and retains the small
evidence files. Successful apply performs this cleanup before the next large
snapshot, runs the mandatory headroom gate, and later retains only the
configured accepted rollback points.

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

Ombre listener ownership checks must run `ss -ltnp` through the same privilege
seam used for `systemctl show MainPID`; an unprivileged process view is not
authoritative across the `ubuntu` deployment account and `ran-agent` service
account. Startup remains bounded and reports separate active, PID-valid,
MainPID-listener, and HTTP-health results before dependent services start.

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
| Read the immutable controller SHA | `CANDIDATE="$(sudo cat SNAPSHOT_DIR/candidate)" && git cat-file -e "$CANDIDATE^{commit}"` | Substitute the exact snapshot path. Stop if the value is not one local 40-hex commit. |
| Extract rollback bootstrap outside the checkout | `git show "$CANDIDATE:scripts/bootstrap-hermes-release.sh" > /tmp/ran-agent-rollback-bootstrap.sh && chmod 700 /tmp/ran-agent-rollback-bootstrap.sh` | Succeeds without changing HEAD or the worktree. Stop on failure. |
| Restore complete snapshot (**service interruption**) | `bash /tmp/ran-agent-rollback-bootstrap.sh --rollback "$CANDIDATE" SNAPSHOT_DIR` | Prints `rollback-complete …` and `bootstrap-ok`. On interruption, rerun this exact command; do not invoke the restored checkout's older deploy script or attempt a partial Git-only restore. |
| Check restored revision | `git rev-parse HEAD` | Equals the snapshot's `prior-head`. Stop if different. |
| Check restored core services | `systemctl is-active ran-agent-python.service ran-agent-node.service ran-agent-hermes.service ran-agent-hermes-full.service` | Must match saved service state; investigate any mismatch. |
| Re-run blocking confirmation | `bash scripts/verify-hermes-release.sh --release` | Must print `blocking-ok` when the previous runtime was healthy. |

An interrupted explicit rollback keeps the accepted snapshot and production
pointer eligible. The candidate-extracted bootstrap remains the recovery path
even after code restoration changes the active checkout. If restoration
finished but pointer cleanup was interrupted, the same command recognizes the
verified `rollback_used` state, finalizes the stale pointer, and runs governed
payload cleanup without restoring twice.

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
- that the selected executable reports Node 22.19+ and supports `node:sqlite`;
- that the candidate SHA and the bootstrap SHA-256 above are the reviewed
  release values before executing `/tmp/ran-agent-bootstrap.sh`.
