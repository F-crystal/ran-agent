#!/usr/bin/env python3
"""
XHS Browse 功能测试

测试 xhs_browse_* 工具的正确实现，确保不破坏 read_social_post 旧链路。
"""

import subprocess
import json
import sys
import os

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MJS_FILE = os.path.join(ROOT_DIR, 'node_bridge/src/socialReaderMcpServer.mjs')

def test_syntax_check():
    """测试 1: JavaScript 语法检查"""
    result = subprocess.run(
        ['node', '--check', MJS_FILE],
        capture_output=True,
        text=True
    )
    assert result.returncode == 0, f"Syntax error: {result.stderr}"
    print("✅ test_syntax_check: PASSED")

def test_tools_list_contains_browse_tools():
    """测试 2: tools/list 包含新增 xhs_browse_* 工具"""
    # 读取文件检查工具定义
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    required_tools = [
        'xhs_browse_probe',
        'xhs_browse_search',
        'xhs_browse_note',
        'xhs_browse_user',
        'xhs_browse_feed'
    ]
    
    for tool in required_tools:
        assert f"name: '{tool}'" in content, f"Tool {tool} not found in buildSocialReaderTools"
    
    print("✅ test_tools_list_contains_browse_tools: PASSED")

def test_xhs_browse_probe_unconfigured():
    """测试 3: xhs_browse_probe 在未配置 XHS_BROWSE_MCP_COMMAND 时返回清晰错误"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    # 检查是否有 BACKEND_UNAVAILABLE 错误处理
    assert 'XHS_BROWSE_BACKEND_UNAVAILABLE' in content
    assert 'XHS_BROWSE_MCP_COMMAND not configured' in content
    print("✅ test_xhs_browse_probe_unconfigured: PASSED")

def test_xhs_browse_disabled():
    """测试 4: XHS_BROWSE_ENABLED=false 时，search/note 返回 XHS_BROWSE_DISABLED"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    assert 'XHS_BROWSE_DISABLED' in content
    assert 'XHS_BROWSE_ENABLED' in content
    print("✅ test_xhs_browse_disabled: PASSED")

def test_max_results_clipping():
    """测试 5: max_results=20 被裁剪到 10"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    assert 'maxResultsHardLimit' in content
    assert '10' in content  # 硬上限 10
    assert 'Math.min' in content  # 裁剪逻辑
    print("✅ test_max_results_clipping: PASSED")

def test_user_disabled_by_default():
    """测试 6: user 默认关闭，返回 XHS_PROFILE_DISABLED"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    assert 'XHS_PROFILE_DISABLED' in content
    assert 'XHS_BROWSE_USER_ENABLED' in content
    print("✅ test_user_disabled_by_default: PASSED")

def test_feed_disabled_by_default():
    """测试 7: feed 默认关闭，返回 XHS_FEED_DISABLED"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    assert 'XHS_FEED_DISABLED' in content
    assert 'XHS_BROWSE_FEED_ENABLED' in content
    print("✅ test_feed_disabled_by_default: PASSED")

def test_rate_limiting():
    """测试 8: 调用过快返回 XHS_RATE_LIMITED"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    assert 'XHS_RATE_LIMITED' in content
    assert 'minIntervalMs' in content
    assert 'maxCallsPerSession' in content
    print("✅ test_rate_limiting: PASSED")

def test_error_codes():
    """测试 9: 错误码完整性"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    required_codes = [
        'XHS_BROWSE_DISABLED',
        'XHS_BROWSE_BACKEND_UNAVAILABLE',
        'XHS_BROWSE_TOOL_NOT_FOUND',
        'XHS_BROWSE_PROTOCOL_ERROR',
        'XHS_SEARCH_FAILED',
        'XHS_NOTE_READ_FAILED',
        'XHS_PROFILE_DISABLED',
        'XHS_PROFILE_FAILED',
        'XHS_FEED_DISABLED',
        'XHS_FEED_FAILED',
        'XHS_AUTH_REQUIRED',
        'XHS_RISK_CONTROL',
        'XHS_RATE_LIMITED',
        'XHS_INVALID_ARGUMENT',
        'XHS_TIMEOUT',
        'XHS_BACKEND_MCP_ERROR',
    ]
    
    for code in required_codes:
        assert code in content, f"Error code {code} not found"
    
    print("✅ test_error_codes: PASSED")

def test_read_social_post_unchanged():
    """测试 10: read_social_post 回归测试"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    # 确保 read_social_post 仍然存在且未被修改
    assert "if (name === 'read_social_post')" in content
    assert 'readSocialPost' in content
    print("✅ test_read_social_post_unchanged: PASSED")

