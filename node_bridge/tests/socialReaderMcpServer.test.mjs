import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildSocialReaderTools,
  detectSocialPlatform,
  extractFirstUrl,
  handleSocialReaderMcpRequest,
  parseXhsUrlInfo,
  resolveFetchImpl,
  resolveXhsShareUrl,
} from '../src/socialReaderMcpServer.mjs';

const XHS_READY_MARKER_PATH = path.join(os.tmpdir(), `ran-agent-xhs-ready-${process.pid}.json`);
fs.writeFileSync(XHS_READY_MARKER_PATH, JSON.stringify({
  ok: true,
  package: 'wanyi-watermark',
  tool_name: 'parse_xhs_link',
  command: 'echo',
  args: [],
  backend_python: 'echo',
  backend_module: 'test',
}));

function xhsReadyEnv(extra = {}) {
  return {
    XHS_GENERIC_FALLBACK_READY_PATH: XHS_READY_MARKER_PATH,
    ...extra,
  };
}

test('social reader exposes only read-only tools with object schemas', () => {
  const tools = buildSocialReaderTools({});

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      'resolve_social_url',
      'read_social_post',
      'read_social_post_deep',
      'read_music_share',
    ]
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.equal(tools.some((tool) => /publish|post_comment|comment_on|like/i.test(tool.name)), false);
  assert.equal(
    tools[0].inputSchema.properties.url.description,
    'URL or share text containing URL.'
  );
  assert.equal(
    tools[1].inputSchema.properties.url.description,
    'URL or share text containing URL.'
  );
  assert.equal(
    tools[2].inputSchema.properties.url.description,
    'URL or share text containing URL.'
  );
});

test('social reader MCP tools/list hides XHS browse tools by default', async () => {
  const listed = await handleSocialReaderMcpRequest(
    { method: 'tools/list', params: {} },
    { env: {} }
  );

  assert.equal(listed.tools.some((tool) => tool.name === 'xhs_browse_note'), false);
});

test('social reader rejects retired direct XHS browse calls', async () => {
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'xhs_browse_note',
        arguments: { read_ref: 'xhs:note:note123' },
      },
    },
    { env: {} }
  );

  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error_code, 'XHS_ACCOUNT_BACKED_DISABLED');
});

test('social reader never exposes XHS browse tools', async () => {
  const listed = await handleSocialReaderMcpRequest(
    { method: 'tools/list', params: {} },
    { env: { SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS: 'true' } }
  );

  assert.equal(listed.tools.some((tool) => tool.name.startsWith('xhs_browse_')), false);
  assert.equal(listed.tools.some((tool) => tool.name === 'check_social_login'), false);
});

test('read_social_post public-only XHS ignores poisoned account-backed environment', async () => {
  const calls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: '公开解析测试 https://www.xiaohongshu.com/explore/public-only-note?xsec_token=poison',
          include_comments: true,
        },
      },
    },
    {
      env: xhsReadyEnv({
        XHS_COOKIE: 'a1=secret',
        XHS_BROWSE_ENABLED: 'true',
        XHS_BROWSE_MCP_COMMAND: 'mcporter',
        SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS: 'true',
      }),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        calls.push({ server, toolName, arguments: toolArgs });
        assert.equal(server, 'generic');
        assert.equal(toolName, 'parse_xhs_link');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              title: '公开解析标题',
              desc: '公开解析正文',
              images: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/public-only-1' }],
            }),
          }],
        };
      },
      xhsBrowseCallImpl: async () => {
        throw new Error('xhs browse must not be called in public-only mode');
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.source, 'wanyi-watermark-mcp');
  assert.equal(result.structuredContent.comments_supported, false);
  assert.equal(calls.length, 1);
});

test('detectSocialPlatform recognizes common Chinese social share hosts', () => {
  assert.equal(detectSocialPlatform('https://www.xiaohongshu.com/explore/abc'), 'xhs');
  assert.equal(detectSocialPlatform('https://xhslink.com/a/abc'), 'xhs');
  assert.equal(detectSocialPlatform('https://v.douyin.com/abc'), 'douyin');
  assert.equal(detectSocialPlatform('https://b23.tv/abc'), 'bilibili');
  assert.equal(detectSocialPlatform('https://www.bilibili.com/video/BV1xx411c7mD'), 'bilibili');
  assert.equal(detectSocialPlatform('https://m.weibo.cn/status/abc'), 'weibo');
  assert.equal(detectSocialPlatform('https://music.163.com/song?id=12345'), 'netease_music');
  assert.equal(detectSocialPlatform('https://y.music.163.com/m/song?id=12345'), 'netease_music');
  assert.equal(detectSocialPlatform('https://163cn.tv/6CuPb7V'), 'netease_music');
  assert.equal(detectSocialPlatform('https://mp.weixin.qq.com/s/demo'), 'wechat_article');
});

