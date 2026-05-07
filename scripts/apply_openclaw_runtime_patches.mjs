#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function replaceOnce(text, before, after, label) {
  if (text.includes(after)) {
    return text;
  }
  if (!text.includes(before)) {
    throw new Error(`missing patch anchor: ${label}`);
  }
  return text.replace(before, after);
}

function replaceOnceIfPresent(text, before, after) {
  if (text.includes(after)) {
    return text;
  }
  if (!text.includes(before)) {
    return text;
  }
  return text.replace(before, after);
}

function patchCompactRuntime(text) {
  text = replaceOnce(
    text,
    'function shouldSuppressAssistantVisibleOutput(message) {\n\treturn resolveAssistantMessagePhase(message) === "commentary";\n}\n',
    'function shouldSuppressAssistantVisibleOutput(message) {\n\tif (resolveAssistantMessagePhase(message) === "commentary") return true;\n\treturn message?.role === "assistant" && message.stopReason === "toolUse";\n}\n',
    'compact: suppress toolUse visible output'
  );

  text = replaceOnce(
    text,
    'const DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 4e4;\n',
    'const DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 4e4;\nconst CONCISE_WEB_TOOL_RESULT_MAX_CHARS = 6e3;\n',
    'compact: concise web tool cap constant'
  );

  text = replaceOnce(
    text,
    'const RECOVERY_MIN_TRUNCATED_TEXT_CHARS = RECOVERY_MIN_KEEP_CHARS + DEFAULT_SUFFIX(1).length;\nfunction resolveSuffixFactory(suffix) {\n',
    'const RECOVERY_MIN_TRUNCATED_TEXT_CHARS = RECOVERY_MIN_KEEP_CHARS + DEFAULT_SUFFIX(1).length;\nfunction isConciseWebToolResultMessage(msg) {\n\tif (!msg || msg.role !== "toolResult") return false;\n\tconst toolName = normalizeOptionalLowercaseString(msg.toolName);\n\treturn toolName === "web_search" || toolName === "web_fetch";\n}\nfunction resolveLiveToolResultMaxChars(msg, fallbackMaxChars) {\n\tif (!Number.isFinite(fallbackMaxChars) || fallbackMaxChars <= 0) return fallbackMaxChars;\n\treturn isConciseWebToolResultMessage(msg) ? Math.min(fallbackMaxChars, CONCISE_WEB_TOOL_RESULT_MAX_CHARS) : fallbackMaxChars;\n}\nconst __testOnlyResolveLiveToolResultMaxChars = resolveLiveToolResultMaxChars;\nfunction resolveSuffixFactory(suffix) {\n',
    'compact: live tool result guard helpers'
  );

  text = replaceOnce(
    text,
    'function capToolResultSize(msg) {\n\tif (msg.role !== "toolResult") return msg;\n\treturn truncateToolResultMessage(msg, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS, {\n',
    'function capToolResultSize(msg) {\n\tif (msg.role !== "toolResult") return msg;\n\treturn truncateToolResultMessage(msg, resolveLiveToolResultMaxChars(msg, DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS), {\n',
    'compact: persisted tool-result cap'
  );

  return text;
}

