// The single-page UI. Plain HTML/CSS/JS, no build step. (No backticks or ${} in the client script.)
export const page = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monopoly Scorecard</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --fg: #1b1c1e; --muted: #6b6f76; --line: #e4e4e0;
  --accent: #2f5bd3; --accent-soft: #e8eefc;
  --good: #1f8a4c; --good-soft: #e3f4ea; --mid: #b7791f; --mid-soft: #fbf0dc; --bad: #c2412d; --bad-soft: #fbe6e2;
  --bar: #d9dbe0; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111214; --panel: #1a1b1e; --fg: #e9e9e7; --muted: #9a9ea6; --line: #2b2d31;
    --accent: #7c9cf5; --accent-soft: #1e2640;
    --good: #4cc483; --good-soft: #15291e; --mid: #e0a54a; --mid-soft: #2d2414; --bad: #f07a66; --bad-soft: #301a16;
    --bar: #33363c;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 2; flex-wrap: wrap; }
header h1 { font-size: 16px; margin: 0; letter-spacing: -0.01em; }
header h1 span { color: var(--muted); font-weight: 400; }
form { display: flex; gap: 8px; }
input[type=text] { width: 180px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; text-transform: uppercase; }
input[type=text]:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button { padding: 8px 14px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--line); font-weight: 500; }
button:disabled { opacity: .55; cursor: default; }
main { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 24px; padding: 24px; max-width: 1280px; margin: 0 auto; }
@media (max-width: 860px) { main { grid-template-columns: 1fr; padding: 16px; } header { padding: 12px 16px; } aside { order: 2; } }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
aside .panel { padding: 6px 0; }
aside h2, .sec-title { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 10px 16px; font-weight: 600; }
.wl { width: 100%; border-collapse: collapse; }
.wl td { padding: 7px 16px; border-top: 1px solid var(--line); cursor: pointer; }
.wl tr:hover td { background: var(--accent-soft); }
.wl tr.sel td { background: var(--accent-soft); }
.wl .t { font-weight: 600; font-family: var(--mono); }
.wl .n { color: var(--muted); font-size: 12px; display: block; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl .s { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.empty { color: var(--muted); padding: 12px 16px; }
.card-head { padding: 20px 24px; display: flex; gap: 24px; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
.card-head h2 { margin: 0 0 4px; font-size: 22px; letter-spacing: -0.02em; }
.meta { color: var(--muted); font-size: 13px; }
.total { text-align: right; }
.total .big { font-size: 44px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; font-variant-numeric: tabular-nums; }
.total .big small { font-size: 18px; color: var(--muted); font-weight: 500; }
.pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; margin-top: 8px; }
.r-Monopoly { background: var(--good-soft); color: var(--good); }
.r-Strong { background: var(--accent-soft); color: var(--accent); }
.r-Contested { background: var(--mid-soft); color: var(--mid); }
.r-Competitive, .r-Excluded { background: var(--bad-soft); color: var(--bad); }
.notice { margin: 16px 24px 0; padding: 10px 14px; border-radius: 8px; background: var(--mid-soft); color: var(--fg); font-size: 13px; }
.sections { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; padding: 16px 24px; border-bottom: 1px solid var(--line); }
@media (max-width: 860px) { .sections { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.sec-sum .lbl { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sec-sum .v { font-weight: 600; font-variant-numeric: tabular-nums; }
.bar { height: 6px; background: var(--bar); border-radius: 3px; overflow: hidden; margin-top: 4px; }
.bar i { display: block; height: 100%; background: var(--accent); }
.section { padding: 8px 0 4px; border-bottom: 1px solid var(--line); }
.section:last-child { border-bottom: 0; }
.section .sec-title { display: flex; justify-content: space-between; margin: 10px 24px 6px; }
.metrics { width: 100%; border-collapse: collapse; table-layout: fixed; }
.metrics col.c-id { width: 58px; } .metrics col.c-val { width: 150px; } .metrics col.c-pts { width: 104px; }
@media (max-width: 560px) { .metrics col.c-val { width: 96px; } .metrics col.c-pts { width: 84px; } }
.metrics td { padding: 8px 10px; vertical-align: top; border-top: 1px solid var(--line); }
.metrics td:first-child { padding-left: 24px; width: 44px; font-family: var(--mono); color: var(--muted); }
.metrics td:last-child { padding-right: 24px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.metrics tr.row { cursor: pointer; }
.metrics tr.row:hover td { background: var(--accent-soft); }
.metrics .name { font-weight: 500; }
.metrics .val { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.metrics .band { color: var(--muted); font-size: 12px; white-space: nowrap; }
.pts { display: inline-block; min-width: 54px; padding: 2px 8px; border-radius: 6px; font-weight: 600; text-align: center; }
.p-full { background: var(--good-soft); color: var(--good); }
.p-part { background: var(--mid-soft); color: var(--mid); }
.p-zero { background: var(--bad-soft); color: var(--bad); }
.metrics tr.detail td { background: var(--bg); padding: 10px 24px 14px 58px; font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); text-align: left; white-space: normal; width: auto; overflow-wrap: anywhere; }
.detail .f { color: var(--muted); margin-bottom: 6px; }
.detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 6px 0; }
.detail dt { color: var(--muted); }
.detail dd { margin: 0; font-family: var(--mono); font-size: 12px; }
.detail blockquote { margin: 8px 0; padding: 6px 10px; border-left: 3px solid var(--line); color: var(--muted); font-size: 12px; }
.detail a { color: var(--accent); word-break: break-all; }
.note { margin-top: 4px; }
.hidden { display: none; }
#status { padding: 40px 24px; color: var(--muted); }
details.method { margin-top: 24px; padding: 4px 24px 16px; }
details.method summary { cursor: pointer; padding: 12px 0; font-weight: 600; }
details.method li { margin: 4px 0; }
.err { color: var(--bad); }
@media (max-width: 560px) { .metrics .band { display: none; } .total { text-align: left; } }
</style>
</head>
<body>
<header>
  <h1>Monopoly Scorecard <span>· strict, filings-only</span></h1>
  <form id="f">
    <input id="q" type="text" placeholder="Ticker, e.g. NVDA" autocomplete="off" spellcheck="false" aria-label="Ticker">
    <button id="go" type="submit">Score</button>
  </form>
</header>
<main>
  <aside>
    <div class="panel">
      <h2>Ranked watchlist</h2>
      <table class="wl"><tbody id="wl"><tr><td class="empty">Loading…</td></tr></tbody></table>
    </div>
  </aside>
  <section>
    <div class="panel" id="card"><div id="status">Enter a ticker to score it from its 10-K, 10-Q and proxy filings on SEC EDGAR. New companies are scored in the background (about a minute); the watchlist is re-scored nightly.</div></div>
    <details class="panel method">
      <summary>Methodology and interpretation rules</summary>
      <ul>
        <li>GAAP figures from 10-K, 10-Q and DEF 14A filings via SEC EDGAR XBRL. TTM = latest FY + current YTD − prior-year YTD (equal to the last four quarters).</li>
        <li>Missing history scores 0. Tax rate 21%, hurdle 12%. Banks, insurers and REITs are excluded by SIC code.</li>
        <li>Thresholds: "≥" bands include the lower bound; "≤ / >" bands (A4, B4, E3, F2, C2, C3) include the upper bound, as the table writes them.</li>
        <li>Invested capital = total debt (long-term incl. current portion, short-term borrowings, commercial paper; leases excluded) + total equity incl. NCI − cash & short-term investments. Average invested capital ≤ 0 → ROIC not meaningful → 0 points and the gate applies.</li>
        <li>A4 uses the population standard deviation. B1 scores 0 when revenue CAGR ≤ 0. EBITDA = operating income + D&A from the cash-flow statement. C3: net cash scores 5 even with negative EBITDA.</li>
        <li>E1, E2, C2 are machine-read from filing text and inline XBRL; each shows the passage it was read from. Untagged customer concentration found only in text scores 0 pending review.</li>
        <li>Monopoly gate: TTM ROIC below 8% (or not computable) caps the total at 50. Ties rank by TTM ROIC.</li>
        <li>Scores are computed by a background job and refreshed nightly (06:00 UTC) from the latest filings.</li>
      </ul>
    </details>
  </section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var fmt = function (n) { return (Math.round(n * 10) / 10).toString(); };
  var current = null;

  function ratingClass(r) { return "r-" + String(r).split(" ")[0]; }

  function loadWatchlist() {
    fetch("/api/scores").then(function (r) { return r.json(); }).then(function (rows) {
      if (!rows.length) { $("wl").innerHTML = '<tr><td class="empty">No companies scored yet.</td></tr>'; return; }
      $("wl").innerHTML = rows.map(function (r, i) {
        return '<tr data-t="' + esc(r.ticker) + '"' + (r.ticker === current ? ' class="sel"' : "") + '><td style="width:28px;color:var(--muted)">' + (i + 1) +
          '</td><td><span class="t">' + esc(r.ticker) + '</span><span class="n">' + esc(r.name) + '</span></td><td class="s">' +
          (r.rating === "Excluded" ? "—" : fmt(r.total)) + "</td></tr>";
      }).join("");
    }).catch(function () { $("wl").innerHTML = '<tr><td class="empty">Couldn\'t load the watchlist.</td></tr>'; });
  }
  $("wl").addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-t]");
    if (tr) score(tr.getAttribute("data-t"), false);
  });

  function ptsClass(m) { return m.points >= m.max ? "p-full" : m.points > 0 ? "p-part" : "p-zero"; }

  function render(c) {
    var h = '<div class="card-head"><div><h2>' + esc(c.ticker) + " · " + esc(c.name) + '</h2><div class="meta">SIC ' + esc(c.sic) + " " + esc(c.sicDescription) +
      "<br>TTM to " + esc(c.asOf) + " · latest FY ended " + esc(c.latestFy) + " · computed " + esc(new Date(c.computedAt).toLocaleString()) +
      '</div><div style="margin-top:10px"><button class="ghost" id="refresh" type="button">Refresh from EDGAR</button></div></div>';
    if (c.excluded) {
      h += '<div class="total"><span class="pill r-Excluded">Excluded</span></div></div><div class="notice">' + esc(c.excluded) + "</div><div style=\"height:20px\"></div>";
      $("card").innerHTML = h; bindRefresh(c.ticker); return;
    }
    h += '<div class="total"><div class="big">' + fmt(c.total) + "<small> / 100</small></div>" +
      '<span class="pill ' + ratingClass(c.rating) + '">' + esc(c.rating) + "</span></div></div>";
    if (c.gated) h += '<div class="notice">Monopoly gate applied: TTM ROIC is ' + (c.ttmRoic == null ? "not computable" : (c.ttmRoic * 100).toFixed(1) + "%") +
      " (below 8%), so the total is capped at 50. Uncapped sum: " + fmt(c.rawTotal) + ".</div>";
    h += '<div class="sections">' + c.sections.map(function (s) {
      return '<div class="sec-sum"><div class="lbl">' + s.id + ". " + esc(s.name) + '</div><div class="v">' + fmt(s.points) + " / " + s.max +
        '</div><div class="bar"><i style="width:' + Math.round((100 * s.points) / s.max) + '%"></i></div></div>';
    }).join("") + "</div>";
    h += c.sections.map(function (s) {
      return '<div class="section"><div class="sec-title"><span>' + s.id + ". " + esc(s.name) + "</span><span>" + fmt(s.points) + " / " + s.max + '</span></div><table class="metrics"><colgroup><col class="c-id"><col><col class="c-val"><col class="c-pts"></colgroup>' +
        s.metrics.map(function (m, i) {
          var inputs = Object.keys(m.inputs || {}).map(function (k) { return "<dt>" + esc(k) + "</dt><dd>" + esc(m.inputs[k]) + "</dd>"; }).join("");
          var src = m.source ? m.source.replace(/(https:\/\/\S+)/, '<a href="$1" target="_blank" rel="noopener">$1</a>') : "";
          return '<tr class="row" data-d="' + s.id + i + '"><td>' + m.id + '</td><td><div class="name">' + esc(m.name) + '</div><div class="band">' + esc(m.band) + '</div></td><td class="val">' +
            esc(m.display) + '</td><td><span class="pts ' + ptsClass(m) + '">' + fmt(m.points) + " / " + m.max + "</span></td></tr>" +
            '<tr class="detail hidden" id="d' + s.id + i + '"><td colspan="4"><div class="f">' + esc(m.formula) + "</div>" +
            (inputs ? "<dl>" + inputs + "</dl>" : "") + (m.note ? '<div class="note">' + esc(m.note) + "</div>" : "") +
            (m.evidence ? "<blockquote>" + esc(m.evidence) + "</blockquote>" : "") + (src ? '<div class="note">Source: ' + src + "</div>" : "") + "</td></tr>";
        }).join("") + "</table></div>";
    }).join("");
    $("card").innerHTML = h;
    bindRefresh(c.ticker);
  }

  function bindRefresh(t) { var b = $("refresh"); if (b) b.onclick = function () { score(t, true); }; }

  $("card").addEventListener("click", function (e) {
    var tr = e.target.closest("tr.row");
    if (tr) $("d" + tr.getAttribute("data-d")).classList.toggle("hidden");
  });

  var ACTIVE = { queued: 1, running: 1, paused: 1, waiting: 1, waitingForPause: 1, unknown: 1 };
  var pollTimer = null;

  // Scoring runs as a background job; this asks for the stored score and the job's state, and polls while it runs.
  function score(t, refresh) {
    t = String(t || "").trim().toUpperCase().replace(/\./g, "-");
    if (!t) return;
    clearTimeout(pollTimer);
    current = t;
    if (location.hash !== "#" + t) history.replaceState(null, "", "#" + t);
    $("card").innerHTML = '<div id="status">Loading ' + esc(t) + "…</div>";
    poll(t, refresh, 0);
  }

  function poll(t, refresh, n) {
    fetch("/api/score/" + encodeURIComponent(t) + (refresh ? "?refresh=1" : ""))
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (x) {
        if (t !== current) return;
        if (!x.ok) throw new Error(x.b.error || "Request failed");
        var job = x.b.job, card = x.b.card;
        var running = job && ACTIVE[job.status];
        if (card) {
          render(card);
          if (running) banner("Updating from SEC filings in the background (" + job.status + ")…");
          else if (job && job.status === "errored" && n > 0) banner("Refresh failed: " + (job.error || "unknown error") + ". Showing the last score.");
        } else if (running) {
          $("card").innerHTML = '<div id="status">Scoring ' + esc(t) + " from SEC filings in the background (" + esc(job.status) +
            "). Fetching and parsing a 10-K takes about 10–60 seconds; you can leave this page.</div>";
        } else if (job && job.status === "errored") {
          throw new Error(job.error || "Scoring failed");
        }
        if (running) pollTimer = setTimeout(function () { poll(t, false, n + 1); }, Math.min(2000 + n * 500, 6000));
        else if (n > 0) loadWatchlist();
      })
      .catch(function (e) { if (t === current) $("card").innerHTML = '<div id="status" class="err">' + esc(e.message) + "</div>"; });
  }

  function banner(msg) {
    var d = document.createElement("div");
    d.className = "notice";
    d.textContent = msg;
    var head = $("card").querySelector(".card-head");
    if (head) head.insertAdjacentElement("afterend", d);
  }

  $("f").addEventListener("submit", function (e) { e.preventDefault(); score($("q").value, false); $("q").value = ""; });
  $("q").addEventListener("input", function () { $("go").disabled = !$("q").value.trim(); });
  $("go").disabled = true;
  window.addEventListener("hashchange", function () {
    var t = decodeURIComponent(location.hash.slice(1)).toUpperCase();
    if (t && t !== current) score(t, false);
  });
  loadWatchlist();
  if (location.hash.length > 1) score(decodeURIComponent(location.hash.slice(1)), false);
})();
</script>
</body>
</html>`;
