import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSocialReaderTools, handleSocialReaderMcpRequest } from '../src/socialReaderMcpServer.mjs';

test('social reader exposes read_social_post_deep with standard media detail default', () => {
  const tools = buildSocialReaderTools();
  const deepTool = tools.find((tool) => tool.name === 'read_social_post_deep');

  assert.ok(deepTool);
  assert.deepEqual(deepTool.inputSchema.properties.media_detail.enum, ['none', 'basic', 'standard', 'full']);
  assert.equal(deepTool.inputSchema.properties.media_detail.default, 'standard');
  assert.equal(deepTool.inputSchema.properties.max_media_assets.default, 100);
});

test('read_social_post_deep combines social text with media_reader partial batch results', async () => {
  const calls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post_deep',
        arguments: {
          url: 'https://v.douyin.com/share-demo',
          include_comments: true,
          max_comments: 5,
          media_detail: 'standard',
        },
      },
    },
    {
      fetchImpl: async (url) => ({ url }),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        calls.push({ server, toolName, arguments: toolArgs });
        assert.equal(server, 'generic');
        assert.equal(toolName, 'parse_douyin_link');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                caption: '正文里有视频',
                media: [{ type: 'video', url: 'https://media.example.com/video.mp4' }],
              }),
            },
          ],
        };
      },
      mediaReaderCallImpl: async ({ toolName, arguments: toolArgs }) => {
        assert.equal(toolName, 'analyze_media_batch');
        assert.equal(toolArgs.media_detail, 'standard');
        return {
          structuredContent: {
            ok: true,
            partial: true,
            items: [{ asset_id: 'video-1', type: 'video', overall_summary: '视频里有人在讲解产品' }],
            merged_summary: '视频媒体总结',
            timeline: [{ start: 0, end: 3, text: '开场介绍' }],
            partial_failures: [{ asset_id: 'image-2', error_code: 'EXPIRED_MEDIA_URL' }],
            warnings: ['one media failed'],
          },
        };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.platform, 'douyin');
  assert.equal(result.structuredContent.media_detail, 'standard');
  assert.equal(result.structuredContent.media_analysis.partial, true);
  assert.match(result.structuredContent.deep_summary, /视频媒体总结/);
  assert.equal(result.structuredContent.media_analysis.partial_failures[0].error_code, 'EXPIRED_MEDIA_URL');
  assert.equal(calls.length, 1);
});

test('read_social_post_deep sends Bilibili platform assets through media_reader batch path', async () => {
  const mediaCalls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post_deep',
        arguments: {
          url: '【标题-哔哩哔哩】 https://www.bilibili.com/video/BV1xx411c7mD?p=2',
          include_comments: false,
          media_detail: 'standard',
        },
      },
    },
    {
      fetchImpl: async (url) => ({ url }),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        assert.equal(server, 'bilibili');
        assert.equal(toolName, 'get_video_info');
        assert.equal(toolArgs.bvid, 'BV1xx411c7mD');
        return {
          content: [{ type: 'text', text: 'B 站正文' }],
        };
      },
      mediaReaderCallImpl: async ({ toolName, arguments: toolArgs }) => {
        mediaCalls.push({ toolName, arguments: toolArgs });
        assert.equal(toolName, 'analyze_media_batch');
        assert.equal(toolArgs.assets[0].type, 'platform');
        assert.equal(toolArgs.assets[0].platform, 'bilibili');
        return {
          structuredContent: {
            ok: true,
            partial: false,
            items: [{ type: 'platform_media', overall_summary: 'B 站平台媒体总结' }],
            merged_summary: 'B 站平台媒体总结',
            timeline: [],
            partial_failures: [],
            warnings: [],
          },
        };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.platform, 'bilibili');
  assert.equal(result.structuredContent.media_assets[0].type, 'platform');
  assert.match(result.structuredContent.deep_summary, /B 站平台媒体总结/);
  assert.equal(mediaCalls.length, 1);
});

