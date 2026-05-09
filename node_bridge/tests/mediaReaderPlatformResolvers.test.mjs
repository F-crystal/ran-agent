import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMediaReaderTools,
  handleMediaReaderMcpRequest,
} from '../src/mediaReaderMcpServer.mjs';

function redirectResponse({ url, location, status = 302 }) {
  return {
    ok: false,
    status,
    url,
    headers: {
      get: (name) => String(name || '').toLowerCase() === 'location' ? location : '',
    },
  };
}

function okResponse({ url }) {
  return {
    ok: true,
    status: 200,
    url,
    headers: {
      get: () => '',
    },
  };
}

function statusResponse({ url, status, body = '' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: () => '',
    },
    text: async () => body,
  };
}

async function callResolve(arguments_, options = {}) {
  return await handleMediaReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'resolve_platform_media',
        arguments: arguments_,
      },
    },
    options
  );
}

test('media reader exposes resolve_platform_media facade tool', () => {
  const tools = buildMediaReaderTools();
  assert.ok(tools.some((tool) => tool.name === 'resolve_platform_media'));
  const tool = tools.find((item) => item.name === 'resolve_platform_media');
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.inputSchema.properties.platform.enum, ['auto', 'bilibili', 'xhs', 'wechat_article']);
});

test('resolve_platform_media resolves Bilibili share text through safe shortlink and provider', async () => {
  const providerCalls = [];
  const result = await callResolve(
    {
      url_or_text: '【标题-哔哩哔哩】 https://b23.tv/xMvq8vT',
      platform: 'auto',
      media_detail: 'standard',
      include_comments: false,
    },
    {
      fetchImpl: async (url) => {
        assert.equal(url, 'https://b23.tv/xMvq8vT');
        return redirectResponse({
          url,
          location: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2&spm_id_from=333',
        });
      },
      resolveHostnameImpl: async () => ['93.184.216.34'],
      platformProviders: {
        bilibili: {
          resolve: async (input) => {
            providerCalls.push(input);
            return {
              metadata: { title: '标题', bvid: input.bvid, page: input.page },
              post_text: 'B 站正文',
              subtitle: { text: '字幕正文', language: 'zh' },
              media: [
                { type: 'cover', url: 'https://i0.hdslb.com/bfs/archive/cover.jpg', mime: 'image/jpeg' },
                { type: 'subtitle', text: '字幕正文', mime: 'text/plain' },
              ],
            };
          },
        },
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.platform, 'bilibili');
  assert.equal(result.structuredContent.resolver, 'bilibiliResolver');
  assert.equal(result.structuredContent.metadata.bvid, 'BV1xx411c7mD');
  assert.equal(result.structuredContent.metadata.page, 2);
  assert.equal(result.structuredContent.transcript_source, 'subtitle');
  assert.equal(result.structuredContent.visual_source, 'thumbnail');
  assert.equal(result.structuredContent.media[0].url, undefined);
  assert.equal(result.structuredContent.media[0].url_redacted, 'https://i0.hdslb.com/bfs/archive/cover.jpg');
  assert.equal(providerCalls[0].page, 2);
});

test('resolve_platform_media accepts clean Bilibili shortlink and clean long URL', async () => {
  let calls = 0;
  let fetchCalls = 0;
  const options = {
    fetchImpl: async (url) => {
      fetchCalls += 1;
      return redirectResponse({
        url,
        location: 'https://www.bilibili.com/video/BV1yy411c7mE',
      });
    },
    resolveHostnameImpl: async () => ['93.184.216.34'],
    platformProviders: {
      bilibili: {
        resolve: async (input) => {
          calls += 1;
          return { metadata: { bvid: input.bvid }, post_text: '', media: [] };
        },
      },
    },
  };

  const shortResult = await callResolve({ url_or_text: 'https://b23.tv/xMvq8vT' }, options);
  const longResult = await callResolve({ url_or_text: 'https://www.bilibili.com/video/BV1zz411c7mF?p=2' }, options);

  assert.equal(shortResult.structuredContent.ok, true);
  assert.equal(longResult.structuredContent.ok, true);
  assert.equal(longResult.structuredContent.metadata.page, 2);
  assert.equal(calls, 2);
  assert.equal(fetchCalls, 1);
});

test('resolve_platform_media returns Bilibili shortlink 412 without calling yt-dlp', async () => {
  let execCalled = false;
  const result = await callResolve(
    { url_or_text: '【标题-哔哩哔哩】 https://b23.tv/xMvq8vT', platform: 'bilibili' },
    {
      env: { PERSONAL_AGENT_YTDLP_PATH: 'yt-dlp' },
      fetchImpl: async (url) => statusResponse({ url, status: 412 }),
      resolveHostnameImpl: async () => ['93.184.216.34'],
      execFileImpl: async () => {
        execCalled = true;
        throw new Error('yt-dlp should not be called');
      },
    }
  );

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.platform, 'bilibili');
  assert.equal(result.structuredContent.http_status, 412);
  assert.match(result.structuredContent.error_code, /BILIBILI_SHORTLINK_BLOCKED|BILIBILI_PRECONDITION_FAILED/);
  assert.match(result.structuredContent.recovery_suggestion, /SESSDATA|代理|字幕文本/);
  assert.equal(execCalled, false);
});

test('resolve_platform_media maps yt-dlp HTTP 412 and passes redaction-sensitive config only to argv', async () => {
  const calls = [];
  const result = await callResolve(
    { url_or_text: 'https://www.bilibili.com/video/BV1xx411c7mD', platform: 'bilibili' },
    {
      env: {
        PERSONAL_AGENT_YTDLP_PATH: 'yt-dlp',
        PERSONAL_AGENT_YTDLP_PROXY: 'http://user:secret@proxy.example:8080',
        PERSONAL_AGENT_BILIBILI_ALLOW_AUTH_COOKIES: 'true',
        PERSONAL_AGENT_BILIBILI_SESSDATA_ENV: 'BILI_TEST_SESSDATA',
        BILI_TEST_SESSDATA: 'secret-sessdata',
      },
      resolveHostnameImpl: async () => ['93.184.216.34'],
      execFileImpl: async (command, args) => {
        calls.push({ command, args });
        const error = new Error('ERROR: Unable to download JSON metadata: HTTP Error 412: Precondition Failed');
        error.stderr = 'HTTP Error 412: Precondition Failed';
        throw error;
      },
    }
  );

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'BILIBILI_PRECONDITION_FAILED');
  assert.equal(result.structuredContent.http_status, 412);
  assert.equal(result.structuredContent.used_proxy, true);
  assert.equal(result.structuredContent.has_sessdata, true);
  assert.ok(calls[0].args.includes('--proxy'));
  assert.ok(calls[0].args.includes('http://user:secret@proxy.example:8080'));
  assert.ok(calls[0].args.includes('--add-header'));
  assert.ok(calls[0].args.includes('Cookie: SESSDATA=secret-sessdata'));
});

