/**
 * Cloudflare Worker — Notion API CORS Proxy
 *
 * Deploy:
 *   1. wrangler deploy   (or paste into Cloudflare Workers dashboard)
 *
 * Usage from browser:
 *   fetch("https://<your-worker>.workers.dev/notion/v1/databases/xxx/query", {
 *     method: "POST",
 *     headers: {
 *       "Authorization": "Bearer ntn_...",
 *       "Content-Type": "application/json",
 *       "Notion-Version": "2022-06-28"
 *     },
 *     body: JSON.stringify({...})
 *   })
 *
 * The worker strips "Authorization" from the forwarded request if you prefer
 * server-side token injection — but this version passes it through so the
 * token stays in the user's browser only.
 */

const NOTION_BASE = 'https://api.notion.com';

// CORS headers added to every response
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Notion-Version',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Route: /notion/v1/... → https://api.notion.com/v1/...
    if (!url.pathname.startsWith('/notion/')) {
      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }

    // Strip "/notion" prefix, keep "/v1/..."
    const notionPath = url.pathname.slice('/notion'.length);
    const notionUrl = NOTION_BASE + notionPath + url.search;

    // Forward the request
    const forwardHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      // Forward all headers except host
      if (key.toLowerCase() !== 'host') {
        forwardHeaders.set(key, value);
      }
    }

    let body = undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = await request.arrayBuffer();
    }

    let notionResponse;
    try {
      notionResponse = await fetch(notionUrl, {
        method: request.method,
        headers: forwardHeaders,
        body,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Proxy fetch failed', detail: String(e) }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Copy response and add CORS headers
    const responseHeaders = new Headers(notionResponse.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      responseHeaders.set(k, v);
    }

    return new Response(notionResponse.body, {
      status: notionResponse.status,
      headers: responseHeaders,
    });
  },
};
