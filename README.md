# Ran Agent

Ran Agent is a local-first personal agent runtime for a single-user WeChat setup.
It is shared as an implementation reference: OpenClaw is the visible chat agent, Node connects WeChat to OpenClaw, and the Python backend provides memory, knowledge, reflection, todo, and scheduler capabilities.

This is not a hosted SaaS product or a production-ready multi-user bot. Treat it as a template and a set of ideas you can adapt for your own private agent.

## Who This Is For

- You want to study how a personal agent can combine chat, memory, knowledge maintenance, reminders, and MCP tools.
- You are comfortable configuring Node, Python, OpenClaw, local env files, and model provider credentials.
- You want a private, owner-only system that runs on your own machine or server.

## Who This Is Not For

- People looking for a one-click chatbot.
- Teams looking for multi-tenant SaaS, customer service automation, or enterprise permission isolation.
- Anyone planning to commit runtime state, chat logs, cookies, tokens, or personal vault content into Git.

## Architecture

```text
WeChat
  -> node_bridge/
  -> OpenClaw agent runtime
  -> Claude-compatible model provider
  -> reply back through node_bridge/

Python backend
  -> /health, /ingest, /tools/*
  -> SQLite state
  -> memory, knowledge, reflection, todo, night-cycle jobs
```

The normal WeChat text path uses OpenClaw's agent runtime. The OpenAI-compatible chat-completions path is kept only as a compatibility surface for structured media cases and backend capability calls.

## Main Pieces

- `openclaw/`: OpenClaw local configuration and runtime boundary.
- `node_bridge/`: WeChat bridge, message merging, outbound delivery, media handling, and MCP facade servers.
- `src/personal_agent/`: Python backend services, state layer, scheduler jobs, memory, knowledge, and reflection code.
- `skills/`: On-demand operational skills used by the runtime and agents.
- `vault/`: Template structure for local knowledge work. Real `vault/inbox`, `vault/raw`, and `vault/wiki` content must stay private.
- `docs/governance/`: Current constraints and runtime status.

## Quick Start

Install Node dependencies:

```bash
npm install
```

Create a Python environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Create `.env.local` in the repo root. At minimum, OpenClaw needs a Claude-compatible provider:

```bash
ANTHROPIC_BASE_URL=...
ANTHROPIC_AUTH_TOKEN=...
OPENCLAW_GATEWAY_TOKEN=...
TAVILY_API_KEY=...
```

Knowledge maintenance and media generation may also need `DASHSCOPE_API_KEY` or `QWEN_API_KEY`, depending on which paths you enable.

## Run Locally

Start each service in a separate terminal:

```bash
./start_openclaw.sh
```

```bash
./start_python.sh
```

```bash
cd node_bridge
./start_node.sh
```

Stop each process with `Ctrl+C`. Runtime logs and state are local-only.

## Test

```bash
PYTHONPATH=src python -m unittest discover -s tests -p 'test_*.py'
```

```bash
npm --prefix node_bridge test
```

```bash
./scripts/connectivity_smoke.sh
```

## Privacy Rules

Never publish these paths:

- `.env.local`, `node_bridge/.env.local`, or any `.env.*` file
- `.openclaw_state/`
- `data/`
- `logs/`
- `debug/`
- `state/`
- `local_archive/`
- `vault/inbox/`, `vault/raw/`, `vault/wiki/`
- `node_modules/`
- `.venv/`
- `*.db`, `*.sqlite`, `*.sqlite3`

Before making a repo public, run `git status --short --ignored` and a secret scan. Public commits should include source code, templates, and docs only, not private runtime data.

## License

This project uses the PolyForm Noncommercial License 1.0.0. Personal learning, research, and noncommercial use are allowed. Commercial use is not granted.

See `LICENSE.md`.