function patchTavilyProvider(text) {
  text = replaceOnce(
    text,
    'import { i as readCache, l as writeCache, o as resolveCacheTtlMs, r as normalizeCacheKey } from "./web-shared-CgdCBrwh.js";\n',
    'import { _ as truncateText, i as readCache, l as writeCache, o as resolveCacheTtlMs, r as normalizeCacheKey } from "./web-shared-CgdCBrwh.js";\n',
    'tavily: truncateText import'
  );

  text = replaceOnce(
    text,
    'const DEFAULT_SEARCH_COUNT = 5;\n',
    'const DEFAULT_SEARCH_COUNT = 5;\nconst TAVILY_SEARCH_TITLE_MAX_CHARS = 160;\nconst TAVILY_SEARCH_SNIPPET_MAX_CHARS = 320;\nconst TAVILY_SEARCH_ANSWER_MAX_CHARS = 500;\n',
    'tavily: truncation constants'
  );

  text = replaceOnce(
    text,
    'const results = (Array.isArray(payload.results) ? payload.results : []).map((r) => ({\n\t\ttitle: typeof r.title === "string" ? wrapWebContent(r.title, "web_search") : "",\n\t\turl: typeof r.url === "string" ? r.url : "",\n\t\tsnippet: typeof r.content === "string" ? wrapWebContent(r.content, "web_search") : "",\n',
    'const results = (Array.isArray(payload.results) ? payload.results : []).map((r) => ({\n\t\ttitle: typeof r.title === "string" ? wrapWebContent(truncateText(r.title, TAVILY_SEARCH_TITLE_MAX_CHARS).text, "web_search") : "",\n\t\turl: typeof r.url === "string" ? r.url : "",\n\t\tsnippet: typeof r.content === "string" ? wrapWebContent(truncateText(r.content, TAVILY_SEARCH_SNIPPET_MAX_CHARS).text, "web_search") : "",\n',
    'tavily: result truncation'
  );

  text = replaceOnce(
    text,
    'if (typeof payload.answer === "string" && payload.answer) result.answer = wrapWebContent(payload.answer, "web_search");\n',
    'if (typeof payload.answer === "string" && payload.answer) result.answer = wrapWebContent(truncateText(payload.answer, TAVILY_SEARCH_ANSWER_MAX_CHARS).text, "web_search");\n',
    'tavily: answer truncation'
  );

  return text;
}

function patchModelOverrides(text) {
  text = replaceOnceIfPresent(
    text,
    'function mergeSessionEntryForStore(previousEntry, sessionEntry, replace) {\n\treturn {\n\t\t...previousEntry,\n\t\t...sessionEntry\n\t};\n}\n',
    'function mergeSessionEntryForStore(previousEntry, sessionEntry, replace) {\n\tif (replace) return { ...sessionEntry };\n\treturn {\n\t\t...previousEntry,\n\t\t...sessionEntry\n\t};\n}\n',
  );

  return text;
}

function patchUsageFormatRuntime(text) {
  text = replaceOnce(
    text,
    'function startGatewayModelPricingRefresh(params) {\n\trefreshGatewayModelPricingCache(params).catch((error) => {\n\t\tlog.warn(`pricing bootstrap failed: ${String(error)}`);\n\t});\n\treturn () => {\n\t\tclearRefreshTimer();\n\t};\n}\n',
    'function startGatewayModelPricingRefresh(params) {\n\tif (process.env.OPENCLAW_DISABLE_MODEL_PRICING_REFRESH === "true") {\n\t\tclearRefreshTimer();\n\t\treturn () => {\n\t\t\tclearRefreshTimer();\n\t\t};\n\t}\n\trefreshGatewayModelPricingCache(params).catch((error) => {\n\t\tlog.warn(`pricing bootstrap failed: ${String(error)}`);\n\t});\n\treturn () => {\n\t\tclearRefreshTimer();\n\t};\n}\n',
    'usage-format: disable optional model pricing refresh'
  );

  return text;
}

const patchTargets = [
  {
    relativePath: 'node_modules/openclaw/dist/compact-CMxQKbp-.js',
    apply: patchCompactRuntime,
  },
  {
    relativePath: 'node_modules/openclaw/dist/tavily-search-provider-C60mJlWV.js',
    apply: patchTavilyProvider,
  },
  {
    relativePath: 'node_modules/openclaw/dist/model-overrides-DTy0-qnF.js',
    apply: patchModelOverrides,
  },
  {
    relativePath: 'node_modules/openclaw/dist/usage-format-21aUMEjS.js',
    apply: patchUsageFormatRuntime,
  },
];

let changedCount = 0;

for (const target of patchTargets) {
  const absolutePath = path.join(rootDir, target.relativePath);
  if (!fs.existsSync(absolutePath)) {
    continue;
  }

  const original = fs.readFileSync(absolutePath, 'utf8');
  const patched = target.apply(original);
  if (patched !== original) {
    fs.writeFileSync(absolutePath, patched);
    changedCount += 1;
    console.log(`patched ${target.relativePath}`);
  }
}

if (changedCount === 0) {
  console.log('openclaw runtime patches already applied');
}
