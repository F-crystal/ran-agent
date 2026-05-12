/**
 * Tests for inbound message buffer — WeChat turn aggregation.
 * 
 * Tests cover three merge paths:
 * 1. Explicit ref: text matches MEDIA_REF_PATTERNS → strong bind, consumed=true
 * 2. Implicit candidate: plain text within window → soft attach, consumed=false
 * 3. Deferred: text-ref arrives first, media arrives later
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

function makeMediaPayload(senderId = 'user-1', filePath = '/tmp/img.png') {
  return makePayload({
    sender_id: senderId,
    media: [{ filePath, mimeType: 'image/png', type: 'image' }],
  });
}

describe('isMediaRefText', () => {
  it('matches common media reference patterns', () => {
    assert.equal(isMediaRefText('用 mimo 读一下'), true);
    assert.equal(isMediaRefText('用 MiMo 分析'), true);
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
    // Implicit references that should NOT match explicit pattern
    assert.equal(isMediaRefText('怎么样？'), false);
    assert.equal(isMediaRefText('这个呢？'), false);
    assert.equal(isMediaRefText('对吗？'), false);
    assert.equal(isMediaRefText('好看吗？'), false);
    assert.equal(isMediaRefText('啥意思？'), false);
    assert.equal(isMediaRefText('笑死'), false);
    assert.equal(isMediaRefText('你看'), false);
  });
});

describe('isMediaOnlyPayload', () => {
  it('returns true for payload with media but no text', () => {
    assert.equal(isMediaOnlyPayload(makeMediaPayload()), true);
  });

  it('returns false for payload with text', () => {
    assert.equal(isMediaOnlyPayload(makePayload({
      text: 'hello',
      media: [{ filePath: '/tmp/a.png', mimeType: 'image/png', type: 'image' }],
    })), false);
  });

  it('returns false for empty payload', () => {
    assert.equal(isMediaOnlyPayload(makePayload()), false);
  });
});

describe('inbound message buffer - explicit reference', () => {
  it('holds media-only messages and does not trigger reply', async () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });
    const result = await buffer.processInbound(makeMediaPayload());
    assert.equal(result.action, 'hold');
    const stats = buffer.getStats();
    assert.equal(stats.pendingMedia.length, 1);
    assert.equal(stats.pendingMedia[0].itemCount, 1);
  });

  it('merges media then text-ref even with 15s gap', async () => {
    let now = 1000;
    const buffer = createInboundMessageBuffer({
      pendingMediaTtlMs: 600000,
      textRefWaitMs: 30000,
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
    // Verify explicit_ref relation and consumed
    assert.ok(result.payload.media_candidates);
    assert.equal(result.payload.media_candidates[0].relation, 'explicit_ref');
    assert.equal(result.payload.media_candidates[0].confidence, 1.0);
  });

  it('does not bind media after TTL expiry', async () => {
    let now = 1000;
    const buffer = createInboundMessageBuffer({
      pendingMediaTtlMs: 600000,
      textRefWaitMs: 100,
      pendingTextRefTtlMs: 100,
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
  });

  it('marks media as consumed after explicit ref merge, prevents double-binding', async () => {
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
  });
});

describe('inbound message buffer - implicit reference (recent_candidate)', () => {
  it('attaches recent media as candidate for plain text "怎么样？"', async () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });

    // Media arrives
    await buffer.processInbound(makeMediaPayload());

    // Plain text "怎么样？" arrives
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '怎么样？',
    }));
    assert.equal(result.action, 'reply');
    // Should have media attached as candidate
    assert.ok(result.payload.media);
    assert.equal(result.payload.media.length, 1);
    // Verify recent_candidate relation
    assert.ok(result.payload.media_candidates);
    assert.equal(result.payload.media_candidates[0].relation, 'recent_candidate');
    assert.equal(result.payload.media_candidates[0].confidence, 0.5);
    
    // Media should NOT be consumed (still available for explicit ref)
    const stats = buffer.getStats();
    assert.equal(stats.pendingMedia.length, 1);
    assert.equal(stats.pendingMedia[0].unconsumedCount, 1);
  });

  it('attaches recent media as candidate for "好看吗？"', async () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });

    // Media arrives
    await buffer.processInbound(makeMediaPayload());

    // Plain text "好看吗？" arrives
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '好看吗？',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(result.payload.media);
    assert.ok(result.payload.media_candidates);
    assert.equal(result.payload.media_candidates[0].relation, 'recent_candidate');
  });

  it('decays the same recent media candidate across ordinary follow-up turns', async () => {
    const buffer = createInboundMessageBuffer({
      pendingMediaTtlMs: 600000,
      logger: { log() {} },
    });

    await buffer.processInbound(makeMediaPayload('user-1', '/tmp/img.png'));

    const first = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '怎么样？',
    }));
    const second = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '继续说',
    }));
    const third = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '还有呢',
    }));

    assert.equal(first.payload.media_candidates[0].confidence, 0.5);
    assert.ok(
      second.payload.media_candidates[0].confidence < first.payload.media_candidates[0].confidence,
      'confidence decays on the next ordinary turn'
    );
    assert.ok(
      !third.payload.media_candidates,
      'candidate drops once decayed below the global threshold'
    );
  });

  it('allows subsequent explicit ref after implicit ref (media not consumed)', async () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });

    // Media arrives
    await buffer.processInbound(makeMediaPayload());

    // First: implicit ref "怎么样？"
    const result1 = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '怎么样？',
    }));
    assert.equal(result1.action, 'reply');
    assert.ok(result1.payload.media_candidates);
    assert.equal(result1.payload.media_candidates[0].relation, 'recent_candidate');

    // Second: explicit ref "看看这个" should still work
    const result2 = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '看看这个',
    }));
    assert.equal(result2.action, 'reply');
    assert.ok(result2.payload.media);
    assert.ok(result2.payload.media_candidates);
    assert.equal(result2.payload.media_candidates[0].relation, 'explicit_ref');
    
    // Now media should be consumed
    const stats = buffer.getStats();
    assert.equal(stats.pendingMedia.length, 0);
  });

  it('does not attach media after TTL expiry', async () => {
    let now = 1000;
    const buffer = createInboundMessageBuffer({
      pendingMediaTtlMs: 600000,
      nowImpl: () => now,
    });

    // Media arrives
    await buffer.processInbound(makeMediaPayload());

    // 601 seconds later (past TTL)
    now += 601000;
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '怎么样？',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(!result.payload.media || result.payload.media.length === 0);
    assert.ok(!result.payload.media_candidates);
  });

  it('isolates recent candidates per sender', async () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });

    // User-1 sends media
    await buffer.processInbound(makeMediaPayload('user-1'));
    
    // User-2 sends plain text — should NOT get user-1's media
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-2',
      text: '怎么样？',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(!result.payload.media || result.payload.media.length === 0);
    assert.ok(!result.payload.media_candidates);
  });
});

describe('inbound message buffer - multiple media batches', () => {
  it('handles multiple media batches for same sender', async () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });

    // Two media messages arrive
    await buffer.processInbound(makeMediaPayload('user-1'));
    await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      media: [{ filePath: '/tmp/img2.png', mimeType: 'image/png', type: 'image' }],
    }));

    const stats = buffer.getStats();
    assert.equal(stats.pendingMedia.length, 1);
    assert.equal(stats.pendingMedia[0].itemCount, 2);

    // Text-ref merges both
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '分析这些图片',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(result.payload.media);
    assert.equal(result.payload.media.length, 2);
  });

  it('implicit ref attaches only most recent media (maxCandidates=1)', async () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });

    // Two media messages arrive
    await buffer.processInbound(makeMediaPayload('user-1', '/tmp/img1.png'));
    await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      media: [{ filePath: '/tmp/img2.png', mimeType: 'image/png', type: 'image' }],
    }));

    // Implicit ref should attach only most recent
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '怎么样？',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(result.payload.media);
    assert.equal(result.payload.media.length, 1);
    assert.equal(result.payload.media[0].filePath, '/tmp/img2.png');
  });
});

describe('deferred text-ref intent', () => {
  it('text-ref first, image arrives within wait window → immediate merge', async () => {
    const buffer = createInboundMessageBuffer({
      textRefWaitMs: 200,
      pendingMediaTtlMs: 600000,
      pendingTextRefTtlMs: 120000,
    });

    // Text-ref arrives first — wait starts (200ms)
    const textPromise = buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '用 mimo 读一下',
    }));
    await new Promise((r) => setTimeout(r, 10));

    // Media arrives within the wait window
    buffer.resolveTextRefWait('user-1', makeMediaPayload('user-1'));

    const result = await textPromise;
    assert.equal(result.action, 'reply');
    assert.ok(result.payload.media);
    assert.equal(result.payload.media.length, 1);
  });

  it('text-ref first, image 60s later → deferred merge via saved intent', async () => {
    let now = 1000;
    const buffer = createInboundMessageBuffer({
      textRefWaitMs: 100,
      pendingMediaTtlMs: 600000,
      pendingTextRefTtlMs: 120000,
      nowImpl: () => now,
    });

    // Text-ref arrives first — wait starts (100ms)
    const textPromise = buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '用 mimo 读一下',
    }));
    await new Promise((r) => setTimeout(r, 10));

    // 150ms later — wait expires, text sent alone, intent saved
    now += 150;
    const textResult = await textPromise;
    assert.equal(textResult.action, 'reply');
    assert.ok(!textResult.payload.media || textResult.payload.media.length === 0);

    // Intent should be saved
    const stats1 = buffer.getStats();
    assert.equal(stats1.pendingTextRefIntents.length, 1);

    // 60s total — media arrives, within 120s intent TTL
    now += 60000;
    const mediaResult = await buffer.processInbound(makeMediaPayload('user-1'));
    assert.equal(mediaResult.action, 'deferred-merge');
    assert.ok(mediaResult.payload.media);
    assert.equal(mediaResult.payload.media.length, 1);
    assert.equal(mediaResult.payload.text, '用 mimo 读一下');

    // Intent consumed
    const stats2 = buffer.getStats();
    assert.equal(stats2.pendingTextRefIntents.length, 0);
  });

  it('text-ref intent expires after TTL, late media does not bind', async () => {
    let now = 1000;
    const buffer = createInboundMessageBuffer({
      textRefWaitMs: 100,
      pendingMediaTtlMs: 600000,
      pendingTextRefTtlMs: 120000,
      nowImpl: () => now,
    });

    // Text-ref arrives — wait expires quickly (100ms), intent saved
    const textPromise = buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '用 mimo 读一下',
    }));
    await new Promise((r) => setTimeout(r, 10));
    now += 150;
    const textResult = await textPromise;
    assert.equal(textResult.action, 'reply');

    // 121s later — intent TTL expired
    now += 121000;
    const mediaResult = await buffer.processInbound(makeMediaPayload('user-1'));
    // Should be hold (media saved as pending, but no intent to merge with)
    assert.equal(mediaResult.action, 'hold');
  });
});

describe('edge cases', () => {
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
    assert.equal(stats.pendingMedia.length, 1);
    assert.equal(stats.pendingMedia[0].itemCount, 1);

    // Text-ref should still merge
    const result = await buffer.processInbound(makePayload({
      sender_id: 'user-1',
      text: '分析这个',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(result.payload.media);
    assert.equal(result.payload.media.length, 1);
  });

  it('handles sync mode for plain text with pending media', () => {
    const buffer = createInboundMessageBuffer({ pendingMediaTtlMs: 600000 });

    // Media arrives
    buffer.processInboundSync(makeMediaPayload());

    // Plain text in sync mode
    const result = buffer.processInboundSync(makePayload({
      sender_id: 'user-1',
      text: '怎么样？',
    }));
    assert.equal(result.action, 'reply');
    assert.ok(result.payload.media);
    assert.ok(result.payload.media_candidates);
    assert.equal(result.payload.media_candidates[0].relation, 'recent_candidate');
  });
});
