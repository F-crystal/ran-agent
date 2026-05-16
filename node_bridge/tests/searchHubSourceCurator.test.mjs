import assert from 'node:assert/strict';
import test from 'node:test';

import {
  curateSearchResults,
  normalizeSearchResult,
  redactSensitiveUrl,
} from '../src/searchHub/sourceCurator.mjs';

test('normalizeSearchResult standardizes schema and strips sensitive raw fields', () => {
  const item = normalizeSearchResult({
    title: 'Example',
    url: 'https://example.com/page?xsec_token=secret&ok=1&signature=abc',
    source: 'Example Site',
    published_at: '2026-05-17',
    snippet: 'Snippet',
    content: 'Content',
    provider: 'tavily',
    confidence: 2,
    raw: {
      Authorization: 'Bearer secret',
      cookie: 'a=b',
      useful: 'kept',
    },
  });

  assert.deepEqual(Object.keys(item), [
    'title',
    'url',
    'source',
    'published_at',
    'snippet',
    'content',
    'provider',
    'confidence',
    'needs_read',
    'raw',
  ]);
  assert.equal(item.url, 'https://example.com/page?ok=1');
  assert.equal(item.confidence, 1);
  assert.deepEqual(item.raw, { useful: 'kept' });
});

test('curateSearchResults dedupes normalized URLs and orders by confidence', () => {
  const result = curateSearchResults([
    { title: 'Low', url: 'https://example.com/a?utm_source=x', provider: 'tavily', confidence: 0.2 },
    { title: 'High', url: 'https://example.com/b', provider: 'opencli', confidence: 0.9 },
    { title: 'Dup', url: 'https://example.com/a', provider: 'aihot', confidence: 0.8 },
  ], {
    warnings: ['TOKEN abc123 should be hidden'],
    limit: 5,
  });

  assert.deepEqual(result.items.map((item) => item.title), ['High', 'Dup']);
  assert.equal(result.warnings[0], 'REDACTED_SENSITIVE_WARNING');
});

test('redactSensitiveUrl removes token-like and signed query parameters', () => {
  assert.equal(
    redactSensitiveUrl('https://cdn.example.com/file?Expires=1&X-Amz-Signature=abc&token=def&id=42'),
    'https://cdn.example.com/file?id=42'
  );
});
