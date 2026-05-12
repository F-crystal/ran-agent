// openclawContextPolicy.test.mjs
// 测试文件：覆盖 openclawContextPolicy 模块的核心策略函数
import assert from "node:assert/strict";
import {
  renderCompactArtifact,
  selectMediaArtifactsForPrompt,
  buildCompactMediaContext,
  buildContextSizeLog,
  buildPersonaContract,
} from "../src/openclawContextPolicy.mjs";

// ──────────────────────────── Mock Artifacts ────────────────────────────

function makeArtifact(overrides = {}) {
  return {
    id: "art_" + Math.random().toString(36).slice(2, 8),
    type: "image",
    source: "user",
    description: "Test description",
    stats: {},
    consumed: false,
    priority: "recent_candidate",
    ...overrides,
  };
}

const sampleArtifacts = [
  makeArtifact({ id: "a1", description: "Alpha", priority: "explicit_ref" }),
  makeArtifact({ id: "a2", description: "Beta", priority: "recent_candidate" }),
  makeArtifact({ id: "a3", description: "Gamma", priority: "recent_candidate" }),
  makeArtifact({ id: "a4", description: "Delta", priority: "recent_candidate" }),
  makeArtifact({ id: "a5", description: "Epsilon", priority: "recent_candidate" }),
];

// ──────────────────────── 1. renderCompactArtifact ≤ 180 chars ──────────

{
  const art = makeArtifact({
    description: "Portrait of a cat sitting on a windowsill during sunset with warm golden light streaming through the glass creating beautiful shadows on the wooden floor and the cat looks very peaceful and content in this moment",
    source: "An extremely long description that goes on and on about the details of this particular image artifact that was uploaded by the user in the chat session earlier today",
  });

  const output = renderCompactArtifact(art);
  assert.ok(
    typeof output === "string",
    "renderCompactArtifact must return a string"
  );
  assert.ok(
    output.length <= 180,
    `renderCompactArtifact output must be ≤ 180 chars, got ${output.length}`
  );
}

{
  const art = makeArtifact({
    description: "Short",
    source: "Brief",
  });
  const output = renderCompactArtifact(art);
  assert.ok(output.length <= 180, "Short artifact also ≤ 180 chars");
  assert.ok(output.length > 0, "Non-empty output");
}

{
  const mediaContextArtifact = {
    id: "media_img_1234",
    type: "image",
    analyzer: "mimo_power",
    summary: "截图显示登录失败，提示验证码过期。",
    ocr_text: "验证码过期",
    created_at: "2026-05-12T10:00:00.000Z",
  };

  const output = renderCompactArtifact(mediaContextArtifact);
  assert.ok(output.length <= 180, "mediaContextStore artifact render ≤ 180 chars");
  assert.match(output, /截图显示登录失败/, "Uses mediaContextStore summary");
  assert.match(output, /验证码过期/, "Uses mediaContextStore OCR text");
  assert.match(output, /mimo_power/, "Includes analyzer source when legacy source is absent");
  assert.notEqual(output, "img_1234：。", "Does not render an empty shell");
}

// ──────────────── 2. selectMediaArtifactsForPrompt max 3 ────────────────

{
  const selected = selectMediaArtifactsForPrompt(sampleArtifacts);
  assert.ok(
    Array.isArray(selected),
    "selectMediaArtifactsForPrompt must return an array"
  );
  assert.ok(
    selected.length <= 3,
    `selectMediaArtifactsForPrompt must return ≤ 3, got ${selected.length}`
  );
}

{
  // 即使传入 10 个 artifacts，结果也不超过 3
  const many = Array.from({ length: 10 }, (_, i) =>
    makeArtifact({ id: `bulk_${i}`, priority: "recent_candidate" })
  );
  const selected = selectMediaArtifactsForPrompt(many);
  assert.ok(selected.length <= 3, "Still ≤ 3 even with 10 input artifacts");
}

// ──────── 3. explicit_ref priority > recent_candidate ──────────────────

{
  const arts = [
    makeArtifact({ id: "rc1", description: "Recent A", priority: "recent_candidate" }),
    makeArtifact({ id: "rc2", description: "Recent B", priority: "recent_candidate" }),
    makeArtifact({ id: "er1", description: "Explicit X", priority: "explicit_ref" }),
    makeArtifact({ id: "er2", description: "Explicit Y", priority: "explicit_ref" }),
    makeArtifact({ id: "rc3", description: "Recent C", priority: "recent_candidate" }),
  ];

  const selected = selectMediaArtifactsForPrompt(arts);

  // 所有 explicit_ref 应排在 recent_candidate 之前
  const firstRecentIdx = selected.findIndex((a) => a.priority === "recent_candidate");
  const lastExplicitIdx = selected.findLastIndex((a) => a.priority === "explicit_ref");

  if (firstRecentIdx !== -1 && lastExplicitIdx !== -1) {
    assert.ok(
      lastExplicitIdx < firstRecentIdx,
      "explicit_ref artifacts must appear before recent_candidate"
    );
  }

  // 若有 explicit_ref，至少有一个应被选中
  const hasExplicit = selected.some((a) => a.priority === "explicit_ref");
  assert.ok(hasExplicit, "At least one explicit_ref should be selected");
}

// ──── 4. consumed=true & non-current-ref old media filtered out ────────

