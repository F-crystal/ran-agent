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