test('read_social_post uses generic XHS parser as primary content path', async () => {
  const calls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/abc?xsec_token=tok',
          include_comments: true,
          max_comments: 5,
        },
      },
    },
    {
      env: xhsReadyEnv({ XHS_COOKIE: 'a1=demo; web_session=demo' }),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        calls.push({ server, toolName, arguments: toolArgs });
        if (server === 'generic' && toolName === 'parse_xhs_link') {
          return { content: [{ type: 'text', text: '通用解析正文' }] };
        }
        throw new Error(`unexpected tool: ${server}.${toolName}`);
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.platform, 'xhs');
  assert.equal(result.structuredContent.source, 'wanyi-watermark-mcp');
  assert.equal(result.structuredContent.parser_tool, 'parse_xhs_link');
  assert.equal(result.structuredContent.post_text, '通用解析正文');
  assert.equal(result.structuredContent.comments_supported, false);
  assert.deepEqual(
    calls.map((call) => [call.server, call.toolName, call.arguments.share_link]),
    [
      ['generic', 'parse_xhs_link', 'https://www.xiaohongshu.com/explore/abc?xsec_token=tok'],
    ]
  );
});

test('read_social_post does not cold-start default XHS generic parser when marker is missing', async () => {
  const calls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/abc',
          include_comments: true,
          max_comments: 5,
        },
      },
    },
    {
      env: {
        XHS_GENERIC_FALLBACK_READY_PATH: '/tmp/ran-agent-missing-xhs-marker.json',
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial, true);
  assert.equal(result.structuredContent.content_available, false);
  assert.equal(result.structuredContent.error_code, 'XHS_PUBLIC_PARSE_FAILED');
  assert.deepEqual(calls, []);
});

test('XHS browse tools remain unavailable even when legacy browse env is set', async () => {
  const options = {
    env: {
      SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS: 'true',
      XHS_BROWSE_ENABLED: 'true',
      XHS_BROWSE_MCP_COMMAND: 'mock-xhs',
      XHS_BROWSE_MCP_ARGS_JSON: '["mock"]',
    },
    xhsBrowseCallImpl: async () => {
      throw new Error('browse backend must not be called');
    },
  };

  const listed = await handleSocialReaderMcpRequest({ method: 'tools/list', params: {} }, options);
  assert.equal(listed.tools.some((tool) => tool.name.startsWith('xhs_browse_')), false);

  const direct = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'xhs_browse_note',
        arguments: { read_ref: 'xhs:note:legacy-note' },
      },
    },
    options
  );

  assert.equal(direct.structuredContent.ok, false);
  assert.equal(direct.structuredContent.error_code, 'XHS_ACCOUNT_BACKED_DISABLED');
});

test('read_social_post normalizes successful XHS generic parser JSON', async () => {
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/json-note',
        },
      },
    },
    {
      env: xhsReadyEnv({ XHS_COOKIE: 'a1=demo' }),
      mcpCallImpl: async ({ server, toolName }) => {
        if (server === 'generic' && toolName === 'parse_xhs_link') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'success',
                platform: 'xiaohongshu',
                note_id: 'json-note',
                title: 'JSON 标题',
                desc: 'JSON 正文',
                images: [{ url_webp: 'https://example.com/json.webp' }],
              }),
            }],
          };
        }
        throw new Error(`unexpected tool: ${server}.${toolName}`);
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.post_text, 'JSON 正文');
  assert.equal(result.structuredContent.title, 'JSON 标题');
  assert.equal(result.structuredContent.note_id, 'json-note');
  assert.deepEqual(result.structuredContent.images, [{ url_webp: 'https://example.com/json.webp' }]);
  assert.equal(result.structuredContent.primary, true);
});

test('read_social_post treats XHS generic parser error JSON as failure', async () => {
  // Set up a temporary marker for the XHS generic fallback
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const markerDir = mkdtempSync(join(tmpdir(), 'xhs-marker-'));
  const markerPath = join(markerDir, 'generic-fallback-ready.json');
  writeFileSync(markerPath, JSON.stringify({
    ok: true, package: 'wanyi-watermark', tool_name: 'parse_xhs_link',
    command: 'echo', args: [], backend_python: 'echo', backend_module: 'test',
  }));

  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/error-note',
        },
      },
    },
    {
      env: { XHS_COOKIE: 'a1=demo', XHS_GENERIC_FALLBACK_READY_PATH: markerPath },
      mcpCallImpl: async ({ server, toolName }) => {
        if (server === 'generic' && toolName === 'parse_xhs_link') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'error',
                error: '小红书图文解析失败: 无法从链接中提取笔记 ID',
              }),
            }],
          };
        }
        throw new Error(`unexpected tool: ${server}.${toolName}`);
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial, true);
  assert.equal(result.structuredContent.platform, 'xhs');
  assert.equal(result.structuredContent.error_code, 'XHS_PUBLIC_PARSE_FAILED');
  assert.equal(result.structuredContent.should_answer_from_content, false);
});