test('read_social_post_deep returns WeChat captcha as partial without crashing', async () => {
  const calls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post_deep',
        arguments: {
          url: 'https://mp.weixin.qq.com/s/demo',
          media_detail: 'standard',
        },
      },
    },
    {
      mediaReaderCallImpl: async ({ toolName, arguments: toolArgs }) => {
        calls.push({ toolName, arguments: toolArgs });
        if (toolName === 'resolve_platform_media') {
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
        }
        throw new Error(`unexpected tool ${toolName}`);
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial, true);
  assert.equal(result.structuredContent.platform, 'wechat_article');
  assert.equal(result.structuredContent.media_analysis.partial, true);
  assert.equal(result.structuredContent.media_analysis.partial_failures[0].error_code, 'WECHAT_CAPTCHA_REQUIRED');
  assert.ok(result.structuredContent.warnings.includes('WECHAT_CAPTCHA_REQUIRED'));
  assert.equal(calls.length, 1);
});

test('read_social_post_deep normalizes XHS wanyi media and analyzes image fallback', async () => {
  // Set up a temporary marker for the XHS generic fallback
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const markerDir = mkdtempSync(join(tmpdir(), 'xhs-deep-marker-'));
  const markerPath = join(markerDir, 'generic-fallback-ready.json');
  writeFileSync(markerPath, JSON.stringify({
    ok: true, package: 'wanyi-watermark', tool_name: 'parse_xhs_link',
    command: 'echo', args: [], backend_executable: '', backend_args: [],
    backend_python: 'echo', backend_module: 'test',
  }));

  const backendCalls = [];
  const mediaCalls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post_deep',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/note123?xsec_token=tok&xsec_source=pc_share',
          media_detail: 'standard',
          include_media: true,
        },
      },
    },
    {
      env: { XHS_GENERIC_FALLBACK_READY_PATH: markerPath },
      fetchImpl: async (url) => ({ url }),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        backendCalls.push({ server, toolName, arguments: toolArgs });
        if (server === 'xhs' && toolName === 'get_note_content') {
          return { content: [{ type: 'text', text: 'cookie已失效' }] };
        }
        assert.equal(server, 'generic');
        assert.equal(toolName, 'parse_xhs_link');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'success',
                title: '强女故事03',
                desc: '她把自己送进了疯人院',
                images: [
                  { url_png: 'https://ci.xiaohongshu.com/a.png', url_webp: 'https://ci.xiaohongshu.com/a.webp', width: 1080, height: 1440 },
                ],
                media: [
                  { type: 'image', thumbnail: 'https://ci.xiaohongshu.com/thumb.jpg', width: 720, height: 960 },
                ],
                videos: [
                  { url: 'https://sns-video.xiaohongshu.com/v.mp4', thumbnail: 'https://ci.xiaohongshu.com/v.jpg' },
                ],
              }),
            },
          ],
        };
      },
      mediaReaderCallImpl: async ({ toolName, arguments: toolArgs }) => {
        mediaCalls.push({ toolName, arguments: toolArgs });
        assert.equal(toolName, 'analyze_media_batch');
        assert.equal(toolArgs.assets.length, 3);
        assert.equal(toolArgs.assets[0].type, 'image');
        return {
          structuredContent: {
            ok: true,
            partial: false,
            items: [{ asset_id: 'image-1', type: 'image', overall_summary: '图片里是内莉·布莱的故事卡片' }],
            merged_summary: '图片里是内莉·布莱的故事卡片',
            partial_failures: [],
            warnings: [],
          },
        };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial_success, true);
  assert.equal(result.structuredContent.images.length, 2);
  assert.equal(result.structuredContent.videos.length, 1);
  assert.equal(result.structuredContent.media.length, 3);
  assert.equal(result.structuredContent.media_assets.length, 3);
  assert.match(result.structuredContent.deep_summary, /内莉·布莱/);
  assert.equal(result.structuredContent.diagnostics.media_backend.ok, true);
  assert.equal(mediaCalls.length, 1);
  assert.ok(backendCalls.some((call) => call.server === 'generic'));
});

