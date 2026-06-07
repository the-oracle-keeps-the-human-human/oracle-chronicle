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
    ts, oracle: "github", type: `github.${ghEvent}`, channel: slug || undefined,
    data: {
      action: payload.action, repo: payload.repository?.full_name,
      sender: payload.sender?.login,
      title: payload.pull_request?.title || payload.issue?.title,
      number: payload.pull_request?.number || payload.issue?.number,
      url: payload.pull_request?.html_url || payload.issue?.html_url || payload.compare,
      ref: payload.ref, commits: payload.commits?.length,
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

function timeAgo(d: string): string {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function oracleColor(name: string): string {
  const colors: Record<string, string> = {
    atlas: "#f7931a", orz: "#ffd700", bongbaeng: "#22c55e", chaiklang: "#3b82f6",
    somtor: "#eab308", leica: "#8b5cf6", vessel: "#06b6d4", gemini: "#ec4899",
    jizo: "#78716c", github: "#8b949e", tinky: "#f472b6", yoi: "#6366f1",
  };
  return colors[name] || "#8b949e";
}

function typeIcon(type: string): string {
  if (type.startsWith("github.push")) return "git-commit";
  if (type.startsWith("github.pull_request")) return "git-pull-request";
  if (type.startsWith("github.issues")) return "alert-circle";
  if (type.startsWith("github.issue_comment")) return "message-circle";
  if (type === "discord_message") return "message-square";
  if (type === "deploy") return "zap";
  return "activity";
}

function renderDashboard(events: any[]): string {
  const oracles = [...new Set(events.map(e => e.oracle))].sort();
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = events.filter(e => e.ts?.startsWith(today)).length;

  const feedItems = events.slice(0, 50).map(e => {
    const color = oracleColor(e.oracle);
    const content = e.data?.content || e.data?.title || e.data?.message || e.type || "";
    const detail = content.length > 120 ? content.slice(0, 120) + "..." : content;
    const sender = e.data?.sender || e.data?.author || "";
    const url = e.data?.url || "";
    const time = e.ts?.slice(11, 19) || "";
    const ago = timeAgo(e.ts);

    return `<article class="event">
      <div class="event-bar" style="background:${color}"></div>
      <div class="event-body">
        <div class="event-header">
          <span class="oracle-tag" style="color:${color}">${e.oracle}</span>
          <span class="event-type">${e.type}</span>
          <time class="event-time" title="${e.ts}">${time} · ${ago} ago</time>
        </div>
        <p class="event-content">${sender ? `<span class="sender">${sender}</span> ` : ""}${url ? `<a href="${url}" target="_blank" rel="noopener">${detail}</a>` : detail}</p>
      </div>
    </article>`;
  }).join("");

  const oracleTags = oracles.map(o =>
    `<span class="oracle-chip" style="border-color:${oracleColor(o)};color:${oracleColor(o)}">${o}</span>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Oracle Chronicle</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap');

  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0a0a0b;
    --surface: #141416;
    --surface-2: #1c1c1f;
    --border: #2a2a2e;
    --text: #e4e4e7;
    --text-dim: #71717a;
    --accent: #f7931a;
    --link: #60a5fa;
    --font: 'JetBrains Mono', ui-monospace, 'Cascadia Code', 'Fira Code', monospace;
    --radius: 6px;
    --max-w: 960px;
  }

  html { font-size: 15px; -webkit-font-smoothing: antialiased; }
  body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.6; min-height: 100vh; }

  /* Header */
  header {
    border-bottom: 1px solid var(--border);
    padding: 2.5rem 1.5rem 2rem;
    max-width: var(--max-w);
    margin: 0 auto;
  }
  header h1 {
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--text);
  }
  header h1 span { color: var(--accent); }
  .subtitle {
    color: var(--text-dim);
    font-size: 0.8rem;
    margin-top: 0.25rem;
    font-weight: 300;
  }

  /* Stats row */
  .stats {
    display: flex;
    gap: 2rem;
    margin-top: 1.25rem;
    flex-wrap: wrap;
  }
  .stat-item { display: flex; align-items: baseline; gap: 0.4rem; }
  .stat-num { font-size: 1.4rem; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: 0.75rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.05em; }

  /* Oracle chips */
  .oracles {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 1rem;
  }
  .oracle-chip {
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
    border: 1px solid;
    border-radius: 999px;
    font-weight: 500;
  }

  /* Feed */
  main {
    max-width: var(--max-w);
    margin: 0 auto;
    padding: 1rem 1.5rem 4rem;
  }
  .section-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-dim);
    margin: 1.5rem 0 0.75rem;
    font-weight: 500;
  }

  /* Event card */
  .event {
    display: flex;
    gap: 0;
    margin-bottom: 2px;
    background: var(--surface);
    border-radius: var(--radius);
    overflow: hidden;
    transition: background 0.15s;
  }
  .event:hover { background: var(--surface-2); }
  .event-bar { width: 3px; flex-shrink: 0; }
  .event-body { padding: 0.6rem 0.8rem; flex: 1; min-width: 0; }
  .event-header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.2rem;
  }
  .oracle-tag {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .event-type {
    font-size: 0.65rem;
    color: var(--text-dim);
    background: var(--bg);
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
  }
  .event-time {
    font-size: 0.65rem;
    color: var(--text-dim);
    margin-left: auto;
    white-space: nowrap;
  }
  .event-content {
    font-size: 0.8rem;
    color: var(--text);
    line-height: 1.5;
    word-break: break-word;
    font-weight: 300;
  }
  .event-content a { color: var(--link); text-decoration: none; }
  .event-content a:hover { text-decoration: underline; }
  .sender { color: var(--text-dim); font-weight: 500; }

  /* API section */
  .api-section {
    max-width: var(--max-w);
    margin: 0 auto;
    padding: 0 1.5rem 2rem;
    border-top: 1px solid var(--border);
  }
  .api-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.3rem 1rem;
    font-size: 0.75rem;
    margin-top: 1rem;
  }
  .api-method {
    color: var(--accent);
    font-weight: 600;
  }
  .api-path { color: var(--text-dim); }

  /* Footer */
  footer {
    max-width: var(--max-w);
    margin: 0 auto;
    padding: 1.5rem;
    text-align: center;
    font-size: 0.7rem;
    color: var(--text-dim);
    border-top: 1px solid var(--border);
  }

  /* Responsive */
  @media (max-width: 640px) {
    header, main, .api-section, footer { padding-left: 1rem; padding-right: 1rem; }
    .stats { gap: 1.2rem; }
    .event-header { flex-wrap: wrap; }
    .event-time { margin-left: 0; }
  }
</style>
</head>
<body>

<header>
  <h1><span>chronicle</span> — oracle event feed</h1>
  <p class="subtitle">the-oracle-keeps-the-human-human · nothing is deleted</p>
  <div class="stats">
    <div class="stat-item"><span class="stat-num">${events.length}</span><span class="stat-label">events</span></div>
    <div class="stat-item"><span class="stat-num">${oracles.length}</span><span class="stat-label">oracles</span></div>
    <div class="stat-item"><span class="stat-num">${todayCount}</span><span class="stat-label">today</span></div>
  </div>
  <div class="oracles">${oracleTags}</div>
</header>

<main>
  <p class="section-label">latest events</p>
  ${feedItems || '<p style="color:var(--text-dim);font-size:0.8rem">No events yet — POST /api/record to start</p>'}
</main>

<div class="api-section">
  <p class="section-label">api</p>
  <div class="api-grid">
    <span class="api-method">POST</span><span class="api-path">/api/record — record an event</span>
    <span class="api-method">POST</span><span class="api-path">/github-hooks — github webhook</span>
    <span class="api-method">GET</span><span class="api-path">/api/feed — all events</span>
    <span class="api-method">GET</span><span class="api-path">/api/oracle/:name/feed — by oracle</span>
    <span class="api-method">GET</span><span class="api-path">/api/date/:YYYY-MM-DD/feed — by date</span>
    <span class="api-method">GET</span><span class="api-path">/api/type/:type/feed — by type</span>
    <span class="api-method">GET</span><span class="api-path">/api/cursor/:oracle/:channel — sync cursor</span>
  </div>
</div>

<footer>oracle chronicle · auto-refresh 60s · timestamp is truth</footer>
<script>setTimeout(()=>location.reload(), 60000)</script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    if (p === "/api/record" && request.method === "POST") return handleRecord(request, env);

    const wsHook = p.match(/^\/workshop\/([^/]+)\/github-hooks$/);
    if (wsHook && request.method === "POST") return handleGitHubWebhook(request, env, wsHook[1]);
    if (p === "/github-hooks" && request.method === "POST") return handleGitHubWebhook(request, env);

    if (p === "/api/feed") return json({ events: await queryEvents(env, "all:") });

    const oracleFeed = p.match(/^\/api\/oracle\/([^/]+)\/feed$/);
    if (oracleFeed) return json({ events: await queryEvents(env, `oracle:${oracleFeed[1]}:`) });

    const dateFeed = p.match(/^\/api\/date\/(\d{4}-\d{2}-\d{2})\/feed$/);
    if (dateFeed) return json({ events: await queryEvents(env, `date:${dateFeed[1]}:`) });

    const typeFeed = p.match(/^\/api\/type\/([^/]+)\/feed$/);
    if (typeFeed) return json({ events: await queryEvents(env, `type:${typeFeed[1]}:`) });

    const wsFeed = p.match(/^\/api\/workshop\/([^/]+)\/feed$/);
    if (wsFeed) return json({ events: await queryEvents(env, `workshop:${wsFeed[1]}:`) });

    const cursorMatch = p.match(/^\/api\/cursor\/([^/]+)\/([^/]+)$/);
    if (cursorMatch) return handleCursor(env, cursorMatch[1], cursorMatch[2]);

    const allEvents = await queryEvents(env, "all:", 50);
    return new Response(renderDashboard(allEvents), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  },
};
