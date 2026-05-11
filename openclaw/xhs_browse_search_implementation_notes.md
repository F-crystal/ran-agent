# XHS Browse Search Implementation Notes

**Status:** CURRENT (2026-05-12)

This document records the engineering journey from the design phase (after `openclaw/xhs_browse_upgrade_review.md`) to the completion of the XHS Browse search feature implementation.

## 1. Backend Exploration

### jobson-xhs-mcp
- `tools/list` available
- `search`/`home_feed`/`get_note_content` unstable
- **Decision:** Not used as the primary long-term search backend

### xhs-mcp (npx -y xhs-mcp mcp --mode stdio)
- Successfully starts as MCP server
- Depends on Puppeteer/Chromium for browser automation
- Provides `xhs_search_note`, `xhs_get_note_detail`, `xhs_discover_feeds` tools
- **Selected as primary backend** for search functionality

## 2. Browser Environment Setup

### Challenge
- xhs-mcp requires Chromium for Puppeteer
- Default Puppeteer cache path: `/home/ubuntu/.cache/puppeteer`
- Server environment: headless, no GUI

### Solution
- Use system Chromium: `/snap/bin/chromium`
- Set `PUPPETEER_EXECUTABLE_PATH=/snap/bin/chromium`
- Set `PUPPETEER_SKIP_DOWNLOAD=true` to avoid redundant downloads
- Wrap with `xvfb-run -a` for headless server compatibility
- Adapter in xhs-mcp automatically maps to system Chromium

### Implementation
```javascript
// In socialReaderMcpServer.mjs
if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
  process.env.PUPPETEER_EXECUTABLE_PATH = '/snap/bin/chromium';
}
if (!process.env.PUPPETEER_SKIP_DOWNLOAD) {
  process.env.PUPPETEER_SKIP_DOWNLOAD = 'true';
}
```

## 3. Authentication & Login State

### Observations
- `auth_login` does not return QR code URL directly
- Server-side scanning flow is unstable
- **Final approach:** Maintain login state via `~/.xhs-mcp/cookies.json`

### Verification
```bash
xvfb-run -a npx -y xhs-mcp status
# Returns: {"success": true, "loggedIn": true, "status": "logged_in", ...}
```

### Security Constraints
- **Never** commit Cookie/token values
- **Never** write actual Cookie/token to documentation
- Login state managed externally by xhs-mcp

## 4. Search Implementation & Fixes

### Parameter Mapping
- xhs-mcp `xhs_search_note` expects `keyword` (not `query` or `keywords`)
- Tool name mapping: `xhs_search_note` → use `keyword` parameter

### Response Parsing
- xhs-mcp returns MCP response with `result.content[0].text` as JSON string
- Must parse: `JSON.parse(content[0].text)`
- Parsed structure: `{success: true, items: [...], count: N}` or `{success: false, error, message}`

### Item Structure (xhs-mcp raw format)
```json
{
  "id": "note_id_here",
  "xsecToken": "internal_token",
  "noteCard": {
    "displayTitle": "Note Title",
    "user": {"nickname": "Author Name", "userId": "user_id"},
    "cover": {"urlDefault": "cover_image_url"},
    "interactInfo": {"likedCount": 1234, "collectedCount": 567, ...}
  }
}
```

### Normalization
- Extract: `note_id`, `title`, `user`, `user_id`, `cover_image`, `type`, counts, `url`
- Cache `xsecToken` internally (never exposed in output)
- Truncate results to `max_results` limit

### Key Code Changes
```javascript
// Parse xhs-mcp response
const mcpContent = result.data?.content?.[0]?.text;
const parsed = JSON.parse(mcpContent);
const rawData = {
  items: parsed.items || parsed.feeds || [],
  total_count: parsed.count || parsed.total || 0,
};

// Normalize nested noteCard structure
const noteCard = item.noteCard || item;
const user = noteCard.user || item.user || {};
const cover = noteCard.cover || item.cover || {};
const interactInfo = noteCard.interactInfo || {};
```

## 5. OpenClaw Visibility

### Issue
- Returning plain JSON object only may not show results in OpenClaw frontend
- **Fix:** Return both `content` (text summary) and `structuredContent` (structured data)

### Result Format
```javascript
{
  content: [{type: 'text', text: 'Search results summary...'}],
  structuredContent: {
    ok: true,
    query: '...',
    results: [...],
    total_count: 3
  }
}
```

## 6. Regression & Rollback

### Incident
- Initial attempt to add `xhs_browse_note` with `xsecToken` cache caused search regression
- Search returned `results: []` after cache logic was added
- Root cause: `normalizeXhsBrowseResponse` expected flat `results` array, but xhs-mcp returns nested `items/feeds`

### Resolution
- Fixed `normalizeXhsBrowseResponse` to handle nested `noteCard` structure
- **Decision:** Freeze search functionality first, defer note detail reading to future task

## 7. Timeout Configuration

### Settings
- `openclaw/openclaw.personal-system.json`:
  - `agents.defaults.timeoutSeconds=600`
  - `llm.idleTimeoutSeconds=300`
- `node_bridge/.env.local` (local only, not committed):
  - `OPENCLAW_AGENT_TIMEOUT_SECONDS=600`

## 8. Current Status

### Completed ✅
- `xhs_browse_search` manual MCP verification passed
- OpenClaw frontend shows 3 results correctly
- Write tools forbidden (read-only)
- `xsecToken` not exposed in output
- `read_social_post` legacy path unaffected

### Not Completed ⏸️
- `xhs_browse_note` detail reading
- Video content understanding
- `user`/`feed` functionality
- **Plan:** Handle in separate future tasks

## 9. Security Constraints

- **Do not commit** `.env.local`
- **Do not commit** Cookie/token values
- **Do not expose** `xsecToken` in output
- **Do not call** `comment`/`publish`/`delete` tools
- Low-frequency, user-explicitly-triggered operations only

## 10. Files Modified

- `node_bridge/src/socialReaderMcpServer.mjs`:
  - Added `xhsNoteTokenCache` (internal, max 1000 entries, 24h TTL)
  - Fixed `xhsBrowseSearch` parameter mapping (`keyword`)
  - Added xhs-mcp response parsing (`content[0].text` → JSON)
  - Refactored `normalizeXhsBrowseResponse('search')` for nested `noteCard` structure
  - Added `PUPPETEER_EXECUTABLE_PATH` default
  - Added result truncation to `max_results`

## 11. Testing

### Manual MCP Verification
```bash
cd /opt/ran_agent && printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"xhs_browse_search","arguments":{"query":"小红书早餐","max_results":3}}}' \
  | timeout 90 scripts/start_social_reader_mcp.sh
```

### Expected Output
```json
{
  "ok": true,
  "query": "小红书早餐",
  "results": [
    {"note_id": "...", "title": "...", "user": "...", "url": "...", ...},
    {"note_id": "...", "title": "...", "user": "...", "url": "...", ...},
    {"note_id": "...", "title": "...", "user": "...", "url": "...", ...}
  ],
  "total_count": 3
}
```

## References

- Design document: `openclaw/xhs_browse_upgrade_review.md`
- MCP server: `npx -y xhs-mcp mcp --mode stdio`
- Browser: `/snap/bin/chromium` via Puppeteer adapter