test('resolve_platform_media maps Bilibili forbidden and auth stderr to explicit errors', async () => {
  const forbidden = await callResolve(
    { url_or_text: 'https://www.bilibili.com/video/BV1xx411c7mD', platform: 'bilibili' },
    {
      env: { PERSONAL_AGENT_YTDLP_PATH: 'yt-dlp' },
      resolveHostnameImpl: async () => ['93.184.216.34'],
      execFileImpl: async () => {
        const error = new Error('HTTP Error 403: Forbidden');
        error.stderr = 'HTTP Error 403: Forbidden';
        throw error;
      },
    }
  );
  assert.equal(forbidden.isError, true);
  assert.match(forbidden.structuredContent.error_code, /MEDIA_DOWNLOAD_FORBIDDEN|BILIBILI_AUTH_REQUIRED/);

  const auth = await callResolve(
    { url_or_text: 'https://www.bilibili.com/video/BV1xx411c7mD', platform: 'bilibili' },
    {
      env: { PERSONAL_AGENT_YTDLP_PATH: 'yt-dlp' },
      resolveHostnameImpl: async () => ['93.184.216.34'],
      execFileImpl: async () => {
        const error = new Error('Login required. Use cookies for auth');
        error.stderr = 'Login required. Use cookies for auth';
        throw error;
      },
    }
  );
  assert.equal(auth.isError, true);
  assert.equal(auth.structuredContent.error_code, 'BILIBILI_AUTH_REQUIRED');
});

test('resolve_platform_media recognizes WeChat articles and captcha pages', async () => {
  const result = await callResolve(
    { url_or_text: '看看这篇 https://mp.weixin.qq.com/s/demo ，复制打开', platform: 'auto' },
    {
      fetchImpl: async (url) => statusResponse({
        url: 'https://mp.weixin.qq.com/s/demo',
        status: 200,
        body: '<html><head><title>验证码</title></head><body>wappoc_appmsgcaptcha 环境异常</body></html>',
      }),
      resolveHostnameImpl: async () => ['93.184.216.34'],
    }
  );

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.platform, 'wechat_article');
  assert.equal(result.structuredContent.captcha_detected, true);
  assert.equal(result.structuredContent.error_code, 'WECHAT_CAPTCHA_REQUIRED');
  assert.match(result.structuredContent.recovery_suggestion, /复制正文|PDF|wechat-reader/);
});

