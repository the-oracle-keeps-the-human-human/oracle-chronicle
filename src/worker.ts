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
    const detail = content.length > 160 ? content.slice(0, 160) + "..." : content;
    const sender = e.data?.sender || e.data?.author || "";
    const url = e.data?.url || "";
    const time = e.ts?.slice(11, 19) || "";
    const ago = timeAgo(e.ts);

    return `<tr class="ev-row">
      <td class="ev-time"><time title="${e.ts}">${time}</time><span class="ago">${ago}</span></td>
      <td class="ev-oracle" style="color:${color}">${e.oracle}</td>
      <td class="ev-type">${e.type}</td>
      <td class="ev-detail">${sender ? `<span class="ev-sender">${sender}</span> ` : ""}${url ? `<a href="${url}" target="_blank">${detail}</a>` : detail}</td>
    </tr>`;
  }).join("");

  const oracleTags = oracles.map(o =>
    `<span class="chip" style="color:${oracleColor(o)}">${o}</span>`
  ).join(" ");

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#1a1410">
<title>Oracle Chronicle</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#1a1410;--sf:#231b14;--sf2:#2d2219;--ln:#3d2f22;
  --ink:#f5ead9;--ink2:#d4c4a8;--dim:#9a8a72;
  --gold:#f0b73d;--sky:#8db8d8;--sage:#9bc28b;--rose:#e89999;--plum:#c89eda;--cyan:#7dd3c0;
}
html{font-size:clamp(14px,1.1vw,16px);-webkit-font-smoothing:antialiased}
body{
  font-family:'JetBrains Mono',ui-monospace,monospace;
  background:var(--bg);color:var(--ink);line-height:1.7;
  min-height:100dvh;padding:clamp(1rem,3vw,2.5rem);
}
::selection{background:var(--gold);color:var(--bg)}
a{color:var(--gold);text-decoration:none}
a:hover{color:#fcd880;text-decoration:underline}

.wrap{max-width:1200px;margin:0 auto}

header{padding:0 0 1.5rem;border-bottom:1px dashed var(--ln);margin-bottom:1.5rem}
h1{font-size:clamp(1.6rem,3vw,2.4rem);font-weight:700;color:var(--gold);letter-spacing:-.02em}
.sub{color:var(--dim);font-size:.85rem;margin-top:.25rem}

.stats{display:flex;gap:2.5rem;margin-top:1.2rem;flex-wrap:wrap}
.st{display:flex;align-items:baseline;gap:.4rem}
.st b{font-size:1.8rem;color:var(--ink)}
.st span{font-size:.75rem;color:var(--dim);text-transform:uppercase;letter-spacing:.08em}

.chips{margin-top:1rem;display:flex;gap:.6rem;flex-wrap:wrap}
.chip{font-size:.8rem;font-weight:500}

h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.12em;color:var(--dim);margin:1.5rem 0 .6rem;font-weight:500}

table{width:100%;border-collapse:collapse}
.ev-row{border-bottom:1px solid var(--ln)}
.ev-row:hover{background:var(--sf)}
.ev-row td{padding:.5rem .6rem;vertical-align:top;font-size:.85rem}
.ev-time{white-space:nowrap;color:var(--ink2);width:7rem}
.ev-time .ago{color:var(--dim);margin-left:.4rem;font-size:.75rem}
.ev-oracle{font-weight:700;text-transform:uppercase;font-size:.75rem;letter-spacing:.03em;width:7rem}
.ev-type{color:var(--dim);font-size:.75rem;width:10rem}
.ev-detail{color:var(--ink);line-height:1.5;word-break:break-word}
.ev-sender{color:var(--ink2);font-weight:500}

.api{margin-top:2rem;padding-top:1.5rem;border-top:1px dashed var(--ln)}
.api-row{display:flex;gap:1rem;padding:.2rem 0;font-size:.8rem}
.api-m{color:var(--gold);font-weight:700;min-width:3.5rem}
.api-p{color:var(--ink2)}

footer{margin-top:2rem;padding-top:1rem;border-top:1px dashed var(--ln);text-align:center;font-size:.75rem;color:var(--dim)}

