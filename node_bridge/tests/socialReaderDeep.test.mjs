import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSocialReaderTools, handleSocialReaderMcpRequest } from '../src/socialReaderMcpServer.mjs';

test('social reader exposes read_social_post_deep with standard media detail default', () => {
  const tools = buildSocialReaderTools();
  const deepTool = tools.find((tool) => tool.name === 'read_social_post_deep');

  assert.ok(deepTool);
  assert.deepEqual(deepTool.inputSchema.properties.media_detail.enum, ['none', 'basic', 'standard', 'full']);
  assert.equal(deepTool.inputSchema.properties.media_detail.default, 'standard');
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
