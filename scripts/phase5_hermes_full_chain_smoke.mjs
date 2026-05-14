#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { createReplyBackend } from '../node_bridge/src/replyBackend.mjs';

const outputDir = process.env.PHASE5_SMOKE_OUTPUT_DIR || '';
const timeoutMs = Number.parseInt(process.env.PHASE5_SMOKE_TIMEOUT_MS || '300000', 10);
const includeMemory = String(process.env.PHASE5_INCLUDE_MEMORY || '').trim() === '1';
const includeMcpTools = String(process.env.PHASE5_INCLUDE_MCP_TOOLS || '').trim() === '1';
const includeSocialReader = String(process.env.PHASE5_INCLUDE_SOCIAL_READER || '').trim() === '1';
const includeObsidian = String(process.env.PHASE5_INCLUDE_OBSIDIAN || '').trim() === '1';

const allCases = [
  {
    name: 'text_reply',
    text: 'Phase 5 follow-up smoke：只输出 PHASE5_TEXT_OK，不要输出其他内容。',
  },
  {
    name: 'personal_memory',
    text: [
      'Phase 5 follow-up smoke：请使用 personal_memory / recall_personal_memory 查询是否有和 Hermes 迁移相关的本地个人记忆。',
      '无结果也可以说明无结果。最后单独输出 PHASE5_PERSONAL_MEMORY_DONE。',
    ].join('\n'),
  },
  {
    name: 'obsidian_memory',
    text: [
      'Phase 5 follow-up smoke：请使用 obsidian_memory / search-notes 搜索 Hermes migration 或 Phase 5 相关笔记。',
      '无结果也可以说明无结果。最后单独输出 PHASE5_OBSIDIAN_MEMORY_DONE。',
    ].join('\n'),
  },
  {
    name: 'media_reader',
    text: [
      'Phase 5 follow-up smoke：请使用 media_reader 的只读解析能力提取这段文本中的媒体资产或平台线索：',
      'Bilibili 示例链接：https://www.bilibili.com/video/BV1xx411c7mD',
      '最后单独输出 PHASE5_MEDIA_READER_DONE。',
    ].join('\n'),
  },
  {
    name: 'social_reader',
    text: [
      'Phase 5 follow-up smoke：请使用 social_reader 的只读能力识别这个社交链接的平台和可解析信息：',
      'https://www.xiaohongshu.com/explore/000000000000000000000000',
      '如果后端需要登录或链接不可读，只说明能力状态。最后单独输出 PHASE5_SOCIAL_READER_DONE。',
    ].join('\n'),
  },
  {
    name: 'mimo_power',
    text: [
      'Phase 5 follow-up smoke：请使用 mimo_power 分析这段纯文本任务是否适合多模态长上下文模型：',
      '“Hermes backend should route multimedia understanding through dedicated MCP tools.”',
      '最后单独输出 PHASE5_MIMO_POWER_DONE。',
    ].join('\n'),
  },
  {
    name: 'media_generation',
    text: [
      'Phase 5 follow-up smoke：请使用 media_generation 生成一张极简测试图，内容为白底黑字 PHASE5。',
      '工具成功后按微信桥接要求保留 WECHAT_MEDIA 原始行。最后单独输出 PHASE5_MEDIA_GENERATION_DONE。',
    ].join('\n'),
  },
];
const defaultCaseNames = new Set(['text_reply']);
const cases = allCases.filter((testCase) => {
  if (defaultCaseNames.has(testCase.name)) {
    return true;
  }
  if (testCase.name === 'personal_memory') {
    return includeMemory;
  }
  if (testCase.name === 'obsidian_memory') {
    return includeObsidian;
  }
  if (testCase.name === 'social_reader') {
    return includeSocialReader;
  }
  return includeMcpTools;
});

const logger = {
  log: (...args) => console.error(...args),
  warn: (...args) => console.error(...args),
  error: (...args) => console.error(...args),
};

const backend = createReplyBackend({
  logger,
  ingestImpl: async () => ({ ok: true, skipped: true }),
});

const results = [];

for (const skipped of skippedCases()) {
  results.push(skipped);
  console.log(`phase5.smoke.skip ${skipped.name} ${skipped.reason}`);
}

for (const testCase of cases) {
  const startedAt = Date.now();
  try {
    console.log(`phase5.smoke.start ${testCase.name}`);
    const response = await withTimeout(
      backend.getReply({
        text: testCase.text,
        sender_id: `phase5-smoke-${testCase.name}`,
        route_hint: 'phase5-hermes-gateway-follow-up-smoke',
      }),
      timeoutMs,
      testCase.name
    );
    const replyText = String(response?.replyText || '').trim();
    if (!replyText) {
      throw new Error('empty replyText');
    }
    const result = {
      name: testCase.name,
      ok: true,
      duration_ms: Date.now() - startedAt,
      source: response?.source || '',
      has_media: Boolean(response?.media),
      reply_preview: replyText.slice(0, 300),
    };
    results.push(result);
    console.log(`phase5.smoke.ok ${testCase.name} ${result.duration_ms}ms`);
  } catch (error) {
    const failure = {
      name: testCase.name,
      ok: false,
      duration_ms: Date.now() - startedAt,
      error: formatError(error),
    };
    results.push(failure);
    await writeArtifacts(results, failure);
    console.error(`phase5.smoke.fail ${testCase.name}: ${failure.error}`);
    process.exit(1);
  }
}

await writeArtifacts(results);
console.log('phase5.smoke.all_ok');

async function withTimeout(promise, ms, name) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms in ${name}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeArtifacts(allResults, firstError = null) {
  if (!outputDir) {
    return;
  }
  await writeFile(
    `${outputDir}/phase5-smoke-results.json`,
    `${JSON.stringify({ results: allResults }, null, 2)}\n`,
    'utf8'
  );
  if (firstError) {
    await writeFile(
      `${outputDir}/phase5-first-error.json`,
      `${JSON.stringify(firstError, null, 2)}\n`,
      'utf8'
    );
  }
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function skippedCases() {
  const skipped = [];
  if (!includeMemory) {
    skipped.push({
      name: 'personal_memory',
      ok: true,
      skipped: true,
      reason: 'skipped by default: Python backend / memory bridge belongs to Phase 6; set PHASE5_INCLUDE_MEMORY=1 to opt in.',
    });
  }
  if (!includeObsidian) {
    skipped.push({
      name: 'obsidian_memory',
      ok: true,
      skipped: true,
      reason: 'skipped by default: Obsidian memory depends on backend/index state and belongs to Phase 6; set PHASE5_INCLUDE_OBSIDIAN=1 to opt in.',
    });
  }
  if (!includeSocialReader) {
    skipped.push({
      name: 'social_reader',
      ok: true,
      skipped: true,
      reason: 'skipped by default: social_reader depends on external MCP/platform state; set PHASE5_INCLUDE_SOCIAL_READER=1 to opt in.',
    });
  }
  if (!includeMcpTools) {
    for (const name of ['media_reader', 'mimo_power', 'media_generation']) {
      skipped.push({
        name,
        ok: true,
        skipped: true,
        reason: 'skipped by default: optional MCP tool exercise; set PHASE5_INCLUDE_MCP_TOOLS=1 to opt in.',
      });
    }
  }
  return skipped;
}