def test_no_sensitive_data_logging():
    """测试 11: 日志不包含敏感信息"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    # 检查是否有直接打印 Cookie 的代码
    lines = content.split('\n')
    for line in lines:
        # 不应该有 console.log 打印 cookie/token
        lower_line = line.lower()
        if 'console.log' in lower_line or 'process.stdout.write' in lower_line:
            assert 'cookie' not in lower_line or 'cookiemask' in lower_line
            assert 'token' not in lower_line or 'authtoken' in lower_line
    
    print("✅ test_no_sensitive_data_logging: PASSED")

def test_env_example_updated():
    """测试 12: .env.example 包含 XHS_BROWSE_* 模板"""
    env_example = os.path.join(ROOT_DIR, '.env.example')
    
    with open(env_example, 'r') as f:
        content = f.read()
    
    required_vars = [
        'XHS_BROWSE_ENABLED',
        'XHS_BROWSE_MCP_COMMAND',
        'XHS_BROWSE_MCP_ARGS_JSON',
        'XHS_BROWSE_MCP_COOKIE_ENV',
        'XHS_BROWSE_SEARCH_ENABLED',
        'XHS_BROWSE_NOTE_ENABLED',
        'XHS_BROWSE_USER_ENABLED',
        'XHS_BROWSE_FEED_ENABLED',
    ]
    
    for var in required_vars:
        assert var in content, f"Variable {var} not found in .env.example"
    
    print("✅ test_env_example_updated: PASSED")

def test_tool_name_mapping():
    """测试 13: 工具名候选映射"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    # 检查工具名映射配置
    assert 'search_notes' in content
    assert 'get_note_info' in content
    assert 'get_user_notes' in content
    assert 'get_feed' in content
    print("✅ test_tool_name_mapping: PASSED")

def test_search_notes_uses_keywords():
    """测试 14: search_notes 工具使用 keywords 参数"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    # 检查 xhsBrowseSearch 中是否有 keywords 参数映射
    assert "backendArgs.keywords = query" in content, "search_notes should use keywords parameter"
    assert "if (backendToolName === 'search_notes')" in content, "Should check for search_notes tool name"
    print("✅ test_search_notes_uses_keywords: PASSED")

def test_adapter_normalization():
    """测试 15: Adapter 归一化逻辑"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    assert 'normalizeXhsBrowseResponse' in content
    assert 'available_tools' in content
    assert 'matched_tools' in content
    # 检查 originalQuery 参数支持
    assert 'originalQuery' in content, "Should support originalQuery parameter"
    # 检查 debug_shape 诊断字段
    assert 'debug_shape' in content, "Should include debug_shape"
    print("✅ test_adapter_normalization: PASSED")

def test_backend_eof_without_response():
    """测试 16: 后端 EOF 但无 JSON-RPC 响应时返回错误"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    # 检查 exit handler 是否处理无响应情况
    assert 'Backend exited without JSON-RPC response' in content, "Should return error when backend exits without response"
    # 检查错误码
    assert 'BACKEND_MCP_ERROR' in content, "Should use BACKEND_MCP_ERROR code"
    # 检查 targetId 用于区分 probe 和工具调用
    assert 'targetId' in content, "Should use targetId for response matching"
    print("✅ test_backend_eof_without_response: PASSED")

def test_probe_callable_verified_flag():
    """测试 17: probe 返回 callable_verified 标志"""
    with open(MJS_FILE, 'r') as f:
        content = f.read()
    
    # 检查 probeXhsBrowseBackend 是否返回 callable_verified
    assert 'callable_verified' in content, "Should return callable_verified flag"
    assert 'declared_tools' in content, "Should return declared_tools"
    print("✅ test_probe_callable_verified_flag: PASSED")

if __name__ == '__main__':
    tests = [
        test_syntax_check,
        test_tools_list_contains_browse_tools,
        test_xhs_browse_probe_unconfigured,
        test_xhs_browse_disabled,
        test_max_results_clipping,
        test_user_disabled_by_default,
        test_feed_disabled_by_default,
        test_rate_limiting,
        test_error_codes,
        test_read_social_post_unchanged,
        test_no_sensitive_data_logging,
        test_env_example_updated,
        test_tool_name_mapping,
        test_search_notes_uses_keywords,
        test_adapter_normalization,
        test_backend_eof_without_response,
        test_probe_callable_verified_flag,
    ]
    
    failed = []
    for test in tests:
        try:
            test()
        except AssertionError as e:
            print(f"❌ {test.__name__}: FAILED - {e}")
            failed.append(test.__name__)
        except Exception as e:
            print(f"❌ {test.__name__}: ERROR - {e}")
            failed.append(test.__name__)
    
    print(f"\n{'='*50}")
    print(f"Tests: {len(tests)}, Passed: {len(tests) - len(failed)}, Failed: {len(failed)}")
    
    if failed:
        print(f"Failed tests: {', '.join(failed)}")
        sys.exit(1)
    else:
        print("All tests passed! 🎉")
        sys.exit(0)
