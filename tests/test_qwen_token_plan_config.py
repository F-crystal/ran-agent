import base64
import os
import re
import struct
import subprocess
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "configure-qwen-token-plan.sh"
VAULT_RUNNER = Path(__file__).resolve().parents[1] / "vault_runner.sh"
QWEN_MM_RUNNER = Path(__file__).resolve().parents[1] / "scripts" / "run-qwen-mm-api-mcp.sh"


def test_token_plan_key_has_one_hidden_prompt_and_transactional_apply() -> None:
    source = SCRIPT.read_text(encoding="utf-8")

    prompt = source.index("现在请粘贴 TOKEN_PLAN_KEY（输入不会显示）")
    hidden_read = source.index("read -r -s TOKEN_PLAN_KEY")
    first_write = source.index('install -m 600 "$WORK_DIR/env.new"')
    assert prompt < hidden_read < first_write
    assert 'TOKEN_PLAN_KEY="$(sed -n' in source
    assert "A-Za-z0-9_-" not in source
    assert "curl --config <(" in source
    encoded_image = re.search(r"data:image/png;base64,([A-Za-z0-9+/=]+)", source).group(1)
    width, height = struct.unpack(">II", base64.b64decode(encoded_image)[16:24])
    assert width > 10 and height > 10
    assert '"max_output_tokens":16' in source
    assert 'NODE_ENV_FILE="$ROOT_DIR/node_bridge/.env.local"' in source
    assert 'install -m 600 "$WORK_DIR/node-env.old" "$NODE_ENV_FILE"' in source
    assert 'install -m 600 "$WORK_DIR/node-env.new" "$NODE_ENV_FILE"' in source
    assert "PERSONAL_AGENT_KNOWLEDGE_AGENT_API_KEY_ENV=TOKEN_PLAN_API_KEY" in source
    assert "APPLIED=true" in source
    assert 'if [[ "$APPLIED" == true && "$SUCCESS" != true ]]' in source
    assert "rollback" in source


def test_vault_runner_checks_the_configured_key_name() -> None:
    source = VAULT_RUNNER.read_text(encoding="utf-8")

    assert "PERSONAL_AGENT_QWEN_API_KEY_ENV" in source
    assert 'API_KEY_VALUE="${!API_KEY_ENV:-}"' in source
    assert 'if [ -z "${DASHSCOPE_API_KEY:-}" ]' not in source


def test_qwen_mm_runner_uses_the_pinned_backend_and_token_plan_env(tmp_path: Path) -> None:
    assert 'export UV_TOOL_BIN_DIR="$STATE_DIR/uv-bin"' in QWEN_MM_RUNNER.with_name("prepare-qwen-mm-api.sh").read_text()
    backend = tmp_path / "uv-tools/qwen-mm-plugins/bin/qwen-mm-plugins-api"
    backend.parent.mkdir(parents=True)
    backend.write_text('#!/bin/sh\nprintf "%s\\n%s\\n" "$DASHSCOPE_API_KEY" "$DASHSCOPE_BASE_URL"\n')
    backend.chmod(0o700)
    (tmp_path / "ready.json").write_text('{"release":"qwen-mm-plugins-api-v1.0.3"}\n')

    result = subprocess.run(
        [QWEN_MM_RUNNER], capture_output=True, check=True, text=True,
        env={**os.environ, "QWEN_MM_STATE_DIR": str(tmp_path), "TOKEN_PLAN_API_KEY": "sk-sp-test"},
    )
    assert result.stdout.splitlines() == [
        "sk-sp-test", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    ]
