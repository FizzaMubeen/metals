/* Metals News & Learnings — front end. Plain JavaScript, no build step. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const SVG = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}, text) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const nf = (v, d = 2) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const signed = (v, d = 1, suf = '%') => v == null || isNaN(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + nf(Math.abs(v), d) + suf;
  const money = (v) => v == null ? '—' : '$' + (Math.abs(v) >= 1000 ? nf(v, 0) : nf(v, 2));
  const col = (s) => s > 0 ? 'var(--up)' : s < 0 ? 'var(--down)' : 'var(--hold)';
  const tone = (s) => s >= 10 ? 'buy' : s <= -10 ? 'sell' : 'hold';
  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso.replace('Z', ':00Z'));
    if (isNaN(d)) return iso;
    const h = (Date.now() - d) / 36e5;
    if (iso.length > 10 && h < 24) return h < 1 ? 'just now' : Math.round(h) + 'h ago';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const safeUrl = (u) => typeof u === 'string' && /^https?:\/\//.test(u) ? u : null;

  const ASSETS = [['gold', 'Gold', 'per oz'], ['silver', 'Silver', 'per oz'], ['copper', 'Copper', 'per lb'], ['miners', 'Gold miners', 'GDX share']];
  const state = { asset: 'gold', metal: 'all', topic: 'all', q: '' };
  let D = null, LEARN = null, CB = null, HIST = [];

  // ---------- theme
  const root = document.documentElement;
  try { const t = localStorage.getItem('theme'); if (t) root.dataset.theme = t; } catch (e) { /* ignore */ }
  $('#theme').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (e) { /* ignore */ }
  });

  // ---------- tabs
  const showTab = (name) => {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + name; });
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    render();
  };
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  addEventListener('hashchange', () => {
    const t = location.hash.slice(1);
    if (document.querySelector(`.tabs button[data-tab="${t}"]`)) showTab(t);
  });

  // ---------- tooltip
  const tip = $('#tip');
  const showTip = (ev, title, body) => {
    tip.replaceChildren(el('b', null, title), el('span', null, body));
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(innerWidth - w - 8, ev.clientX + 14) + 'px';
    tip.style.top = Math.min(innerHeight - h - 8, ev.clientY + 14) + 'px';
  };
  const hideTip = () => { tip.hidden = true; };

  // ---------- loading
  const load = async (path) => {
    const r = await fetch(path + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error(path + ' ' + r.status);
    return path.endsWith('.csv') ? r.text() : r.json();
  };
  const parseCsv = (txt) => {
    const lines = txt.trim().split(/\r?\n/);
    const head = lines.shift().split(',');
    return lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])));
  };

  Promise.allSettled([load('data/latest.json'), load('data/learnings.json'), load('data/central_banks.json'), load('data/history.csv')])
    .then(([a, b, c, d]) => {
      D = a.status === 'fulfilled' ? a.value : null;
      LEARN = b.status === 'fulfilled' ? b.value : null;
      CB = c.status === 'fulfilled' ? c.value : (D && D.central_banks) || null;
      HIST = d.status === 'fulfilled' ? parseCsv(d.value) : [];
      if (!D) {
        const al = $('#alert');
        al.hidden = false;
        al.textContent = 'No data yet. Run the "Daily fetch" workflow on GitHub (Actions tab → Daily fetch → Run workflow), or run python scripts/fetch.py on your computer.';
        $('#updated').textContent = '';
      } else {
        $('#updated').textContent = 'Updated ' + when(D.generated_at) + '.';
        if (D.errors && D.errors.length) {
          const al = $('#alert');
          al.hidden = false;
          al.textContent = 'Some sources could not be reached in the last update: ' + D.errors.join('; ') + '. Older values are shown where available.';
        }
      }
      buildControls();
      const start = (location.hash || '#overview').slice(1);
      showTab(document.querySelector(`.tabs button[data-tab="${start}"]`) ? start : 'overview');
    });

  let resizeT;
  addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(render, 150); });

  // ---------- controls
  function chipGroup(container, items, key) {
    container.replaceChildren();
    items.forEach(([val, label]) => {
      const b = el('button', null, label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state[key] === val));
      b.addEventListener('click', () => {
        state[key] = val;
        container.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        render();
      });
      container.appendChild(b);
    });
  }
  function buildControls() {
    chipGroup($('#asset-picker'), ASSETS.map(([k, l]) => [k, l]), 'asset');
    chipGroup($('#metal-filter'), [['all', 'All metals'], ['gold', 'Gold'], ['silver', 'Silver'], ['copper', 'Copper']], 'metal');
    const topics = new Set();
    (D?.news || []).forEach((n) => n.topics.forEach((t) => topics.add(t)));
    chipGroup($('#topic-filter'), [['all', 'All topics'], ...[...topics].sort().map((t) => [t, t[0].toUpperCase() + t.slice(1)])], 'topic');
    $('#news-search').addEventListener('input', (e) => { state.q = e.target.value.toLowerCase(); renderNews(); });
  }

  // ---------- render
  function render() {
    const tab = document.querySelector('.tabs button[aria-selected="true"]')?.dataset.tab || 'overview';
    if (tab === 'overview') renderOverview();
    if (tab === 'indicators') renderIndicators();
    if (tab === 'news') renderNews();
    if (tab === 'buyers') renderBuyers();
    if (tab === 'learnings') renderLearnings();
  }

  function sparkline(hist, w, h) {
    const s = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', height: h, preserveAspectRatio: 'none' });
    if (!hist || hist.length < 2) return s;
    const vals = hist.map((p) => p[1]);
    const lo = Math.min(...vals), hi = Math.max(...vals) || 1;
    const x = (i) => i / (vals.length - 1) * w;
    const y = (v) => h - 2 - (v - lo) / ((hi - lo) || 1) * (h - 4);
    const d = vals.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
    const up = vals[vals.length - 1] >= vals[0];
    s.appendChild(svgEl('path', { d, fill: 'none', stroke: up ? 'var(--up)' : 'var(--down)', 'stroke-width': 1.6, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    return s;
  }

  function renderOverview() {
    const tk = $('#takeaways');
    tk.replaceChildren(...(D?.takeaways || ['Waiting for the first daily update.']).map((t) => el('li', null, t)));
    const box = $('#assets');
    box.replaceChildren();
    ASSETS.forEach(([key, label, unit]) => {
      const a = D?.assets?.find((x) => x.asset === key);
      const p = D?.prices?.[key];
      const c = el('article', 'card asset');
      const head = el('div', 'head');
      head.append(el('h3', null, label));
      if (a) head.append(el('span', 'badge ' + tone(a.score), a.verdict));
      c.append(head);
      const pr = el('div', 'price', p ? money(p.price) + ' ' : '—');
      pr.append(el('small', null, unit));
      c.append(pr);
      const ch = el('div', 'changes');
      if (p) {
        [['Day', p.chg_1d], ['Month', p.chg_1m], ['Year', p.chg_1y]].forEach(([n, v], i) => {
          if (i) ch.append(' · ');
          ch.append(n + ' ');
          ch.append(el('span', v > 0 ? 'up' : v < 0 ? 'down' : '', signed(v)));
        });
      }
      c.append(ch);
      if (p) { const sp = el('div', 'spark'); sp.append(sparkline(p.history.slice(-130), 240, 40)); c.append(sp); }
      if (a) {
        const bar = el('div', 'lean');
        [['b', a.buy], ['h', a.hold], ['s', a.sell]].forEach(([k, v]) => { if (v > 0) { const s = el('div', k); s.style.width = v + '%'; bar.append(s); } });
        const lg = el('div', 'legend');
        [['Buy', a.buy, 'var(--up)'], ['Hold', a.hold, 'var(--hold)'], ['Sell', a.sell, 'var(--down)']].forEach(([n, v, cl]) => {
          const it = el('span'); const sw = el('i'); sw.style.background = cl; it.append(sw, n + ' ' + v + '%'); lg.append(it);
        });
        c.append(bar, lg);
        const gr = el('div', 'groups');
        ['Macro', 'Flows', 'Sentiment'].forEach((g) => {
          const v = a.groups?.[g];
          const row = el('div', 'grow');
          const tr = el('div', 'track');
          if (v != null) {
            const f = el('div', 'fill'); const w = Math.min(50, Math.abs(v) / 2);
            f.style.left = (v >= 0 ? 50 : 50 - w) + '%'; f.style.width = w + '%'; f.style.background = col(v); tr.append(f);
          }
          row.append(el('span', null, g), tr, el('span', 'v', v == null ? '—' : signed(v, 0, '')));
          gr.append(row);
        });
        c.append(gr);
        const sc = el('div', 'score', 'Score ');
        sc.append(el('b', null, signed(a.score, 0, '')), ' on a −100 to +100 scale');
        c.append(sc);
      }
      box.append(c);
    });
    renderHistory();
  }

  function renderHistory() {
    const box = $('#history');
    box.replaceChildren();
    const rows = HIST.filter((r) => r.date);
    if (rows.length < 2) { box.append(el('p', 'empty', 'The history chart fills in after a few daily updates.')); return; }
    const W = Math.max(300, box.clientWidth), H = 220, m = { l: 34, r: 90, t: 10, b: 24 };
    const s = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' });
    const x = (i) => m.l + i / (rows.length - 1) * (W - m.l - m.r);
    const y = (v) => m.t + (100 - v) / 200 * (H - m.t - m.b);
    [-100, -50, 0, 50, 100].forEach((t) => {
      s.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), stroke: t === 0 ? 'var(--muted)' : 'var(--grid)' }));
      s.append(svgEl('text', { x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, t > 0 ? '+' + t : String(t)));
    });
    const colors = { gold: 'var(--gold)', silver: '#8a8f98', copper: '#c46a36', miners: '#4f7cac' };
    const ends = [];
    ASSETS.forEach(([k, label]) => {
      const pts = rows.map((r, i) => [x(i), Number(r[k + '_score'])]).filter((p) => !isNaN(p[1]));
      if (pts.length < 2) return;
      s.append(svgEl('path', { d: pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' '), fill: 'none', stroke: colors[k], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      ends.push({ y: y(pts[pts.length - 1][1]), label: label + ' ' + signed(pts[pts.length - 1][1], 0, ''), c: colors[k] });
    });
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
    ends.forEach((e) => s.append(svgEl('text', { x: W - m.r + 6, y: e.y + 4, fill: e.c, style: 'fill:' + e.c }, e.label)));
    s.append(svgEl('text', { x: m.l, y: H - 6, class: 'tick' }, when(rows[0].date)));
    s.append(svgEl('text', { x: W - m.r, y: H - 6, class: 'tick', 'text-anchor': 'end' }, when(rows[rows.length - 1].date)));
    box.append(s);
  }

  function measure(svg, texts, cls) {
    let max = 0;
    texts.forEach((t) => { const n = svgEl('text', cls ? { class: cls } : {}, t); svg.append(n); max = Math.max(max, n.getComputedTextLength()); n.remove(); });
    return max;
  }
  const fit = (t, px) => { const n = Math.floor(px / 6.6); return t.length > n ? t.slice(0, Math.max(4, n - 1)) + '…' : t; };

  function divergingBars(box, rows, opts = {}) {
    // rows: [{header}] or [{label, value, title, body}]
    box.replaceChildren();
    if (!rows.length) { box.append(el('p', 'empty', opts.empty || 'No data yet.')); return; }
    const W = Math.max(300, box.clientWidth), rowH = 28, headH = 26, top = opts.axis ? 22 : 6;
    const H = top + rows.reduce((h, r) => h + (r.header ? headH : rowH), 0) + 4;
    const s = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' });
    box.append(s);
    const labW = Math.min(W * 0.42, measure(s, rows.filter((r) => !r.header).map((r) => r.label)) + 10);
    const vals = rows.filter((r) => !r.header).map((r) => r.text || signed(r.value, 0, opts.suffix || ''));
    const valW = measure(s, vals, 'tick') + 10;
    const ext = opts.ext || Math.max(1, ...rows.filter((r) => !r.header).map((r) => Math.abs(r.value)));
    const x = (v) => labW + valW + (v + ext) / (2 * ext) * (W - labW - 2 * valW);
    if (opts.axis) {
      [-ext, -ext / 2, 0, ext / 2, ext].forEach((t) => {
        s.append(svgEl('line', { x1: x(t), x2: x(t), y1: top - 4, y2: H, stroke: t === 0 ? 'var(--muted)' : 'var(--grid)' }));
        s.append(svgEl('text', { x: x(t), y: 12, 'text-anchor': 'middle', class: 'tick' }, t > 0 ? '+' + t : String(t)));
      });
    } else {
      s.append(svgEl('line', { x1: x(0), x2: x(0), y1: 0, y2: H, stroke: 'var(--muted)' }));
    }
    let y = top;
    rows.forEach((r) => {
      if (r.header) { s.append(svgEl('text', { x: 0, y: y + 17, class: 'grp' }, r.header.toUpperCase())); y += headH; return; }
      const g = svgEl('g');
      g.append(svgEl('rect', { x: 0, y, width: W, height: rowH, fill: 'transparent' }));
      g.append(svgEl('text', { x: 0, y: y + rowH / 2 + 4 }, fit(r.label, labW - 8)));
      const x0 = x(0), x1 = x(r.value);
      g.append(svgEl('rect', { x: Math.min(x0, x1), y: y + 7, width: Math.max(2, Math.abs(x1 - x0)), height: rowH - 14, rx: 4, fill: col(r.value) }));
      g.append(svgEl('text', { x: r.value >= 0 ? x1 + 5 : x1 - 5, y: y + rowH / 2 + 4, 'text-anchor': r.value >= 0 ? 'start' : 'end', class: 'tick' }, r.text || signed(r.value, 0, opts.suffix || '')));
      if (r.body) {
        g.addEventListener('mousemove', (ev) => showTip(ev, r.title || r.label, r.body));
        g.addEventListener('mouseleave', hideTip);
      }
      s.append(g);
      y += rowH;
    });
  }

  function renderIndicators() {
    const key = state.asset;
    const groups = ['Macro', 'Flows', 'Sentiment'];
    const rows = [];
    groups.forEach((g) => {
      const items = (D?.factors || []).filter((f) => f.group === g && f.applies[key])
        .map((f) => ({ ...f, impact: Math.max(-100, Math.min(100, Math.round(f.score * f.applies[key]))) }))
        .sort((a, b) => b.impact - a.impact);
      if (items.length) {
        rows.push({ header: g });
        items.forEach((f) => rows.push({ label: f.name, value: f.impact, title: f.name + ' · ' + when(f.as_of), body: f.reading }));
      }
    });
    divergingBars($('#factor-chart'), rows, { axis: true, ext: 100, empty: 'No indicators yet. Run the daily fetch.' });

    const t = $('#factor-table');
    t.replaceChildren();
    const thead = el('thead'); const hr = el('tr');
    [['Indicator'], ['Group', 'hide-sm'], ['Latest reading'], ['As of', 'hide-sm'], ['Score'], ['What it teaches', 'hide-sm'], ['Source', 'hide-sm']]
      .forEach(([h, c]) => hr.append(el('th', c || null, h)));
    thead.append(hr); t.append(thead);
    const tb = el('tbody');
    (D?.factors || []).forEach((f) => {
      const tr = el('tr');
      tr.append(el('td', null, f.name), el('td', 'hide-sm', f.group), el('td', null, f.reading), el('td', 'hide-sm', when(f.as_of)));
      const sc = el('td', 'n', signed(f.score, 0, '')); sc.style.color = col(f.score); tr.append(sc);
      tr.append(el('td', 'hide-sm', f.learning));
      const src = el('td', 'hide-sm');
      const u = safeUrl(f.url);
      if (u) { const a = el('a', null, f.source); a.href = u; a.target = '_blank'; a.rel = 'noopener'; src.append(a); } else src.textContent = f.source;
      tr.append(src);
      tb.append(tr);
    });
    t.append(tb);
  }

  function newsItem(n) {
    const li = el('li');
    li.append(el('span', 'dot ' + n.tone));
    const body = el('div');
    const u = safeUrl(n.url);
    const a = el('a', null, n.title);
    if (u) { a.href = u; a.target = '_blank'; a.rel = 'noopener'; }
    body.append(a);
    const meta = el('div', 'meta');
    meta.append(el('span', null, n.source), el('span', null, '· ' + when(n.published)));
    (n.metals || []).forEach((m) => meta.append(el('span', 'tag', m)));
    (n.topics || []).forEach((m) => meta.append(el('span', 'tag', m)));
    if (n.cb_action) meta.append(el('span', 'tag', (n.cb_country ? n.cb_country + ' ' : '') + n.cb_action));
    body.append(meta);
    li.append(body);
    return li;
  }

  function renderNews() {
    const list = (D?.news || []).filter((n) =>
      (state.metal === 'all' || n.metals.includes(state.metal)) &&
      (state.topic === 'all' || n.topics.includes(state.topic)) &&
      (!state.q || n.title.toLowerCase().includes(state.q)));
    $('#news-count').textContent = list.length + ' headlines from the last two weeks. Green dot: bullish wording, red: bearish, grey: neutral.';
    const ul = $('#news-list');
    ul.replaceChildren(...list.slice(0, 120).map(newsItem));
    if (!list.length) ul.append(el('li', 'empty', 'No headlines match.'));
  }

  function renderBuyers() {
    const cb = CB || {};
    const tiles = $('#cb-tiles');
    tiles.replaceChildren();
    const addTile = (n, l) => { const t = el('div', 'tile'); t.append(el('div', 'n', n), el('div', 'l', l)); tiles.append(t); };
    if (cb.latest_month_net_tonnes != null) addTile(signed(cb.latest_month_net_tonnes, 0, ' t'), 'Global net central bank buying, ' + (cb.latest_month || ''));
    const buys = (D?.news || []).filter((n) => n.cb_action === 'buying');
    const sells = (D?.news || []).filter((n) => n.cb_action === 'selling');
    addTile(String(buys.length), 'Buying headlines, 2 weeks');
    addTile(String(sells.length), 'Selling headlines, 2 weeks');
    $('#cb-highlights').replaceChildren(...(cb.highlights || []).map((h) => el('li', null, h)));
    $('#cb-source').textContent = cb.source ? 'Monthly figures: ' + cb.source + (cb.as_of ? ', ' + when(cb.as_of) : '') + '. Updated by hand in data/central_banks.json.' : '';
    $('#cb-country-title').textContent = 'Net change by country' + (cb.by_country_period ? ', ' + cb.by_country_period : '');
    const rows = [...(cb.by_country || [])].sort((a, b) => b.tonnes - a.tonnes).map((r) => ({ label: r.country, value: r.tonnes, text: signed(r.tonnes, 0, ' t') }));
    divergingBars($('#cb-chart'), rows, { empty: 'Add countries to data/central_banks.json.' });
    const fill = (ul, arr) => { ul.replaceChildren(...arr.slice(0, 12).map(newsItem)); if (!arr.length) ul.append(el('li', 'empty', 'None in the last two weeks.')); };
    fill($('#cb-buy-news'), buys);
    fill($('#cb-sell-news'), sells);
    renderBanks();
  }

  function renderBanks() {
    const box = $('#bank-chart');
    box.replaceChildren();
    const spot = D?.prices?.gold?.price;
    const rows = [...(CB?.bank_targets || [])].sort((a, b) => b.target - a.target);
    if (!spot || !rows.length) { box.append(el('p', 'empty', 'Add bank targets to data/central_banks.json.')); return; }
    const W = Math.max(300, box.clientWidth), rowH = 42, top = 26, H = top + rows.length * rowH + 6;
    const s = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' });
    box.append(s);
    const labW = Math.min(W * 0.42, Math.max(measure(s, rows.map((r) => r.bank)), measure(s, rows.map((r) => r.horizon + ' · ' + r.scenario), 'tick')) + 14);
    const endLab = (r) => money(r.target) + ' · ' + signed((r.target / spot - 1) * 100, 0);
    const endW = measure(s, rows.map(endLab), 'tick') + 12;
    const lo = Math.min(spot, ...rows.map((r) => r.target)) * 0.97, hi = Math.max(spot, ...rows.map((r) => r.target));
    const x = (v) => labW + (v - lo) / (hi - lo || 1) * (W - labW - endW);
    s.append(svgEl('line', { x1: x(spot), x2: x(spot), y1: top - 6, y2: H, stroke: 'var(--muted)', 'stroke-dasharray': '4 3' }));
    s.append(svgEl('text', { x: x(spot), y: 12, 'text-anchor': 'middle', class: 'tick' }, 'Today ' + money(spot)));
    rows.forEach((r, i) => {
      const y = top + i * rowH + 12, c = r.target >= spot ? 'var(--up)' : 'var(--down)';
      s.append(svgEl('text', { x: 0, y: y + 4 }, r.bank));
      s.append(svgEl('text', { x: 0, y: y + 19, class: 'tick' }, fit(r.horizon + ' · ' + r.scenario, labW - 6)));
      s.append(svgEl('line', { x1: x(spot), x2: x(r.target), y1: y, y2: y, stroke: c, 'stroke-width': 2, 'stroke-linecap': 'round' }));
      s.append(svgEl('circle', { cx: x(r.target), cy: y, r: 5, fill: c }));
      s.append(svgEl('text', { x: x(r.target) + 9, y: y + 4, class: 'tick' }, endLab(r)));
    });
  }

  function renderLearnings() {
    const notes = $('#notes');
    notes.replaceChildren(...(LEARN?.notes || []).map((n) => {
      const li = el('li');
      li.append(el('div', null, n.text));
      li.append(el('div', 'meta', (n.author || '') + ' · ' + when(n.date)));
      return li;
    }));
    if (!(LEARN?.notes || []).length) notes.append(el('li', 'empty', 'Add notes in data/learnings.json.'));
    $('#lessons').replaceChildren(...(LEARN?.lessons || []).map((l) => {
      const c = el('article', 'card lesson');
      c.append(el('h3', null, l.title), el('p', null, l.text));
      return c;
    }));
  }
})();