test('read_social_post ignores legacy token cache and never calls xhs backend', async () => {
  const calls = [];
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-legacy-cache-'));
  const cachePath = path.join(cacheDir, 'xhs-note-token-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    version: 1,
    entries: {
      'cached-note': {
        xsecToken: 'cached-token',
        canonical_url: 'https://www.xiaohongshu.com/explore/cached-note?xsec_token=cached-token',
        createdAt: Date.now(),
      },
    },
  }));
  const env = xhsReadyEnv({
    XHS_COOKIE: 'a1=demo',
    SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS: 'true',
    XHS_BROWSE_ENABLED: 'true',
    XHS_BROWSE_MCP_COMMAND: 'mock-xhs',
    XHS_BROWSE_MCP_ARGS_JSON: '["mock"]',
    XHS_BROWSE_MIN_INTERVAL_MS: '0',
    XHS_BROWSE_MAX_CALLS_PER_SESSION: '99',
    XHS_NOTE_TOKEN_CACHE_PATH: cachePath,
  });
  const options = {
    env,
    xhsBrowseCallImpl: async ({ toolName }) => {
      throw new Error(`unexpected browse tool: ${toolName}`);
    },
    mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
      calls.push({ server, toolName, arguments: toolArgs });
      if (server === 'generic' && toolName === 'parse_xhs_link') {
        return { content: [{ type: 'text', text: JSON.stringify({ desc: '公开解析正文' }) }] };
      }
      throw new Error(`unexpected tool: ${server}.${toolName}`);
    },
  };

  const post = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: { url: 'https://www.xiaohongshu.com/explore/cached-note' },
      },
    },
    options
  );

  assert.equal(post.structuredContent.ok, true);
  assert.equal(post.structuredContent.post_text, '公开解析正文');
  assert.equal(post.structuredContent.url, 'https://www.xiaohongshu.com/explore/cached-note');
  assert.deepEqual(
    calls.map((call) => [call.server, call.toolName, call.arguments]),
    [
      ['generic', 'parse_xhs_link', { share_link: 'https://www.xiaohongshu.com/explore/cached-note' }],
    ]
  );
  assert.equal(JSON.stringify(post).includes('cached-token'), false);
});

test('check_social_login is no longer an exposed social reader tool', async () => {
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'check_social_login',
        arguments: { platform: 'xhs' },
      },
    },
    {
      env: {},
      mcpCallImpl: async () => {
        throw new Error('child MCP should not be called');
      },
    }
  );

  assert.equal(result.structuredContent.ok, false);
  assert.match(result.structuredContent.error, /unknown tool/);
});

test('read_social_post routes non-xhs links to generic parser with share_link argument', async () => {
  const calls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://v.douyin.com/share-demo',
        },
      },
    },
    {
      fetchImpl: async (url) => ({ url }),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        calls.push({ server, toolName, arguments: toolArgs });
        return { content: [{ type: 'text', text: '{"status":"success","caption":"测试视频"}' }] };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.platform, 'douyin');
  assert.equal(result.structuredContent.parser_tool, 'parse_douyin_link');
  assert.deepEqual(calls, [
    {
      server: 'generic',
      toolName: 'parse_douyin_link',
      arguments: { share_link: 'https://v.douyin.com/share-demo' },
    },
  ]);
});

test('read_social_post routes clean bilibili bvid URLs through bilibili MCP', async () => {
  const calls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.999',
        },
      },
    },
    {
      env: xhsReadyEnv(),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        calls.push({ server, toolName, arguments: toolArgs });
        return { content: [{ type: 'text', text: 'B站视频详情' }] };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.platform, 'bilibili');
  assert.equal(result.structuredContent.bvid, 'BV1xx411c7mD');
  assert.deepEqual(calls, [
    {
      server: 'bilibili',
      toolName: 'get_video_info',
      arguments: { bvid: 'BV1xx411c7mD' },
    },
  ]);
});

test('read_social_post resolves b23 short links before calling bilibili MCP', async () => {
  const calls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: '【难道0昔不是区？0命白刻花昔满星骑士一-哔哩哔哩】 https://b23.tv/IxODijt',
        },
      },
    },
    {
      fetchImpl: async () => ({ url: 'https://www.bilibili.com/video/BV1ZQRyBoEUs/?share_source=COPY&unique_k=IxODijt' }),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        calls.push({ server, toolName, arguments: toolArgs });
        return { content: [{ type: 'text', text: '短链视频详情' }] };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.url, 'https://www.bilibili.com/video/BV1ZQRyBoEUs/?share_source=COPY&unique_k=IxODijt');
  assert.deepEqual(calls, [
    {
      server: 'bilibili',
      toolName: 'get_video_info',
      arguments: { bvid: 'BV1ZQRyBoEUs' },
    },
  ]);
});

