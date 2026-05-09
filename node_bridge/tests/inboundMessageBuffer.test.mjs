/**
 * Tests for inbound message buffer — WeChat turn aggregation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInboundMessageBuffer, isMediaRefText, isMediaOnlyPayload } from '../src/inboundMessageBuffer.mjs';

function makePayload(overrides = {}) {
  return {
    text: '',
    sender_id: 'user-1',
    channel: 'wechat',
    image_urls: [],
    media: [],
    ...overrides,
  };
}

function makeMediaPayload(senderId = 'user-1') {
  return makePayload({
    sender_id: senderId,
    media: [{ filePath: '/tmp/img.png', mimeType: 'image/png', type: 'image' }],
  });
}

describe('isMediaRefText', () => {
  it('matches common media reference patterns', () => {
    assert.equal(isMediaRefText('用 mimo 读一下'), true);
    assert.equal(isMediaRefText('用MiMo分析'), true);
    assert.equal(isMediaRefText('读一下图片'), true);
    assert.equal(isMediaRefText('分析这个'), true);
    assert.equal(isMediaRefText('看看刚才那张图'), true);
    assert.equal(isMediaRefText('这个文件是什么'), true);
    assert.equal(isMediaRefText('图里是什么'), true);
    assert.equal(isMediaRefText('帮我看一下'), true);
    assert.equal(isMediaRefText('看看这个'), true);
    assert.equal(isMediaRefText('识别一下'), true);
  });

  it('does not match plain conversation text', () => {
    assert.equal(isMediaRefText('你好'), false);
    assert.equal(isMediaRefText('今天天气怎么样'), false);
    assert.equal(isMediaRefText('帮我写个邮件'), false);
    assert.equal(isMediaRefText(''), false);
  });
});

describe('isMediaOnlyPayload', () => {
  it('returns true for payload with media but no text', () => {
    assert.equal(isMediaOnlyPayload(makeMediaPayload()), true);
  });

  it('returns false for payload with text', () => {
    assert.equal(isMediaOnlyPayload(makePayload({ text: 'hello', media: [{ filePath: '/tmp/a.png', mimeType: 'image/png', type: 'image' }] })), false);
  });

  it('returns false for empty payload', () => {
    assert.equal(isMediaOnlyPayload(makePayload()), false);
  });
});

describe('inbound message buffer', () => {
  it('holds media-only messages and does not trigger reply', async () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });
    const result = await buffer.processInbound(makeMediaPayload());
    assert.equal(result.action, 'hold');
    const stats = buffer.getStats();
    assert.equal(stats.entries.length, 1);
    assert.equal(stats.entries[0].pendingCount, 1);
    buffer.clear();
  });

  it('merges media then text-ref even with 15s gap', async () => {
    let now = 1000;
    const buffer = createInboundMessageBuffer({
      pendingMediaTtlMs: 600000,
      textRefWaitMs: 8000,
      nowImpl: () => now,
    });

    // Media arrives
    const hold = await buffer.processInbound(makeMediaPayload());
    assert.equal(hold.action, 'hold');

    // 15 seconds later, text arrives
    now += 15000;
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '用 mimo 读一下',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(result.payload.media);
    assert.equal(result.payload.media.length, 1);
    assert.equal(result.payload.media[0].filePath, '/tmp/img.png');
    buffer.clear();
  });

  it('does not bind media after TTL expiry', async () => {
    let now = 1000;
    const buffer = createInboundMessageBuffer({
      pendingMediaTtlMs: 600000,
      textRefWaitMs: 100, // short wait so test is fast
      nowImpl: () => now,
    });

    // Media arrives
    await buffer.processInbound(makeMediaPayload());

    // 601 seconds later (past TTL)
    now += 601000;
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '用 mimo 读一下',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(!result.payload.media || result.payload.media.length === 0);
    buffer.clear();
  });

  it('does not bind plain text to recent media', async () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });

    // Media arrives
    await buffer.processInbound(makeMediaPayload());

    // Plain text arrives (not a media ref)
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '你好',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(!result.payload.media || result.payload.media.length === 0);

    // Pending media should still be there
    const stats = buffer.getStats();
    assert.equal(stats.entries.length, 1);
    assert.equal(stats.entries[0].pendingCount, 1);
    buffer.clear();
  });

  it('waits for media when text-ref arrives first, merges when media comes within window', async () => {
    const buffer = createInboundMessageBuffer({
      textRefWaitMs: 8000,
      pendingMediaTtlMs: 600000,
    });

    // Text-ref arrives first (no pending media)
    const textPromise = buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '用 mimo 读一下',
    }));

    // Give the async processInbound a tick to start waiting
    await new Promise((r) => setTimeout(r, 10));

    // Media arrives 6 seconds later — should resolve the wait
    const mediaPayload = makeMediaPayload('user-1');
    buffer.resolveTextRefWait('user-1', mediaPayload);

    const result = await textPromise;
    assert.equal(result.action, 'reply');
    assert.ok(result.payload.media);
    assert.equal(result.payload.media.length, 1);
    buffer.clear();
  });

  it('preserves pending media after grace timeout (TTL controls lifetime)', async () => {
    let now = 1000;
    const buffer = createInboundMessageBuffer({
      mediaReplyGraceMs: 12000,
      pendingMediaTtlMs: 600000,
      nowImpl: () => now,
    });

    // Media arrives
    await buffer.processInbound(makeMediaPayload());

    // 30 seconds later (past grace, within TTL) — media should still be there
    now += 30000;
    const stats = buffer.getStats();
    assert.equal(stats.entries.length, 1);
    assert.equal(stats.entries[0].pendingCount, 1);

    // Text-ref should still merge
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '分析这个',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(result.payload.media);
    assert.equal(result.payload.media.length, 1);
    buffer.clear();
  });

  it('marks media as consumed after merge, prevents double-binding', async () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000, textRefWaitMs: 100 });

    // Media arrives
    await buffer.processInbound(makeMediaPayload());

    // First text-ref merges
    const result1 = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '用 mimo 读一下',
    }));
    assert.equal(result1.action, 'reply');
    assert.ok(result1.payload.media);
    assert.equal(result1.payload.media.length, 1);

    // Second text-ref should NOT get the same media
    const result2 = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '看看刚才那张图',
    }));
    assert.equal(result2.action, 'reply');
    assert.ok(!result2.payload.media || result2.payload.media.length === 0);
    buffer.clear();
  });

  it('handles multiple media batches for same sender', async () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });

    // Two media messages arrive
    await buffer.processInbound(makeMediaPayload('user-1'));
    await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      media: [{ filePath: '/tmp/img2.png', mimeType: 'image/png', type: 'image' }],
    }));

    const stats = buffer.getStats();
    assert.equal(stats.entries.length, 1);
    assert.equal(stats.entries[0].pendingCount, 2);

    // Text-ref merges both
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '分析这些图片',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(result.payload.media);
    assert.equal(result.payload.media.length, 2);
    buffer.clear();
  });

  it('isolates pending media per sender', async () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000, textRefWaitMs: 100 });

    // User-1 sends media
    await buffer.processInbound(makeMediaPayload('user-1'));
    // User-2 sends text-ref — should not get user-1's media
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-2',
      text: '用 mimo 读一下',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(!result.payload.media || result.payload.media.length === 0);
    buffer.clear();
  });
});