test('read_social_post_deep uses XHS-Downloader public sidecar when wanyi media fails', async () => {
  const noteId = '6a41cd4c000000000803df8e';
  const fetchCalls = [];
  const mediaCalls = [];

  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post_deep',
        arguments: {
          url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=fresh-token&xsec_source=pc_share`,
          media_detail: 'standard',
          include_media: true,
          max_media_assets: 5,
        },
      },
    },
    {
      env: {
        XHS_GENERIC_FALLBACK_READY_PATH: '/tmp/ran-agent-missing-xhs-generic-marker.json',
        XHS_PUBLIC_SIDECAR_URL: 'http://127.0.0.1:5556/xhs/detail',
      },
      fetchImpl: async (requestUrl, init = {}) => {
        fetchCalls.push({ requestUrl, init });
        assert.equal(requestUrl, 'http://127.0.0.1:5556/xhs/detail');
        assert.equal(JSON.parse(init.body).cookie, '');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              note: {
                id: noteId,
                title: '【AI小游戏·已开源】让你的AI当一回造物主',
                desc: '正文已经由 public sidecar 读到',
                imageList: [{
                  urlDefault: 'https://sns-webpic-qc.xhscdn.com/1040g008321vuhj0mne6g5n1o986hp0mku30kngg',
                  urlPre: 'https://sns-webpic-qc.xhscdn.com/1040g008321vuhj0mne6g5n1o986hp0mku30kngg!nc_n_webp_prv_1',
                  width: 936,
                  height: 1202,
                }],
              },
            },
          }),
        };
      },
      xhsBrowseCallImpl: async () => {
        throw new Error('xhs browse must not be called');
      },
      mcpCallImpl: async ({ server, toolName }) => {
        assert.equal(server, 'generic');
        assert.equal(toolName, 'parse_xhs_link');
        return { content: [{ type: 'text', text: '{"status":"error","message":"wanyi failed"}' }] };
      },
      mediaReaderCallImpl: async ({ toolName, arguments: toolArgs }) => {
        mediaCalls.push({ toolName, arguments: toolArgs });
        assert.equal(toolName, 'analyze_media_batch');
        assert.equal(toolArgs.assets.length, 1);
        assert.equal(toolArgs.assets[0].type, 'image');
        assert.equal(toolArgs.assets[0].url_host, 'sns-webpic-qc.xhscdn.com');
        return {
          structuredContent: {
            ok: true,
            partial: false,
            items: [{ asset_id: 'image-1', type: 'image', overall_summary: '图中展示了 ECO 游戏说明' }],
            merged_summary: '图中展示了 ECO 游戏说明',
            partial_failures: [],
            warnings: [],
          },
        };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial_success, false);
  assert.equal(result.structuredContent.source, 'xhs-downloader-sidecar');
  assert.equal(result.structuredContent.images.length, 1);
  assert.equal(result.structuredContent.media.length, 1);
  assert.equal(result.structuredContent.media_assets.length, 1);
  assert.equal(result.structuredContent.media_assets[0].type, 'image');
  assert.match(result.structuredContent.deep_summary, /ECO/);
  assert.equal(result.structuredContent.diagnostics.detail_backend.ok, true);
  assert.equal(result.structuredContent.diagnostics.media_backend.ok, true);
  assert.equal(mediaCalls.length, 1);
  assert.equal(fetchCalls.length, 1);
});

test('read_social_post_deep XHS public-only never calls account-backed browse or xhs MCP', async () => {
  const backendCalls = [];
  const mediaCalls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post_deep',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/public-deep?xsec_token=poison',
          include_media: true,
          media_detail: 'standard',
        },
      },
    },
    {
      env: {
        XHS_COOKIE: 'a1=secret',
        SOCIAL_READER_EXPOSE_XHS_BROWSE_TOOLS: 'true',
        XHS_BROWSE_ENABLED: 'true',
        XHS_BROWSE_MCP_COMMAND: 'mcporter',
        XHS_BROWSE_MCP_ARGS_JSON: '["serve","--servers","xiaohongshu","--stdio"]',
      },
      fetchImpl: async (url) => ({ url }),
      xhsBrowseCallImpl: async () => {
        throw new Error('xhs browse must not be called in public-only mode');
      },
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        backendCalls.push({ server, toolName, arguments: toolArgs });
        assert.equal(server, 'generic');
        assert.equal(toolName, 'parse_xhs_link');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              title: '公开 deep 标题',
              desc: '公开 deep 正文',
              images: [
                { urlDefault: 'https://sns-webpic-qc.xhscdn.com/public-deep-1', width: 936, height: 1202 },
                { urlDefault: 'https://sns-webpic-qc.xhscdn.com/public-deep-2', width: 936, height: 1202 },
              ],
            }),
          }],
        };
      },
      mediaReaderCallImpl: async ({ toolName, arguments: toolArgs }) => {
        mediaCalls.push({ toolName, arguments: toolArgs });
        assert.equal(toolName, 'analyze_media_batch');
        assert.equal(toolArgs.assets.length, 2);
        return {
          structuredContent: {
            ok: true,
            partial: false,
            items: toolArgs.assets.map((asset) => ({ asset_id: asset.asset_id, type: 'image', overall_summary: asset.asset_id })),
            merged_summary: '公开图片已分析',
            partial_failures: [],
            warnings: [],
          },
        };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.source, 'wanyi-watermark');
  assert.equal(result.structuredContent.images.length, 2);
  assert.equal(result.structuredContent.post_text, '公开 deep 正文');
  assert.equal(backendCalls.length, 1);
  assert.equal(mediaCalls.length, 1);
});

test('read_social_post_deep analyzes all default XHS media assets', async () => {
  const noteId = 'all-images-note';
  const imageList = Array.from({ length: 25 }, (_, index) => ({
    urlDefault: `https://sns-webpic-qc.xhscdn.com/all-${index + 1}`,
    width: 936,
    height: 1202,
  }));
  let analyzedAssetCount = 0;

  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post_deep',
        arguments: {
          url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=fresh-token`,
          include_media: true,
          media_detail: 'standard',
        },
      },
    },
    {
      env: {
        XHS_COOKIE: 'a1=secret',
      },
      fetchImpl: async (url) => ({ url }),
      xhsBrowseCallImpl: async () => {
        throw new Error('xhs browse must not be called');
      },
      mcpCallImpl: async ({ server, toolName }) => {
        assert.equal(server, 'generic');
        assert.equal(toolName, 'parse_xhs_link');
        return {
          content: [{ type: 'text', text: JSON.stringify({ title: '全图测试', desc: '正文', images: imageList }) }],
        };
      },
      mediaReaderCallImpl: async ({ toolName, arguments: toolArgs }) => {
        assert.equal(toolName, 'analyze_media_batch');
        analyzedAssetCount = toolArgs.assets.length;
        assert.equal(toolArgs.max_assets, 100);
        return {
          structuredContent: {
            ok: true,
            partial: false,
            items: toolArgs.assets.map((asset) => ({ asset_id: asset.asset_id, type: 'image', overall_summary: asset.asset_id })),
            merged_summary: '25 张图全部分析完成',
            partial_failures: [],
            warnings: [],
          },
        };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial_success, false);
  assert.equal(result.structuredContent.media_assets.length, 25);
  assert.equal(analyzedAssetCount, 25);
});

test('read_social_post_deep uses dedicated media reader timeout budget', async () => {
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post_deep',
        arguments: {
          url: 'https://v.douyin.com/share-demo',
          media_detail: 'standard',
        },
      },
    },
    {
      env: {
        SOCIAL_READER_MCP_TIMEOUT_MS: '45000',
        MEDIA_READER_MCP_TIMEOUT_MS: '900000',
      },
      fetchImpl: async (url) => ({ url }),
      mcpCallImpl: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ caption: '正文', media: [{ type: 'image', url: 'https://media.example.com/a.png' }] }) }],
      }),
      mediaReaderCallImpl: async ({ timeoutMs }) => {
        assert.equal(timeoutMs, 900000);
        return {
          structuredContent: {
            ok: true,
            partial: false,
            items: [{ asset_id: 'image-1', type: 'image', overall_summary: '图片摘要' }],
            merged_summary: '图片摘要',
            partial_failures: [],
            warnings: [],
          },
        };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.media_analysis.merged_summary, '图片摘要');
});

test('read_social_post_deep skips jobson detail path when XHS URL has no xsec token', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const markerDir = mkdtempSync(join(tmpdir(), 'xhs-deep-no-token-marker-'));
  const markerPath = join(markerDir, 'generic-fallback-ready.json');
  writeFileSync(markerPath, JSON.stringify({
    ok: true, package: 'wanyi-watermark', tool_name: 'parse_xhs_link',
    command: 'echo', args: [], backend_executable: '', backend_args: [],
    backend_python: 'echo', backend_module: 'test',
  }));

  const backendCalls = [];
  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post_deep',
        arguments: {
          url: 'http://xhslink.com/o/noTokenDemo',
          media_detail: 'standard',
          include_media: true,
        },
      },
    },
    {
      env: { XHS_GENERIC_FALLBACK_READY_PATH: markerPath },
      fetchImpl: async () => ({
        status: 302,
        headers: {
          get(name) {
            return name.toLowerCase() === 'location'
              ? 'https://www.xiaohongshu.com/explore/no-token-note'
              : null;
          },
        },
      }),
      mcpCallImpl: async ({ server, toolName, arguments: toolArgs }) => {
        backendCalls.push({ server, toolName, arguments: toolArgs });
        if (server === 'generic' && toolName === 'parse_xhs_link') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'success',
                title: '无 token 图文',
                desc: '描述来自 wanyi',
                images: [{ url_png: 'https://ci.xiaohongshu.com/no-token.png' }],
              }),
            }],
          };
        }
        throw new Error(`unexpected backend call ${server}.${toolName}`);
      },
      mediaReaderCallImpl: async ({ toolName, arguments: toolArgs }) => {
        assert.equal(toolName, 'analyze_media_batch');
        assert.equal(toolArgs.assets.length, 1);
        return {
          structuredContent: {
            ok: true,
            partial: false,
            items: [{ asset_id: 'image-1', type: 'image', overall_summary: 'OCR 读到了图片正文' }],
            merged_summary: 'OCR 读到了图片正文',
            partial_failures: [],
            warnings: [],
          },
        };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.match(result.structuredContent.deep_summary, /OCR/);
  assert.equal(backendCalls.some((call) => call.server === 'xhs' && call.toolName === 'get_note_content'), false);
});

test('read_social_post_deep reports XHS media truncation by max_media_assets', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const markerDir = mkdtempSync(join(tmpdir(), 'xhs-deep-truncated-marker-'));
  const markerPath = join(markerDir, 'generic-fallback-ready.json');
  writeFileSync(markerPath, JSON.stringify({
    ok: true, package: 'wanyi-watermark', tool_name: 'parse_xhs_link',
    command: 'echo', args: [], backend_executable: '', backend_args: [],
    backend_python: 'echo', backend_module: 'test',
  }));

  const imageItems = Array.from({ length: 25 }, (_, index) => ({
    url_png: `https://ci.xiaohongshu.com/page-${index}.png`,
  }));
  let analyzedAssets = null;

  const result = await handleSocialReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'read_social_post_deep',
        arguments: {
          url: 'https://www.xiaohongshu.com/explore/many-images',
          media_detail: 'standard',
          include_media: true,
          max_media_assets: 20,
        },
      },
    },
    {
      env: { XHS_GENERIC_FALLBACK_READY_PATH: markerPath },
      fetchImpl: async (url) => ({ url }),
      mcpCallImpl: async ({ server, toolName }) => {
        if (server === 'generic' && toolName === 'parse_xhs_link') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'success',
                title: '很多图',
                desc: '需要说明默认只分析部分图片',
                images: imageItems,
              }),
            }],
          };
        }
        return { content: [{ type: 'text', text: 'cookie已失效' }] };
      },
      mediaReaderCallImpl: async ({ toolName, arguments: toolArgs }) => {
        assert.equal(toolName, 'analyze_media_batch');
        analyzedAssets = toolArgs.assets;
        return {
          structuredContent: {
            ok: true,
            partial: false,
            items: [],
            merged_summary: '分析了前 20 张',
            partial_failures: [],
            warnings: [],
          },
        };
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.total_media_count, 25);
  assert.equal(result.structuredContent.analyzed_media_count, 20);
  assert.equal(result.structuredContent.successful_media_count, 0);
  assert.equal(result.structuredContent.truncated_by_max_assets, true);
  assert.deepEqual(result.structuredContent.warnings, ['XHS_MEDIA_ASSETS_TRUNCATED_BY_MAX_ASSETS']);
  assert.equal(analyzedAssets.length, 20);
});