@media(max-width:640px){
  .ev-type{display:none}
  .ev-time{width:5rem}
  .ev-oracle{width:5rem}
  .stats{gap:1.5rem}
}
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>chronicle</h1>
  <p class="sub">the-oracle-keeps-the-human-human &middot; nothing is deleted</p>
  <div class="stats">
    <div class="st"><b>${events.length}</b><span>events</span></div>
    <div class="st"><b>${oracles.length}</b><span>oracles</span></div>
    <div class="st"><b>${todayCount}</b><span>today</span></div>
  </div>
  <div class="chips">${oracleTags}</div>
</header>

<h2>latest events</h2>
<table>${feedItems || '<tr><td colspan="4" style="color:var(--dim);padding:1rem">No events yet</td></tr>'}</table>

<div class="api">
  <h2>api</h2>
  <div class="api-row"><span class="api-m">POST</span><span class="api-p">/api/record &mdash; record an event</span></div>
  <div class="api-row"><span class="api-m">POST</span><span class="api-p">/github-hooks &mdash; github webhook</span></div>
  <div class="api-row"><span class="api-m">GET</span><span class="api-p">/api/feed &mdash; all events</span></div>
  <div class="api-row"><span class="api-m">GET</span><span class="api-p">/api/oracle/:name/feed &mdash; by oracle</span></div>
  <div class="api-row"><span class="api-m">GET</span><span class="api-p">/api/date/:YYYY-MM-DD/feed &mdash; by date</span></div>
  <div class="api-row"><span class="api-m">GET</span><span class="api-p">/api/cursor/:oracle/:channel &mdash; sync cursor</span></div>
</div>

<footer>oracle chronicle &middot; auto-refresh 60s &middot; timestamp is truth</footer>
<script>setTimeout(()=>location.reload(),60000)</script>

</div>
</body>
</html>`;
}

function renderTranscribePage(transcriptions: any[]): string {
  const rows = transcriptions.map(e => {
    const speaker = e.data?.speaker || e.oracle || "?";
    const text = e.data?.text || "";
    const time = e.ts?.slice(11, 19) || "";
    const color = oracleColor(e.oracle);
    return `<div class="line"><time>${time}</time> <span class="spk" style="color:${color}">${speaker}</span> ${text}</div>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Transcription</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'JetBrains Mono',monospace;background:#1a1410;color:#f5ead9;min-height:100dvh;padding:1.5rem}
.wrap{max-width:900px;margin:0 auto}
h1{color:#f0b73d;font-size:1.5rem;margin-bottom:.5rem}
.sub{color:#9a8a72;font-size:.8rem;margin-bottom:1.5rem}
.line{padding:.4rem 0;border-bottom:1px solid #2d2219;font-size:.9rem;line-height:1.6}
time{color:#9a8a72;margin-right:.8rem;font-size:.8rem}
.spk{font-weight:700;margin-right:.5rem}
.empty{color:#9a8a72;padding:2rem;text-align:center}
.hint{margin-top:2rem;padding:1rem;background:#231b14;border-radius:6px;font-size:.8rem;color:#9a8a72}
.hint code{color:#f0b73d}
</style></head><body><div class="wrap">
<h1>Live Transcription</h1>
<p class="sub">oracle-chronicle &middot; realtime voice → text &middot; auto-refresh 5s</p>
${rows || '<div class="empty">ยังไม่มี transcription — oracle ที่มี STT POST มาที่ /api/record type=transcription</div>'}
<div class="hint">
Oracle ที่ถอดเสียงได้ POST มาที่:<br>
<code>POST /api/record {"oracle":"...", "type":"transcription", "data":{"speaker":"nazt_", "text":"..."}}</code>
</div>
</div>
<script>setTimeout(()=>location.reload(),5000)</script>
</body></html>`;
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

    if (p === "/transcribe") {
      const transcriptions = await queryEvents(env, "type:transcription:", 100);
      return new Response(renderTranscribePage(transcriptions), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    const allEvents = await queryEvents(env, "all:", 50);
    return new Response(renderDashboard(allEvents), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  },
};
