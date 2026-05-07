"""Entrypoint for the minimal HTTP adapter integration."""

from __future__ import annotations

from personal_agent.http_server import run_http_server
from personal_agent.runtime import build_runtime
from personal_agent.scheduler import create_scheduler


def main() -> int:
    """Initialize shared runtime and start the HTTP bridge."""

    runtime = build_runtime()
    runtime.initialize()
    scheduler = create_scheduler(
        runtime.config,
        runtime.database,
        runtime.message_service,
        runtime.logger,
    )
    scheduler.start()
    try:
        return run_http_server(
            config=runtime.config,
            message_service=runtime.message_service,
            logger=runtime.logger,
        )
    finally:
        if scheduler.running:
            scheduler.shutdown(wait=False)


if __name__ == "__main__":
    raise SystemExit(main())