test('read_social_post extracts WeChat article links from share text and reports captcha', async () => {
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: '分享一篇文章\nhttps://mp.weixin.qq.com/s/demo，复制打开',
        },
      },
    },
    {
      mediaReaderCallImpl: async ({ toolName, arguments: toolArgs }) => {
        assert.equal(toolName, 'resolve_platform_media');
        assert.equal(toolArgs.platform, 'wechat_article');
        assert.equal(toolArgs.url_or_text, '分享一篇文章\nhttps://mp.weixin.qq.com/s/demo，复制打开');
        return {
          isError: true,
          structuredContent: {
            ok: false,
            platform: 'wechat_article',
            captcha_detected: true,
            error_code: 'WECHAT_CAPTCHA_REQUIRED',
            recovery_suggestion: '当前微信公众号文章触发微信验证码或动态加载限制。请在浏览器中打开文章后复制正文，或导出 PDF/截图上传；也可以配置已验证的 wechat-reader 浏览器会话后重试。',
          },
        };
      },
    }
  );

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.platform, 'wechat_article');
  assert.equal(result.structuredContent.error_code, 'WECHAT_CAPTCHA_REQUIRED');
  assert.equal(result.structuredContent.captcha_detected, true);
});

test('read_music_share reads netease song share text through configured API base', async () => {
  const requests = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_music_share',
        arguments: {
          url: '分享单曲 https://music.163.com/song?id=12345&userid=1 复制打开',
        },
      },
    },
    {
      env: { NETEASE_MUSIC_API_BASE_URL: 'https://music-api.example.com' },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        assert.match(init.headers['user-agent'], /Mozilla/);
        return {
          ok: true,
          json: async () => ({
            songs: [{
              id: 12345,
              name: '测试歌曲',
              ar: [{ name: '歌手A' }],
              al: { name: '测试专辑', picUrl: 'https://img.example.com/cover.jpg' },
            }],
          }),
        };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.platform, 'netease_music');
  assert.equal(result.structuredContent.music_type, 'song');
  assert.equal(result.structuredContent.song_id, '12345');
  assert.equal(result.structuredContent.title, '测试歌曲');
  assert.deepEqual(result.structuredContent.artists, ['歌手A']);
  assert.equal(
    requests[0].url,
    'https://music-api.example.com/song/detail?ids=%5B12345%5D'
  );
});

test('read_music_share resolves 163cn.tv netease short share text before reading song detail', async () => {
  const requests = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_music_share',
        arguments: {
          url: '分享泽典的单曲《月下逢》https://163cn.tv/6CuPb7V (@网易云音乐)',
        },
      },
    },
    {
      env: { NETEASE_MUSIC_API_BASE_URL: 'https://music-api.example.com' },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        assert.match(init.headers['user-agent'], /Mozilla/);
        if (url === 'https://163cn.tv/6CuPb7V') {
          return {
            ok: true,
            url: 'https://music.163.com/song?id=2607556920&uct2=demo',
          };
        }
        return {
          ok: true,
          json: async () => ({
            songs: [{
              id: 2607556920,
              name: '月下逢',
              ar: [{ name: '泽典' }],
              al: { name: '月下逢', picUrl: 'https://img.example.com/yuexiafeng.jpg' },
            }],
          }),
        };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.platform, 'netease_music');
  assert.equal(result.structuredContent.url, 'https://music.163.com/song?id=2607556920&uct2=demo');
  assert.equal(result.structuredContent.song_id, '2607556920');
  assert.equal(result.structuredContent.title, '月下逢');
  assert.deepEqual(result.structuredContent.artists, ['泽典']);
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      'https://163cn.tv/6CuPb7V',
      'https://music-api.example.com/song/detail?ids=%5B2607556920%5D',
    ]
  );
});

test('resolveFetchImpl falls back when global fetch is unavailable', () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    assert.equal(typeof resolveFetchImpl(), 'function');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('read_social_post routes netease music links to the music reader', async () => {
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://music.163.com/#/song?id=67890',
        },
      },
    },
    {
      env: { NETEASE_MUSIC_API_BASE_URL: 'https://music-api.example.com/' },
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          songs: [{
            id: 67890,
            name: '另一首歌',
            artists: [{ name: '歌手B' }],
            album: { name: '专辑B', picUrl: '' },
          }],
        }),
      }),
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.platform, 'netease_music');
  assert.equal(result.structuredContent.song_id, '67890');
});