test('resolve_platform_media returns WeChat dynamic content unavailable for shell-only HTML', async () => {
  const result = await callResolve(
    { url_or_text: 'https://mp.weixin.qq.com/s/demo', platform: 'wechat_article' },
    {
      fetchImpl: async (url) => statusResponse({
        url,
        status: 200,
        body: '<html><head><title>文章标题</title></head><body><div id="js_article"></div><script>render()</script></body></html>',
      }),
      resolveHostnameImpl: async () => ['93.184.216.34'],
    }
  );

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.platform, 'wechat_article');
  assert.equal(result.structuredContent.error_code, 'WECHAT_DYNAMIC_CONTENT_UNAVAILABLE');
  assert.equal(result.structuredContent.captcha_detected, false);
});

test('resolve_platform_media rejects non-Bilibili links and unsafe Bilibili redirects', async () => {
  const nonBilibili = await callResolve({
    url_or_text: 'https://example.com/video/BV1xx411c7mD',
    platform: 'bilibili',
  });

  assert.equal(nonBilibili.isError, true);
  assert.equal(nonBilibili.structuredContent.error_code, 'UNSUPPORTED_PLATFORM');

  const unsafeRedirect = await callResolve(
    { url_or_text: 'https://b23.tv/xMvq8vT' },
    {
      fetchImpl: async (url) => redirectResponse({ url, location: 'https://evil.example/video/BV1xx411c7mD' }),
      resolveHostnameImpl: async () => ['93.184.216.34'],
      platformProviders: {
        bilibili: { resolve: async () => ({ metadata: {}, media: [] }) },
      },
    }
  );

  assert.equal(unsafeRedirect.isError, true);
  assert.equal(unsafeRedirect.structuredContent.error_code, 'SHORTLINK_RESOLVE_FAILED');
});

test('resolve_platform_media rejects platform redirects whose final host resolves privately', async () => {
  let dnsCalls = 0;
  const result = await callResolve(
    { url_or_text: 'https://mp.weixin.qq.com/s/demo', platform: 'wechat_article' },
    {
      fetchImpl: async (url) => redirectResponse({ url, location: 'https://mp.weixin.qq.com/s/private' }),
      resolveHostnameImpl: async () => {
        dnsCalls += 1;
        return dnsCalls === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
      },
    }
  );

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'PRIVATE_NETWORK_BLOCKED');
});

test('resolve_platform_media returns structured Bilibili dependency errors when provider is missing', async () => {
  const result = await callResolve({
    url_or_text: 'https://www.bilibili.com/video/BV1xx411c7mD',
    platform: 'bilibili',
  }, {
    resolveHostnameImpl: async () => ['93.184.216.34'],
  });

  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error_code, /DEPENDENCY_MISSING|PLATFORM_RESOLVER_NOT_CONFIGURED/);
});

