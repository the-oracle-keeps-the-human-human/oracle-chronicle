interface Env {
  CHRONICLE: KVNamespace;
}

interface ChronicleEvent {
  ts: string;
  oracle: string;
  type: string;
  channel?: string;
  data: any;
}

function corsHeaders(): Record<string, string> {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleRecord(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as ChronicleEvent;
  if (!body.oracle || !body.type) return json({ error: "missing oracle or type" }, 400);

  const ts = body.ts || new Date().toISOString();
  const event = { ...body, ts };

  await Promise.all([
    env.CHRONICLE.put(`all:${ts}:${body.oracle}`, JSON.stringify(event), { expirationTtl: 86400 * 90 }),
    env.CHRONICLE.put(`oracle:${body.oracle}:${ts}`, JSON.stringify(event), { expirationTtl: 86400 * 90 }),
    env.CHRONICLE.put(`type:${body.type}:${ts}`, JSON.stringify(event), { expirationTtl: 86400 * 90 }),
    env.CHRONICLE.put(`date:${ts.slice(0, 10)}:${ts}:${body.oracle}`, JSON.stringify(event), { expirationTtl: 86400 * 90 }),
    body.channel ? env.CHRONICLE.put(`channel:${body.channel}:${ts}`, JSON.stringify(event), { expirationTtl: 86400 * 90 }) : Promise.resolve(),
  ]);

  const cursorKey = `cursor:${body.oracle}:${body.channel || "_global"}`;
  await env.CHRONICLE.put(cursorKey, ts);

  return json({ ok: true, ts, oracle: body.oracle });
}

async function handleGitHubWebhook(request: Request, env: Env, slug?: string): Promise<Response> {
  const ghEvent = request.headers.get("X-GitHub-Event") || "unknown";
  const payload = await request.json() as any;
  const ts = new Date().toISOString();

  const event: ChronicleEvent = {
    ts,
    oracle: "github",
    type: `github.${ghEvent}`,
    channel: slug || undefined,
    data: {
      action: payload.action,
      repo: payload.repository?.full_name,
      sender: payload.sender?.login,
      title: payload.pull_request?.title || payload.issue?.title,
      number: payload.pull_request?.number || payload.issue?.number,
      url: payload.pull_request?.html_url || payload.issue?.html_url || payload.compare,
      ref: payload.ref,
      commits: payload.commits?.length,
    },
  };

  await Promise.all([
    env.CHRONICLE.put(`all:${ts}:github`, JSON.stringify(event), { expirationTtl: 86400 * 90 }),
    env.CHRONICLE.put(`type:github.${ghEvent}:${ts}`, JSON.stringify(event), { expirationTtl: 86400 * 90 }),
    env.CHRONICLE.put(`date:${ts.slice(0, 10)}:${ts}:github`, JSON.stringify(event), { expirationTtl: 86400 * 90 }),
    slug ? env.CHRONICLE.put(`workshop:${slug}:${ts}`, JSON.stringify(event), { expirationTtl: 86400 * 90 }) : Promise.resolve(),
  ]);

  return json({ ok: true, event: ghEvent, ts });
}

async function queryEvents(env: Env, prefix: string, limit = 50): Promise<any[]> {
  const list = await env.CHRONICLE.list({ prefix, limit });
  const events = await Promise.all(
    list.keys.map(async (k: any) => {
      const val = await env.CHRONICLE.get(k.name);
      return val ? JSON.parse(val) : null;
    })
  );
  return events.filter(Boolean);
}

async function handleCursor(env: Env, oracle: string, channel: string): Promise<Response> {
  const cursor = await env.CHRONICLE.get(`cursor:${oracle}:${channel}`);
  return json({ oracle, channel, cursor: cursor || null });
}

function renderDashboard(events: any[]): string {
  const rows = events.slice(0, 40).map(e => {
    const icon = e.type?.startsWith("github.") ? "📦" : e.type === "discord" ? "💬" : "📌";
    const who = e.oracle || "?";
    const what = e.data?.title || e.data?.sender || e.type || "";
    const ago = timeAgo(e.ts);
    return `<div class="ev">${icon} <b>${who}</b> ${e.type} ${what} <span class="t">${ago}</span></div>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Oracle Chronicle 📜</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#0d1117;color:#c9d1d9;min-height:100vh}
header{background:#161b22;padding:2rem;text-align:center;border-bottom:1px solid #30363d}
h1{color:#f0f6fc;font-size:2rem}h1 span{color:#f7931a}
.sub{color:#8b949e;margin-top:.5rem}
.feed{max-width:900px;margin:2rem auto;padding:0 1rem}
.ev{padding:.6rem 0;border-bottom:1px solid #21262d;font-size:.9rem;line-height:1.5}
.t{color:#8b949e;font-size:.8rem}
.api{max-width:900px;margin:2rem auto;padding:0 1rem}
.api h2{color:#f7931a;margin-bottom:1rem}
.api code{background:#161b22;padding:.3rem .6rem;border-radius:4px;font-size:.85rem}
.api li{margin:.5rem 0;list-style:none}
footer{text-align:center;padding:2rem;color:#8b949e;font-size:.8rem}
</style></head><body>
<header><h1>📜 <span>Oracle Chronicle</span></h1><p class="sub">ทุก event ถูกบันทึก — Nothing is Deleted</p></header>
<div class="feed">${rows || "<p>No events yet — POST /api/record to start!</p>"}</div>
<div class="api"><h2>📡 API</h2><ul>
<li>Record: <code>POST /api/record {oracle, type, data}</code></li>
<li>All: <code>GET /api/feed</code></li>
<li>By oracle: <code>GET /api/oracle/:name/feed</code></li>
<li>By date: <code>GET /api/date/:YYYY-MM-DD/feed</code></li>
<li>By type: <code>GET /api/type/:type/feed</code></li>
<li>Workshop: <code>GET /api/workshop/:slug/feed</code></li>
<li>Cursor: <code>GET /api/cursor/:oracle/:channel</code></li>
<li>GitHub: <code>POST /github-hooks</code></li>
</ul></div>
<footer>Oracle Chronicle — timestamp is truth<br><script>setTimeout(()=>location.reload(),60000)</script></footer>
</body></html>`;
}

function timeAgo(d: string): string {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    // Record events
    if (p === "/api/record" && request.method === "POST") return handleRecord(request, env);

    // GitHub webhooks
    const wsHook = p.match(/^\/workshop\/([^/]+)\/github-hooks$/);
    if (wsHook && request.method === "POST") return handleGitHubWebhook(request, env, wsHook[1]);
    if (p === "/github-hooks" && request.method === "POST") return handleGitHubWebhook(request, env);

    // Query feeds
    if (p === "/api/feed") return json({ events: await queryEvents(env, "all:") });

    const oracleFeed = p.match(/^\/api\/oracle\/([^/]+)\/feed$/);
    if (oracleFeed) return json({ events: await queryEvents(env, `oracle:${oracleFeed[1]}:`) });

    const dateFeed = p.match(/^\/api\/date\/(\d{4}-\d{2}-\d{2})\/feed$/);
    if (dateFeed) return json({ events: await queryEvents(env, `date:${dateFeed[1]}:`) });

    const typeFeed = p.match(/^\/api\/type\/([^/]+)\/feed$/);
    if (typeFeed) return json({ events: await queryEvents(env, `type:${typeFeed[1]}:`) });

    const wsFeed = p.match(/^\/api\/workshop\/([^/]+)\/feed$/);
    if (wsFeed) return json({ events: await queryEvents(env, `workshop:${wsFeed[1]}:`) });

    // Cursor
    const cursorMatch = p.match(/^\/api\/cursor\/([^/]+)\/([^/]+)$/);
    if (cursorMatch) return handleCursor(env, cursorMatch[1], cursorMatch[2]);

    // Dashboard
    const allEvents = await queryEvents(env, "all:", 40);
    return new Response(renderDashboard(allEvents), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  },
};