test('extractFirstUrl trims Chinese punctuation and share text tails', () => {
  assert.equal(
    extractFirstUrl('FIFA回应 http://xhslink.com/o/r5Ot5yz9ty \n先复制再打开【小红书】').url,
    'https://xhslink.com/o/r5Ot5yz9ty'
  );
  assert.equal(
    extractFirstUrl('看这个：https://xhslink.com/a/abc123，复制打开小红书').url,
    'https://xhslink.com/a/abc123'
  );
  assert.equal(
    extractFirstUrl('没有链接').error_code,
    'NO_URL_FOUND'
  );
});

test('extractFirstUrl normalizes xhslink http to https', () => {
  assert.equal(
    extractFirstUrl('分享 http://xhslink.com/o/abc123 打开小红书').url,
    'https://xhslink.com/o/abc123'
  );
  assert.equal(
    extractFirstUrl('分享 https://xhslink.com/a/def456 打开小红书').url,
    'https://xhslink.com/a/def456'
  );
  // Non-xhslink URLs should not be affected
  assert.equal(
    extractFirstUrl('看这个 http://example.com/page').url,
    'http://example.com/page'
  );
});

test('parseXhsUrlInfo supports common final Xiaohongshu URL shapes', () => {
  assert.deepEqual(
    parseXhsUrlInfo('https://www.xiaohongshu.com/explore/note123?xsec_token=tok&xsec_source=app_share'),
    {
      note_id: 'note123',
      xsec_token: 'tok',
      xsec_source: 'app_share',
      canonical_url: 'https://www.xiaohongshu.com/explore/note123?xsec_token=tok&xsec_source=app_share',
    }
  );
  assert.deepEqual(
    parseXhsUrlInfo('https://www.xiaohongshu.com/discovery/item/note456?xsec_token=tok2'),
    {
      note_id: 'note456',
      xsec_token: 'tok2',
      xsec_source: '',
      canonical_url: 'https://www.xiaohongshu.com/explore/note456?xsec_token=tok2',
    }
  );
});

test('resolveXhsShareUrl follows xhslink /o/ redirect with browser UA and no cookie', async () => {
  const requests = [];
  const result = await resolveXhsShareUrl(
    'FIFA回应中国区天价世界杯版权 http://xhslink.com/o/r5Ot5yz9ty 先复制再打开【小红书】',
    {
      env: { XHS_COOKIE: 'a1=secret; id_token=secret' },
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        assert.match(init.headers['user-agent'], /Mozilla/);
        assert.equal(init.headers.cookie, undefined);
        return {
          status: 302,
          headers: {
            get(name) {
              return name.toLowerCase() === 'location'
                ? 'https://www.xiaohongshu.com/explore/note789?xsec_token=fresh&xsec_source=app_share'
                : null;
            },
          },
        };
      },
    }
  );

  assert.equal(requests.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.note_id, 'note789');
  assert.equal(result.xsec_token, 'fresh');
  assert.equal(result.canonical_url, 'https://www.xiaohongshu.com/explore/note789?xsec_token=fresh&xsec_source=app_share');
});

