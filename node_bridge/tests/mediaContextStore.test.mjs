import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectInboundMediaAssets,
  ensureConversationMediaContext,
  renderConversationMediaContext,
} from '../src/mediaContextStore.mjs';

function tempProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'media-context-project-'));
}

test('ensureConversationMediaContext creates a reusable artifact for inbound local media', async () => {
  const projectRoot = tempProjectRoot();
  const imagePath = path.join(projectRoot, 'debug', 'wechat', 'inbound', 'screen.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  let analyzeCount = 0;
  const first = await ensureConversationMediaContext(
    {
      text: '帮我看这张截图',
      sender_id: 'wechat-user-media',
      media: [{ filePath: imagePath, mimeType: 'image/png', type: 'image' }],
    },
    {
      env: { RAN_AGENT_ROOT: projectRoot },
      analyzeMediaAssetImpl: async ({ asset }) => {
        analyzeCount += 1;
        return {
          ok: true,
          analyzer: 'media_reader',
          summary: `截图里是登录错误。asset=${asset.id}`,
          ocr_text: '登录失败',
          artifact_path: path.join(projectRoot, 'debug', 'media_context', 'fake.json'),
          provider_ref: 'qwen3-vl-flash',
        };
      },
    }
  );

  assert.equal(analyzeCount, 1);
  assert.equal(first.assets.length, 1);
  assert.equal(first.artifacts.length, 1);
  assert.match(first.contextText, /【最近媒体上下文/);
  assert.match(first.contextText, /截图里是登录错误/);
  assert.match(first.contextText, /登录失败/);
  assert.match(first.contextText, /artifact_id=/);

  const second = await ensureConversationMediaContext(
    {
      text: '刚才那张图里报什么错',
      sender_id: 'wechat-user-media',
      media: [{ filePath: imagePath, mimeType: 'image/png', type: 'image' }],
    },
    {
      env: { RAN_AGENT_ROOT: projectRoot },
      analyzeMediaAssetImpl: async () => {
        analyzeCount += 1;
        throw new Error('should reuse existing artifact');
      },
    }
  );

  assert.equal(analyzeCount, 1);
  assert.equal(second.artifacts.length, 1);
  assert.match(second.contextText, /刚才那张图|第一张截图/);
  assert.match(second.contextText, /截图里是登录错误/);
});

test('renderConversationMediaContext omits empty state and keeps compact artifact facts', () => {
  assert.equal(renderConversationMediaContext({ artifacts: [] }), '');

  const text = renderConversationMediaContext({
    artifacts: [
      {
        id: 'artifact-1',
        media_id: 'media-1',
        type: 'audio',
        analyzer: 'media_reader',
        summary: '用户语音说今天晚点回家。',
        transcript: '今天晚点回家',
        artifact_path: '/tmp/artifact.json',
      },
    ],
  });

  assert.match(text, /artifact_id=artifact-1/);
  assert.match(text, /media_id=media-1/);
  assert.match(text, /transcript: 今天晚点回家/);
  assert.doesNotMatch(text, /\/tmp\/artifact\.json/);
});

test('collectInboundMediaAssets rejects local media paths outside the project workspace', () => {
  const projectRoot = tempProjectRoot();

  assert.deepEqual(
    collectInboundMediaAssets({
      media: [{ filePath: '/etc/passwd', mimeType: 'text/plain', type: 'file' }],
    }, { env: { RAN_AGENT_ROOT: projectRoot } }),
    []
  );
});

test('collectInboundMediaAssets rejects project files outside trusted media directories', () => {
  const projectRoot = tempProjectRoot();
  const privatePath = path.join(projectRoot, 'node_bridge', '.env.local');
  fs.mkdirSync(path.dirname(privatePath), { recursive: true });
  fs.writeFileSync(privatePath, 'SECRET=value\n');

  assert.deepEqual(
    collectInboundMediaAssets({
      media: [{ filePath: privatePath, mimeType: 'text/plain', type: 'file' }],
    }, { env: { RAN_AGENT_ROOT: projectRoot } }),
    []
  );
});

test('collectInboundMediaAssets accepts downloaded Feishu inbound media', () => {
  const projectRoot = tempProjectRoot();
  const imagePath = path.join(projectRoot, '.ran_agent_state', 'feishu', 'inbound', 'feishu-image.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const assets = collectInboundMediaAssets({
    media: [{ filePath: imagePath, mimeType: 'image/png', type: 'image' }],
  }, { env: { RAN_AGENT_ROOT: projectRoot } });

  assert.equal(assets.length, 1);
  assert.equal(assets[0].type, 'image');
  assert.equal(assets[0].mime, 'image/png');
  assert.equal(assets[0].path, imagePath);
});

