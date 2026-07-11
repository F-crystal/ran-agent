"""Regression contract for public-only Xiaohongshu reading."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest


ROOT_DIR = Path(__file__).resolve().parents[1]
SOCIAL_READER = ROOT_DIR / "node_bridge" / "src" / "socialReaderMcpServer.mjs"


@pytest.mark.parametrize(
    "script_name",
    (
        "start_xhs_browse_backend.sh",
        "prepare-xhs-browse-backend.sh",
        "run_xhs_browse_mcp.sh",
        "login_xhs_browse_backend.sh",
    ),
)
def test_retired_account_backed_entrypoints_fail_closed(script_name: str, tmp_path: Path) -> None:
    result = subprocess.run(
        ["/bin/bash", str(ROOT_DIR / "scripts" / script_name)],
        cwd=ROOT_DIR,
        env={
            "PATH": "/usr/bin:/bin",
            "HOME": str(tmp_path),
            "TMPDIR": str(tmp_path),
            "RAN_AGENT_SKIP_ENV_FILE_LOAD": "1",
        },
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode != 0
    assert "XHS_ACCOUNT_BACKED_DISABLED" in result.stderr


def test_model_surface_is_public_only_and_preserves_other_social_readers() -> None:
    program = """
      const module = await import('./node_bridge/src/socialReaderMcpServer.mjs');
      console.log(JSON.stringify({
        tools: module.buildSocialReaderTools().map((tool) => tool.name),
        platforms: [
          module.detectSocialPlatform('https://www.bilibili.com/video/BV1xx'),
          module.detectSocialPlatform('https://mp.weixin.qq.com/s/example'),
          module.detectSocialPlatform('https://music.163.com/song?id=1'),
        ],
      }));
    """
    result = subprocess.run(
        ["node", "--input-type=module", "--eval", program],
        cwd=ROOT_DIR,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["tools"] == [
        "resolve_social_url",
        "read_social_post",
        "read_social_post_deep",
        "read_music_share",
    ]
    assert not any(name.startswith("xhs_browse_") for name in payload["tools"])
    assert "check_social_login" not in payload["tools"]
    assert payload["platforms"] == ["bilibili", "wechat_article", "netease_music"]


def test_public_xhs_fallback_chain_and_sidecar_stay_account_free() -> None:
    source = SOCIAL_READER.read_text(encoding="utf-8")
    chain = source.split("async function readXhsPublicChain", 1)[1].split(
        "function buildXhsPublicParseFailedResult", 1
    )[0]

    steps = (
        "toolName: 'parse_xhs_link'",
        "readXhsDownloaderSidecar",
        "toolName: 'parse_generic_link'",
        "readXhsHtmlPublicFallback",
    )
    assert [chain.index(step) for step in steps] == sorted(chain.index(step) for step in steps)
    assert "download: false" in source
    assert "cookie: ''" in source
    assert "public_only: true" in source
    assert "account_backed: false" in source
    assert (
        "fallback_chain: ['wanyi_watermark', 'xhs_downloader_public_sidecar', "
        "'wanyi_generic', 'html_public_fallback', 'partial']"
    ) in source


def test_public_fallbacks_remain_enabled_in_deployment_template() -> None:
    env_example = (ROOT_DIR / ".env.example").read_text(encoding="utf-8")

    assert "SOCIAL_READER_GENERIC_FALLBACK_ENABLED=true" in env_example
    assert "XHS_PUBLIC_SIDECAR_ENABLED=true" in env_example
    assert "XHS_PUBLIC_HTML_FALLBACK_ENABLED=true" in env_example
    assert "# XHS is public-only. Do not configure XHS_COOKIE" in env_example