test('resolveXhsShareUrl follows xhslink /a/ redirect', async () => {
  const result = await resolveXhsShareUrl('复制 https://xhslink.com/a/abc123，打开小红书', {
    fetchImpl: async () => ({
      status: 302,
      headers: {
        get(name) {
          return name.toLowerCase() === 'location'
            ? '/explore/note-a?xsec_token=tok-a'
            : null;
        },
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.resolved_url, 'https://www.xiaohongshu.com/explore/note-a?xsec_token=tok-a');
  assert.equal(result.note_id, 'note-a');
  assert.equal(result.xsec_token, 'tok-a');
});

test('resolveXhsShareUrl rejects non-whitelisted xhs-looking domains', async () => {
  const result = await resolveXhsShareUrl('https://evil-xhslink.com/a/abc', {
    fetchImpl: async () => {
      throw new Error('fetch should not run');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'UNSUPPORTED_PLATFORM');
});

test('read_social_post accepts share text and sends original XHS share text to generic parser first', async () => {
  const shareText = 'FIFA回应中国区天价世界杯版权 http://xhslink.com/o/r5Ot5yz9ty 先复制再打开【小红书】';
  const calls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: shareText,
          include_comments: true,
          max_comments: 2,
        },
      },
    },
    {
      env: xhsReadyEnv({ XHS_COOKIE: 'a1=demo' }),
      fetchImpl: async () => ({
        status: 302,
        headers: {
          get(name) {
            return name.toLowerCase() === 'location'
              ? 'https://www.xiaohongshu.com/explore/note-clean?xsec_token=clean-token&xsec_source=app_share'
              : null;
          },
        },
      }),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        calls.push({ server, toolName, arguments: toolArgs });
        if (server === 'generic' && toolName === 'parse_xhs_link') {
          return { content: [{ type: 'text', text: '正文' }] };
        }
        throw new Error(`unexpected tool: ${server}.${toolName}`);
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.url, 'https://www.xiaohongshu.com/explore/note-clean?xsec_token=clean-token&xsec_source=app_share');
  assert.equal(result.structuredContent.comments_text, '');
  assert.equal(result.structuredContent.comments_supported, false);
  assert.deepEqual(
    calls.map((call) => [call.server, call.toolName, call.arguments.share_link]),
    [
      ['generic', 'parse_xhs_link', shareText],
    ]
  );
});

test('resolve_social_url accepts share text and returns structured XHS metadata', async () => {
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'resolve_social_url',
        arguments: {
          url: 'FIFA回应中国区天价世界杯版权 http://xhslink.com/o/r5Ot5yz9ty 先复制再打开【小红书】',
        },
      },
    },
    {
      fetchImpl: async () => ({
        status: 302,
        headers: {
          get(name) {
            return name.toLowerCase() === 'location'
              ? 'https://www.xiaohongshu.com/explore/note-resolve?xsec_token=resolve-token&xsec_source=app_share'
              : null;
          },
        },
      }),
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.platform, 'xhs');
  assert.equal(result.structuredContent.note_id, 'note-resolve');
  assert.equal(result.structuredContent.has_xsec_token, true);

  const noUrl = await handleSocialReaderMcpRequest({
    method: 'tools/call',
    params: {
      name: 'resolve_social_url',
      arguments: { url: '没有链接' },
    },
  });
  assert.equal(noUrl.structuredContent.ok, false);
  assert.equal(noUrl.structuredContent.error_code, 'NO_URL_FOUND');
});

test('resolve_social_url stores canonical XHS explore URL for discovery share links', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const cacheDir = mkdtempSync(join(tmpdir(), 'xhs-resolve-cache-'));
  const cachePath = join(cacheDir, 'xhs-note-token-cache.json');
  const shareText = '14 【置身钉内作者再发千字长文：云空未必空 - 大厂吃瓜前线 | 小红书 - 你的生活兴趣社区】 😆 dyYDHnM0OCNfOH9 😆 https://www.xiaohongshu.com/discovery/item/6a2b8f33000000001702ac99?source=webshare&xhsshare=pc_web&xsec_token=ABhlbvu1Hb6w6jyzeLPQTj67358eDrzbWm0hGNJRKVovY=&xsec_source=pc_share';

  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'resolve_social_url',
        arguments: { url: shareText },
      },
    },
    {
      env: {
        ...process.env,
        XHS_NOTE_TOKEN_CACHE_PATH: cachePath,
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.has_xsec_token, true);
  assert.equal(result.structuredContent.cache_written, false);
  assert.equal(fs.existsSync(cachePath), false);
});

test('read_social_post does not search for a fresh token when shortlink resolves without token', async () => {
  const calls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'FIFA回应中国区天价世界杯版权 http://xhslink.com/o/no-token 复制打开',
        },
      },
    },
    {
      env: xhsReadyEnv({ XHS_COOKIE: 'a1=demo' }),
      fetchImpl: async () => ({
        status: 302,
        headers: {
          get(name) {
            return name.toLowerCase() === 'location'
              ? 'https://www.xiaohongshu.com/explore/note-search'
              : null;
          },
        },
      }),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        calls.push({ server, toolName, arguments: toolArgs });
        if (server === 'generic' && toolName === 'parse_xhs_link') {
          return { content: [{ type: 'text', text: JSON.stringify({ desc: '公开短链正文' }) }] };
        }
        throw new Error(`unexpected tool: ${server}.${toolName}`);
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.url, 'https://www.xiaohongshu.com/explore/note-search');
  assert.equal(result.structuredContent.post_text, '公开短链正文');
  assert.deepEqual(
    calls.map((call) => [call.server, call.toolName, call.arguments]),
    [
      ['generic', 'parse_xhs_link', { share_link: 'FIFA回应中国区天价世界杯版权 http://xhslink.com/o/no-token 复制打开' }],
    ]
  );
});

