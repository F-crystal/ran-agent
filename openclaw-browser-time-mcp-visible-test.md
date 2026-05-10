# OpenClaw 浏览器和时间 MCP 可见性测试

生成时间：2026-05-07T00:59:21+08:00

## MCP list
```text
{
  "playwright": {
    "command": "bash",
    "args": [
      "scripts/start_playwright_mcp.sh"
    ]
  },
  "time": {
    "command": "bash",
    "args": [
      "scripts/start_time_mcp.sh"
    ],
    "env": {
      "LOCAL_TIMEZONE": "Asia/Shanghai"
    }
  },
  "media_generation": {
    "command": "bash",
    "args": [
      "scripts/start_media_generation_mcp.sh"
    ]
  }
}
```

## Agent explicit test
```text
{
  "runId": "b32db69d-5161-453a-8f02-68ae3ec73d37",
  "status": "ok",
  "summary": "completed",
  "result": {
    "payloads": [
      {
        "text": "BROWSER_MCP_VISIBLE\n\n我可以看到 Playwright/browser MCP 工具（如 `playwright__browser_navigate`、`playwright__browser_click`、`playwright__browser_snapshot` 等）和 time MCP 工具（`time__get_current_time`、`time__convert_time`）。",
        "mediaUrl": null
      }
    ],
    "meta": {
      "durationMs": 17068,
      "agentMeta": {
        "sessionId": "1601cbb4-4e9d-4321-9c33-5f4a60ab41f3",
        "provider": "claude_code",
        "model": "qwen3.5-plus",
        "usage": {
          "input": 6,
          "output": 247,
          "cacheWrite": 7569,
          "total": 7822
        },
        "lastCallUsage": {
          "input": 6,
          "output": 247,
          "cacheRead": 0,
          "cacheWrite": 7569,
          "total": 7822
        },
        "promptTokens": 7575
      },
      "aborted": false,
      "systemPromptReport": {
        "source": "run",
        "generatedAt": 1778086782741,
        "sessionId": "1601cbb4-4e9d-4321-9c33-5f4a60ab41f3",
        "sessionKey": "agent:main:explicit:browser-time-mcp-visible-test",
        "provider": "claude_code",
        "model": "qwen3.5-plus",
        "workspaceDir": "/opt/ran_agent/main",
        "bootstrapMaxChars": 20000,
        "bootstrapTotalMaxChars": 150000,
        "bootstrapTruncation": {
          "warningMode": "once",
          "warningShown": false,
          "truncatedFiles": 0,
          "nearLimitFiles": 0,
          "totalNearLimit": false
        },
        "sandbox": {
          "mode": "off",
          "sandboxed": false
        },
        "systemPrompt": {
          "chars": 8989,
          "projectContextChars": 739,
          "nonProjectContextChars": 8250
        },
        "injectedWorkspaceFiles": [
          {
            "name": "AGENTS.md",
            "path": "/opt/ran_agent/main/AGENTS.md",
            "missing": true,
            "rawChars": 0,
            "injectedChars": 52,
            "truncated": false
          },
          {
            "name": "SOUL.md",
            "path": "/opt/ran_agent/main/SOUL.md",
            "missing": true,
            "rawChars": 0,
            "injectedChars": 50,
            "truncated": false
          },
          {
            "name": "TOOLS.md",
            "path": "/opt/ran_agent/main/TOOLS.md",
            "missing": true,
            "rawChars": 0,
            "injectedChars": 51,
            "truncated": false
          },
          {
            "name": "IDENTITY.md",
            "path": "/opt/ran_agent/main/IDENTITY.md",
            "missing": true,
            "rawChars": 0,
            "injectedChars": 54,
            "truncated": false
          },
          {
            "name": "USER.md",
            "path": "/opt/ran_agent/main/USER.md",
            "missing": true,
            "rawChars": 0,
            "injectedChars": 50,
            "truncated": false
          },
          {
            "name": "HEARTBEAT.md",
            "path": "/opt/ran_agent/main/HEARTBEAT.md",
            "missing": true,
            "rawChars": 0,
            "injectedChars": 55,
            "truncated": false
          },
          {
            "name": "BOOTSTRAP.md",
            "path": "/opt/ran_agent/main/BOOTSTRAP.md",
            "missing": true,
            "rawChars": 0,
            "injectedChars": 55,
            "truncated": false
          }
        ],
        "skills": {
          "promptChars": 782,
          "entries": [
            {
              "name": "weather",
              "blockChars": 413
            }
          ]
        },
        "tools": {
          "listChars": 0,
          "schemaChars": 15763,
          "entries": [
            {
              "name": "exec",
              "summaryChars": 446,
              "schemaChars": 1098,
              "propertiesCount": 12
            },
            {
              "name": "process",
              "summaryChars": 322,
              "schemaChars": 961,
              "propertiesCount": 12
            },
            {
              "name": "session_status",
              "summaryChars": 336,
              "schemaChars": 89,
              "propertiesCount": 2
            },
            {
              "name": "web_search",
              "summaryChars": 167,
              "schemaChars": 248,
              "propertiesCount": 2
            },
            {
              "name": "web_fetch",
              "summaryChars": 129,
              "schemaChars": 374,
              "propertiesCount": 3
            },
            {
              "name": "media_generation__generate_image",
              "summaryChars": 166,
              "schemaChars": 185,
              "propertiesCount": 1
            },
            {
              "name": "media_generation__generate_speech",
              "summaryChars": 178,
              "schemaChars": 147,
              "propertiesCount": 1
            },
            {
              "name": "playwright__browser_click",
              "summaryChars": 27,
              "schemaChars": 770,
              "propertiesCount": 5
            },
            {
              "name": "playwright__browser_close",
              "summaryChars": 14,
              "schemaChars": 119,
              "propertiesCount": 0
            },
            {
              "name": "playwright__browser_console_messages",
              "summaryChars": 28,
              "schemaChars": 654,
              "propertiesCount": 3
            },
            {
              "name": "playwright__browser_drag",
              "summaryChars": 42,
              "schemaChars": 717,
              "propertiesCount": 4
            },
            {
              "name": "playwright__browser_drop",
              "summaryChars": 135,
              "schemaChars": 766,
              "propertiesCount": 4
            },
            {
              "name": "playwright__browser_evaluate",
              "summaryChars": 49,
              "schemaChars": 647,
              "propertiesCount": 4
            },
            {
              "name": "playwright__browser_file_upload",
              "summaryChars": 28,
              "schemaChars": 305,
              "propertiesCount": 1
            },
            {
              "name": "playwright__browser_fill_form",
              "summaryChars": 25,
              "schemaChars": 968,
              "propertiesCount": 1
            },
            {
              "name": "playwright__browser_handle_dialog",
              "summaryChars": 15,
              "schemaChars": 312,
              "propertiesCount": 2
            },
            {
              "name": "playwright__browser_hover",
              "summaryChars": 26,
              "schemaChars": 401,
              "propertiesCount": 2
            },
            {
              "name": "playwright__browser_navigate",
              "summaryChars": 17,
              "schemaChars": 200,
              "propertiesCount": 1
            },
            {
              "name": "playwright__browser_navigate_back",
              "summaryChars": 43,
              "schemaChars": 119,
              "propertiesCount": 0
            },
            {
              "name": "playwright__browser_network_request",
              "summaryChars": 149,
              "schemaChars": 598,
              "propertiesCount": 3
            },
            {
              "name": "playwright__browser_network_requests",
              "summaryChars": 132,
              "schemaChars": 553,
              "propertiesCount": 3
            },
            {
              "name": "playwright__browser_press_key",
              "summaryChars": 27,
              "schemaChars": 257,
              "propertiesCount": 1
            },
            {
              "name": "playwright__browser_resize",
              "summaryChars": 25,
              "schemaChars": 290,
              "propertiesCount": 2
            },
            {
              "name": "playwright__browser_run_code_unsafe",
              "summaryChars": 124,
              "schemaChars": 577,
              "propertiesCount": 2
            },
            {
              "name": "playwright__browser_select_option",
              "summaryChars": 30,
              "schemaChars": 568,
              "propertiesCount": 3
            },
            {
              "name": "playwright__browser_snapshot",
              "summaryChars": 82,
              "schemaChars": 562,
              "propertiesCount": 4
            },
            {
              "name": "playwright__browser_tabs",
              "summaryChars": 45,
              "schemaChars": 453,
              "propertiesCount": 3
            },
            {
              "name": "playwright__browser_take_screenshot",
              "summaryChars": 123,
              "schemaChars": 922,
              "propertiesCount": 5
            },
            {
              "name": "playwright__browser_type",
              "summaryChars": 31,
              "schemaChars": 752,
              "propertiesCount": 5
            },
            {
              "name": "playwright__browser_wait_for",
              "summaryChars": 64,
              "schemaChars": 328,
              "propertiesCount": 3
            },
            {
              "name": "time__convert_time",
              "summaryChars": 30,
              "schemaChars": 583,
              "propertiesCount": 3
            },
            {
              "name": "time__get_current_time",
              "summaryChars": 40,
              "schemaChars": 240,
              "propertiesCount": 1
            }
          ]
        }
      },
      "finalAssistantVisibleText": "BROWSER_MCP_VISIBLE\n\n我可以看到 Playwright/browser MCP 工具（如 `playwright__browser_navigate`、`playwright__browser_click`、`playwright__browser_snapshot` 等）和 time MCP 工具（`time__get_current_time`、`time__convert_time`）。",
      "replayInvalid": false,
      "livenessState": "working",
      "stopReason": "stop"
    }
  }
}
exit=0
```