{
  const currentRefId = "current_ref_1";
  const arts = [
    makeArtifact({ id: "active1", consumed: false, priority: "recent_candidate" }),
    makeArtifact({ id: "old1", consumed: true, priority: "recent_candidate" }),
    makeArtifact({ id: "old2", consumed: true, priority: "recent_candidate" }),
    makeArtifact({ id: currentRefId, consumed: true, priority: "explicit_ref", currentRef: true }),
  ];

  const selected = selectMediaArtifactsForPrompt(arts);

  // consumed=true 且非当前引用的应被过滤
  const old1Present = selected.some((a) => a.id === "old1");
  const old2Present = selected.some((a) => a.id === "old2");
  assert.equal(old1Present, false, "old1 (consumed, not current ref) should be filtered");
  assert.equal(old2Present, false, "old2 (consumed, not current ref) should be filtered");

  // 当前引用即使 consumed=true 也应保留
  const currentPresent = selected.some((a) => a.id === currentRefId);
  assert.equal(currentPresent, true, "Current ref (consumed=true) should be kept");

  // 未 consumed 的应保留
  const active1Present = selected.some((a) => a.id === "active1");
  assert.equal(active1Present, true, "active1 (not consumed) should be kept");
}

// ────────────── 5. buildCompactMediaContext correct format ──────────────

{
  const arts = [
    makeArtifact({
      id: "fmt1",
      type: "image",
      description: "A beautiful sunset",
    }),
    makeArtifact({
      id: "fmt2",
      type: "audio",
      description: "Birds singing",
    }),
  ];

  const ctx = buildCompactMediaContext(arts);

  assert.ok(typeof ctx === "string", "buildCompactMediaContext returns string");
  assert.ok(ctx.length > 0, "Non-empty context");

  // 格式校验：应包含标识/标签/类型关键信息
  assert.ok(ctx.includes("fmt1"), "Contains first artifact identifier");
  assert.ok(ctx.includes("fmt2"), "Contains second artifact identifier");
}

{
  // 空输入应返回占位提示
  const ctx = buildCompactMediaContext([]);
  assert.ok(typeof ctx === "string", "Empty input returns string");
  assert.ok(ctx.includes("无可用媒体"), "Empty input contains placeholder");
}

// ────────────── 6. buildContextSizeLog complete fields ──────────────────

{
  const parts = [
    { label: "system", text: "System prompt here" },
    { label: "persona", text: "Persona contract" },
    { label: "history", text: "Conversation history" },
    { label: "media", text: "Media context" },
  ];
  const log = buildContextSizeLog(parts);

  assert.ok(typeof log === "object", "buildContextSizeLog returns object");
  assert.ok(log !== null, "Non-null");

  // 必须包含的关键字段
  const requiredFields = [
    "totalChars",
    "totalBytes",
    "parts",
    "overflow",
  ];

  for (const field of requiredFields) {
    assert.ok(
      field in log,
      `buildContextSizeLog must include field "${field}"`
    );
  }

  assert.ok(
    typeof log.totalChars === "number" && log.totalChars >= 0,
    "totalChars is non-negative number"
  );
  assert.ok(
    typeof log.totalBytes === "number" && log.totalBytes >= 0,
    "totalBytes is non-negative number"
  );
  assert.ok(Array.isArray(log.parts), "parts is array");
  assert.ok(typeof log.overflow === "boolean", "overflow is boolean");
}

// ────────────── 7. buildPersonaContract non-empty string ────────────────

{
  const contract = buildPersonaContract();

  assert.ok(typeof contract === "string", "buildPersonaContract returns string");
  assert.ok(contract.trim().length > 0, "Non-empty contract string");
  assert.ok(contract.includes("OpenClaw"), "Contains OpenClaw reference");
}

// ────────────── 8. Legacy fallback ──────────────────────────────────────

{
  // 当模块未提供新接口时，legacy fallback 应能回退
  // 模拟：直接调用 buildCompactMediaContext 传入 legacy 格式数据
  const legacyArtifacts = [
    {
      id: "legacy1",
      // 缺少新字段如 priority, consumed — 应自动 fallback
      type: "image",
      description: "Legacy Image",
    },
  ];

  // 不应抛出异常 — 应 fallback 到安全默认值
  let ctx, err;
  try {
    ctx = buildCompactMediaContext(legacyArtifacts);
  } catch (e) {
    err = e;
  }
  assert.equal(err, undefined, "Legacy data must not throw");
  assert.ok(typeof ctx === "string", "Legacy fallback returns string");
  assert.ok(ctx.length > 0, "Legacy fallback non-empty");

  // selectMediaArtifactsForPrompt 也应兼容 legacy
  let selected, err2;
  try {
    selected = selectMediaArtifactsForPrompt(legacyArtifacts);
  } catch (e) {
    err2 = e;
  }
  assert.equal(err2, undefined, "Legacy select must not throw");
  assert.ok(Array.isArray(selected), "Legacy select returns array");

  // renderCompactArtifact 兼容 legacy
  let rendered, err3;
  try {
    rendered = renderCompactArtifact(legacyArtifacts[0]);
  } catch (e) {
    err3 = e;
  }
  assert.equal(err3, undefined, "Legacy render must not throw");
  assert.ok(typeof rendered === "string" && rendered.length <= 180, "Legacy render ≤ 180 chars");
}

// ────────────── Summary ─────────────────────────────────────────────────

console.log("\n✅ All openclawContextPolicy tests passed.\n");