test('read_social_post uses generic parser before jobson for XHS share text', async () => {
  const calls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: '外企十年，最狠的一封邮件，正文只有三个字 http://xhslink.com/o/4eNKGvbXwmZ 先复制一下，然后去【小红书】搜索查看笔记。',
        },
      },
    },
    {
      env: xhsReadyEnv({ XHS_COOKIE: 'a1=demo' }),
      fetchImpl: async () => ({
        status: 302,
        headers: {
          get(name) {
            return name.toLowerCase() === 'location'
              ? 'https://www.xiaohongshu.com/explore/note-fail?xsec_token=token-fail&xsec_source=app_share'
              : null;
          },
        },
      }),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        calls.push({ server, toolName, arguments: toolArgs });
        if (server === 'xhs' && toolName === 'get_note_content') {
          return { content: [{ type: 'text', text: '获取失败' }] };
        }
        if (server === 'generic' && toolName === 'parse_xhs_link') {
          return { content: [{ type: 'text', text: '通用解析正文' }] };
        }
        throw new Error(`unexpected tool: ${server}.${toolName}`);
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.source, 'wanyi-watermark-mcp');
  assert.equal(result.structuredContent.primary, true);
  assert.equal(result.structuredContent.fallback, undefined);
  assert.equal(result.structuredContent.xhs_error, undefined);
  assert.equal(result.structuredContent.post_text, '通用解析正文');
  assert.deepEqual(
    calls.map((call) => [call.server, call.toolName]),
    [
      ['generic', 'parse_xhs_link'],
    ]
  );
});

test('read_social_post retries XHS generic parser with canonical URL for long discovery share links', async () => {
  const calls = [];
  const shareText = '10 【刚刚，OpenAI给用户发了额度复活卡！！ - 数字生命卡兹克 | 小红书 - 你的生活兴趣社区】 😆 eC4hUPSHplnTrOR 😆 https://www.xiaohongshu.com/discovery/item/6a2b810f000000003502f581?source=webshare&xhsshare=pc_web&xsec_token=ABhlbvu1Hb6w6jyzeLPQTj63fw0_DFYm4ddIuyWKZ4Xbo=&xsec_source=pc_share';

  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: { url: shareText },
      },
    },
    {
      env: xhsReadyEnv(),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        calls.push({ server, toolName, arguments: toolArgs });
        assert.equal(server, 'generic');
        assert.equal(toolName, 'parse_xhs_link');
        if (toolArgs.share_link.includes('/discovery/item/')) {
          return { content: [{ type: 'text', text: '{"status":"error","message":"获取失败"}' }] };
        }
        return { content: [{ type: 'text', text: '{"status":"success","title":"额度复活卡","desc":"长链 canonical 解析正文"}' }] };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.primary, true);
  assert.equal(result.structuredContent.post_text, '长链 canonical 解析正文');
  assert.deepEqual(
    calls.map((call) => call.arguments.share_link),
    [
      shareText,
      'https://www.xiaohongshu.com/discovery/item/6a2b810f000000003502f581?source=webshare&xhsshare=pc_web&xsec_token=ABhlbvu1Hb6w6jyzeLPQTj63fw0_DFYm4ddIuyWKZ4Xbo=&xsec_source=pc_share',
      'https://www.xiaohongshu.com/explore/6a2b810f000000003502f581?xsec_token=ABhlbvu1Hb6w6jyzeLPQTj63fw0_DFYm4ddIuyWKZ4Xbo%3D&xsec_source=pc_share',
    ]
  );
});

test('read_social_post ignores legacy search result ambiguity and fails public-only when parsers fail', async () => {
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'FIFA回应中国区天价世界杯版权 http://xhslink.com/o/no-token',
        },
      },
    },
    {
      env: xhsReadyEnv({ XHS_COOKIE: 'a1=demo' }),
      fetchImpl: async () => ({
        status: 302,
        headers: {
          get(name) {
            return name.toLowerCase() === 'location'
              ? 'https://www.xiaohongshu.com/explore/note-search'
              : null;
          },
        },
      }),
      mcpCallImpl: async ({ server, toolName }) => {
        assert.equal(server, 'generic');
        assert.equal(toolName, 'parse_xhs_link');
        return { content: [{ type: 'text', text: '{"status":"error","message":"获取失败"}' }] };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial, true);
  assert.equal(result.structuredContent.error_code, 'XHS_PUBLIC_PARSE_FAILED');
});

test('read_social_post returns structured errors for no URL and unsupported platform', async () => {
  const noUrl = await handleSocialReaderMcpRequest({
    method: 'tools/call',
    params: {
      name: 'read_social_post',
      arguments: { url: '没有链接的分享文案' },
    },
  });
  assert.equal(noUrl.structuredContent.ok, false);
  assert.equal(noUrl.structuredContent.error_code, 'NO_URL_FOUND');

  const unsupported = await handleSocialReaderMcpRequest({
    method: 'tools/call',
    params: {
      name: 'read_social_post',
      arguments: { url: 'https://example.com/post/1' },
    },
  });
  assert.equal(unsupported.structuredContent.ok, false);
  assert.equal(unsupported.structuredContent.error_code, 'UNSUPPORTED_PLATFORM');
});

