# OpenClaw Security Boundary (Personal System)

This project uses a strict workspace boundary for OpenClaw frontend integration.

## Workspace scope

- Allowed workspace root: this repository checkout.
- OpenClaw state dir must stay inside the workspace.
- Default state dir: `.openclaw_state/`
- Reading and writing outside workspace is forbidden.
- Cross-repo and cross-project access is forbidden.

## Permission levels

### Default allowed

- Read project files
- Edit project files
- Write project files
- Read project logs and runtime state files

### Cautious (owner-only and confirmation recommended)

- Shell execution
- Multi-file changes
- Runtime-impacting changes
- Scheduler/outbound/channel config changes
- OpenClaw config changes

### Default denied (or explicit owner confirmation required)

- File/directory deletion
- Recursive delete or directory purge
- Cross-workspace operations
- Home directory unrelated access
- Credential/token/auth file mutation
- Elevated execution

## Channel and command boundary

- `allowFrom`: owner only
- `ownerAllowFrom`: owner only
- `commands.allowFrom`: owner only
- High-risk commands are disabled by default and require explicit owner confirmation.

## Skills and sub-agent boundary

- Skills must only read/write inside this project workspace.
- Skills must not browse arbitrary home directories.
- Knowledge skill must not treat the vault as arbitrary filesystem traversal.
- Future sub-agents inherit the same workspace restriction.