test('collectInboundMediaAssets ignores local paths passed through image_urls', () => {
  const projectRoot = tempProjectRoot();
  const imagePath = path.join(projectRoot, 'debug', 'wechat', 'inbound', 'screen.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  assert.deepEqual(
    collectInboundMediaAssets({
      image_urls: [imagePath, '/etc/passwd'],
    }, { env: { RAN_AGENT_ROOT: projectRoot } }),
    []
  );
});

test('ensureConversationMediaContext rejects media context dirs outside the project workspace', async () => {
  const projectRoot = tempProjectRoot();

  await assert.rejects(
    () => ensureConversationMediaContext(
      { text: '你好', sender_id: 'blocked-context-dir' },
      {
        env: {
          RAN_AGENT_ROOT: projectRoot,
          PERSONAL_AGENT_MEDIA_CONTEXT_DIR: '/tmp/outside-media-context',
        },
      }
    ),
    /MEDIA_CONTEXT_DIR_BLOCKED/
  );
});

test('ensureConversationMediaContext uses media_reader even when user mentions retired MiMo', async () => {
  const projectRoot = tempProjectRoot();
  const imagePath = path.join(projectRoot, 'debug', 'wechat', 'inbound', 'screen.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const result = await ensureConversationMediaContext(
    {
      text: '用 MiMo 看这张截图',
      sender_id: 'wechat-user-retired-media-tool',
      media: [{ filePath: imagePath, mimeType: 'image/png', type: 'image' }],
    },
    {
      env: { RAN_AGENT_ROOT: projectRoot },
      mediaReaderAnalyzeImpl: async ({ toolName, args }) => {
        assert.equal(toolName, 'analyze_image');
        assert.equal(args.file_path, imagePath);
        return {
          structuredContent: {
            ok: true,
            scene_summary: '截图里是登录框。',
            ocr_text: '登录',
          },
        };
      },
    }
  );

  assert.equal(result.artifacts[0].ok, true);
  assert.equal(result.artifacts[0].analyzer, 'media_reader');
  assert.match(result.contextText, /截图里是登录框/);
});

test('ensureConversationMediaContext analyzes image through media_reader facade', async () => {
  const projectRoot = tempProjectRoot();
  const imagePath = path.join(projectRoot, 'debug', 'wechat', 'inbound', 'screen.png');
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  let mediaReaderCall = null;
  const result = await ensureConversationMediaContext(
    {
      text: '帮我看这张截图',
      sender_id: 'wechat-user-fallback',
      media: [{ filePath: imagePath, mimeType: 'image/png', type: 'image' }],
    },
    {
      env: { RAN_AGENT_ROOT: projectRoot },
      mediaReaderAnalyzeImpl: async ({ toolName, args }) => {
        mediaReaderCall = { toolName, args };
        return {
          structuredContent: {
            ok: true,
            scene_summary: '截图里有登录框。',
            ocr_text: '登录',
            model: { vlm: 'qwen3-vl-flash' },
          },
        };
      },
    }
  );

  assert.equal(mediaReaderCall.toolName, 'analyze_image');
  assert.equal(mediaReaderCall.args.file_path, imagePath);
  assert.equal(result.artifacts[0].analyzer, 'media_reader');
  assert.match(result.contextText, /截图里有登录框/);
});

test('ensureConversationMediaContext keeps video media_reader subtitle/audio first', async () => {
  const projectRoot = tempProjectRoot();
  const videoPath = path.join(projectRoot, 'debug', 'wechat', 'inbound', 'clip.mp4');
  fs.mkdirSync(path.dirname(videoPath), { recursive: true });
  fs.writeFileSync(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x18]));

  let mediaReaderCall = null;
  await ensureConversationMediaContext(
    {
      text: '帮我看这个视频',
      sender_id: 'wechat-user-video-fallback',
      media: [{ filePath: videoPath, mimeType: 'video/mp4', type: 'video' }],
    },
    {
      env: { RAN_AGENT_ROOT: projectRoot },
      mediaReaderAnalyzeImpl: async ({ toolName, args }) => {
        mediaReaderCall = { toolName, args };
        return {
          structuredContent: {
            ok: true,
            overall_summary: '视频音频里说晚上开会。',
            asr: { transcript: '晚上开会' },
          },
        };
      },
    }
  );

  assert.equal(mediaReaderCall.toolName, 'analyze_video');
  assert.equal(mediaReaderCall.args.include_audio, true);
  assert.equal(mediaReaderCall.args.include_ocr, false);
  assert.equal(mediaReaderCall.args.include_vlm, false);
});