test('read_social_post caps max_comments but XHS public-only never fetches comments', async () => {
  const low = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/low?xsec_token=tok',
          include_comments: true,
          max_comments: 0,
        },
      },
    },
    {
      env: xhsReadyEnv({ XHS_COOKIE: 'a1=demo' }),
      mcpCallImpl: async ({ server, toolName }) => {
        assert.equal(server, 'generic');
        assert.equal(toolName, 'parse_xhs_link');
        return { content: [{ type: 'text', text: '{"desc":"正文"}' }] };
      },
    }
  );

  const high = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/high?xsec_token=tok',
          max_comments: 101,
        },
      },
    },
    {
      env: xhsReadyEnv({ XHS_COOKIE: 'a1=demo' }),
      mcpCallImpl: async ({ server, toolName }) => {
        assert.equal(server, 'generic');
        assert.equal(toolName, 'parse_xhs_link');
        return { content: [{ type: 'text', text: '{"desc":"正文"}' }] };
      },
    }
  );

  assert.deepEqual(
    [low.structuredContent.max_comments, low.structuredContent.comments_text, high.structuredContent.max_comments],
    [1, '', 100]
  );
  assert.equal(low.structuredContent.comments_supported, false);
});

test('read_social_post returns public parse failure on parser timeout', async () => {
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/timeout-test?xsec_token=tok',
        },
      },
    },
    {
      env: xhsReadyEnv({ XHS_COOKIE: 'a1=demo' }),
      mcpCallImpl: async () => {
        throw new Error('MCP backend timed out after 90000ms: uvx');
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial, true);
  assert.equal(result.structuredContent.error_code, 'XHS_PUBLIC_PARSE_FAILED');
  assert.equal(result.structuredContent.content_available, false);
  assert.equal(result.structuredContent.should_answer_from_content, false);
  assert.equal(result.structuredContent.post_text, '');
});

test('read_social_post returns partial result on generic backend failure', async () => {
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/generic-error?xsec_token=tok',
        },
      },
    },
    {
      env: xhsReadyEnv({ XHS_COOKIE: 'a1=demo' }),
      mcpCallImpl: async () => {
        throw new Error('some unexpected backend error');
      },
    }
  );

  // With fallback chain: XHS error → generic fallback → partial result
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial, true);
  assert.equal(result.structuredContent.content_available, false);
  assert.equal(result.structuredContent.should_answer_from_content, false);
  assert.equal(result.structuredContent.post_text, '');
});

test('XHS parser timeout stays within public-only failure result', async () => {
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/timeout-msg-test?xsec_token=tok',
        },
      },
    },
    {
      env: xhsReadyEnv({
        XHS_COOKIE: 'a1=demo',
        SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS: '90000',
        SOCIAL_READER_MCP_TIMEOUT_MS: '45000',
      }),
      mcpCallImpl: async ({ server }) => {
        if (server === 'generic') {
          throw new Error('MCP backend timed out after 90000ms: uvx');
        }
        throw new Error('MCP backend timed out after 90000ms: uvx');
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial, true);
  assert.equal(result.structuredContent.error_code, 'XHS_PUBLIC_PARSE_FAILED');
});

test('readSocialPost XHS path passes XHS timeout to readGenericSocialPost', async () => {
  const calls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/timeout-passthrough?xsec_token=tok',
        },
      },
    },
    {
      env: xhsReadyEnv({
        XHS_COOKIE: 'a1=demo',
        SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS: '90000',
        SOCIAL_READER_MCP_TIMEOUT_MS: '45000',
      }),
      mcpCallImpl: async ({ server, toolName }) => {
        calls.push({ server, toolName });
        if (server === 'generic' && toolName === 'parse_xhs_link') {
          return { content: [{ type: 'text', text: '{"ok":true,"post_text":"test","title":"t"}' }] };
        }
        throw new Error(`unexpected: ${server}.${toolName}`);
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.platform, 'xhs');
  assert.ok(calls.some((c) => c.server === 'generic' && c.toolName === 'parse_xhs_link'));
});

test('non-XHS platform uses generic SOCIAL_READER_MCP_TIMEOUT_MS', async () => {
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post',
        arguments: {
          url: 'https://www.bilibili.com/video/BV1test12345',
        },
      },
    },
    {
      env: {
        SOCIAL_READER_MCP_TIMEOUT_MS: '45000',
        SOCIAL_READER_XHS_BACKEND_TIMEOUT_MS: '90000',
      },
      mcpCallImpl: async ({ server }) => {
        if (server === 'generic') {
          throw new Error('MCP backend timed out after 45000ms: uvx');
        }
        throw new Error('MCP backend timed out after 45000ms: uvx');
      },
    }
  );

  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.platform, 'bilibili');
  assert.match(result.structuredContent.error, /45000ms/);
});