test('resolve_platform_media resolves XHS share text and warns when video asset is hidden by backend', async () => {
  const result = await callResolve(
    {
      url_or_text: '标题/正文片段 ... http://xhslink.com/o/xxxx 复制打开小红书',
      include_comments: true,
      max_comments: 2,
    },
    {
      fetchImpl: async (url) => redirectResponse({
        url,
        location: 'https://www.xiaohongshu.com/explore/65f000000000000000000001?xsec_token=redacted-in-test',
      }),
      resolveHostnameImpl: async () => ['93.184.216.34'],
      platformProviders: {
        xhs: {
          resolve: async () => ({
            metadata: { title: '小红书标题', note_id: '65f000000000000000000001', has_video: true },
            post_text: '小红书正文',
            comments: ['评论一', '评论二', '评论三'],
            media: [
              { type: 'image', url: 'https://sns-img.xhscdn.com/image.jpg', mime: 'image/jpeg' },
            ],
          }),
        },
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.platform, 'xhs');
  assert.equal(result.structuredContent.resolver, 'xhsResolver');
  assert.deepEqual(result.structuredContent.comments, ['评论一', '评论二']);
  assert.equal(result.structuredContent.media[0].url, undefined);
  assert.equal(result.structuredContent.media[0].url_redacted, 'https://sns-img.xhscdn.com/image.jpg');
  assert.ok(result.structuredContent.warnings.some((warning) => warning.code === 'XHS_VIDEO_ASSET_NOT_EXPOSED_BY_BACKEND'));
});

test('resolve_platform_media returns structured XHS shortlink and auth errors', async () => {
  const shortlinkFailure = await callResolve(
    { url_or_text: 'https://xhslink.com/o/xxxx', platform: 'xhs' },
    {
      fetchImpl: async () => {
        throw new Error('network timeout');
      },
      resolveHostnameImpl: async () => ['93.184.216.34'],
      platformProviders: {
        xhs: { resolve: async () => ({ metadata: {}, media: [] }) },
      },
    }
  );
  assert.equal(shortlinkFailure.isError, true);
  assert.equal(shortlinkFailure.structuredContent.error_code, 'XHS_SHORTLINK_RESOLVE_FAILED');

  const authFailure = await callResolve(
    { url_or_text: 'https://www.xiaohongshu.com/explore/65f000000000000000000001', platform: 'xhs' },
    {
      resolveHostnameImpl: async () => ['93.184.216.34'],
      platformProviders: {
        xhs: {
          resolve: async () => {
            const error = new Error('login required');
            error.error_code = 'XHS_AUTH_REQUIRED';
            throw error;
          },
        },
      },
    }
  );
  assert.equal(authFailure.isError, true);
  assert.equal(authFailure.structuredContent.error_code, 'XHS_AUTH_REQUIRED');
});

test('analyze_video routes platform pages through platform resolver instead of direct ffprobe', async () => {
  let providerCalled = false;
  const result = await handleMediaReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'analyze_video',
        arguments: { url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
      },
    },
    {
      resolveHostnameImpl: async () => ['93.184.216.34'],
      fetchImpl: async () => {
        throw new Error('direct media download must not run for platform pages');
      },
      platformProviders: {
        bilibili: {
          resolve: async () => {
            providerCalled = true;
            return {
              metadata: { title: '标题', bvid: 'BV1xx411c7mD' },
              subtitle: { text: '字幕正文' },
              media: [{ type: 'subtitle', text: '字幕正文' }],
            };
          },
        },
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.type, 'platform_video');
  assert.equal(result.structuredContent.platform, 'bilibili');
  assert.equal(providerCalled, true);
});

test('analyze_video returns explicit Bilibili 412 instead of retrying as direct media', async () => {
  const result = await handleMediaReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'analyze_video',
        arguments: { url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
      },
    },
    {
      env: { PERSONAL_AGENT_YTDLP_PATH: 'yt-dlp' },
      resolveHostnameImpl: async () => ['93.184.216.34'],
      execFileImpl: async () => {
        const error = new Error('HTTP Error 412: Precondition Failed');
        error.stderr = 'HTTP Error 412: Precondition Failed';
        throw error;
      },
    }
  );

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'BILIBILI_PRECONDITION_FAILED');
  assert.equal(result.structuredContent.http_status, 412);
  assert.match(result.structuredContent.recovery_suggestion, /SESSDATA|代理|字幕文本/);
});

test('analyze_media_batch keeps platform resolver and single media failures partial', async () => {
  const result = await handleMediaReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'analyze_media_batch',
        arguments: {
          assets: [
            { asset_id: 'platform-1', type: 'platform', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
            { asset_id: 'unknown-1', type: 'unknown', url: 'https://cdn.example.com/file.bin' },
          ],
          media_detail: 'standard',
        },
      },
    },
    {
      resolveHostnameImpl: async () => ['93.184.216.34'],
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial, true);
  assert.ok(Array.isArray(result.structuredContent.partial_failures));
  assert.ok(result.structuredContent.partial_failures.length >= 1);
  assert.ok(result.structuredContent.warnings.length >= 1);
});

test('analyze_media_batch keeps Bilibili 412 as a partial failure', async () => {
  const result = await handleMediaReaderMcpRequest(
    {
      method: 'tools/call',
      params: {
        name: 'analyze_media_batch',
        arguments: {
          assets: [
            { asset_id: 'platform-1', type: 'platform', url: 'https://www.bilibili.com/video/BV1xx411c7mD', platform: 'bilibili' },
          ],
          media_detail: 'standard',
        },
      },
    },
    {
      env: { PERSONAL_AGENT_YTDLP_PATH: 'yt-dlp' },
      resolveHostnameImpl: async () => ['93.184.216.34'],
      execFileImpl: async () => {
        const error = new Error('HTTP Error 412: Precondition Failed');
        error.stderr = 'HTTP Error 412: Precondition Failed';
        throw error;
      },
    }
  );

  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.partial, true);
  assert.equal(result.structuredContent.items.length, 0);
  assert.equal(result.structuredContent.partial_failures[0].asset_id, 'platform-1');
  assert.equal(result.structuredContent.partial_failures[0].error_code, 'BILIBILI_PRECONDITION_FAILED');
  assert.ok(result.structuredContent.warnings.includes('BILIBILI_PRECONDITION_FAILED'));
});
