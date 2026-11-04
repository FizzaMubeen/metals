// Calculations and drawings for the Metals Signal Tracker.
(() => {
  const ASSETS = { 'Gold': 'f_gold', 'Silver': 'f_silver', 'Copper': 'f_copper', 'Gold miners': 'f_miners' };
  const STALE_HOURS = 36;

  // ---------- Calculations ----------
  const weighted = (signals, f, filter) => {
    let num = 0, den = 0;
    for (const s of signals) {
      if (filter && !filter(s)) continue;
      const k = Number(s[f]) || 0, w = Number(s.w) || 0;
      num += Number(s.score) * w * k;
      den += w * Math.abs(k);
    }
    return den ? Math.round(num / den) : null;
  };
  const verdictOf = (score) => score >= 25 ? 'Accumulate' : score >= 10 ? 'Lean buy' : score > -10 ? 'Hold' : score > -25 ? 'Lean reduce' : 'Reduce';

  dash.calc('asset_scores', {
    inputs: ['signals'],
    fn: (signals) => Object.entries(ASSETS).map(([asset, f]) => {
      const score = weighted(signals, f) ?? 0;
      const buy = Math.max(0, score), sell = Math.max(0, -score);
      return { asset, score, buy, hold: 100 - buy - sell, sell, verdict: verdictOf(score) };
    }),
  });

  dash.calc('group_scores', {
    inputs: ['signals'],
    fn: (signals) => {
      const out = [];
      for (const [asset, f] of Object.entries(ASSETS)) {
        for (const grp of ['Macro', 'Flows', 'Sentiment']) {
          out.push({ asset, grp, score: weighted(signals, f, (s) => s.grp === grp) });
        }
      }
      return out;
    },
  });

  dash.calc('top_drivers', {
    inputs: ['signals'],
    fn: (signals) => {
      const rows = signals
        .map((s) => ({ indicator: s.indicator, impact: Number(s.score) * Number(s.w) * Number(s.f_gold) }))
        .filter((s) => s.impact !== 0)
        .sort((a, b) => b.impact - a.impact);
      if (!rows.length) return [];
      return [
        { side: 'support', indicator: rows[0].indicator },
        { side: 'headwind', indicator: rows[rows.length - 1].indicator },
      ];
    },
  });

  dash.calc('price_stats', {
    inputs: ['prices'],
    fn: (prices) => prices.map((p) => ({
      asset: p.asset,
      from_record_pct: p.record ? Math.round((Number(p.price) / Number(p.record) - 1) * 1000) / 10 : null,
    })),
  });

  // ---------- Helpers ----------
  const rowOf = (id, key, val) => {
    const d = dash.data(id);
    return d.status === 'ok' ? (d.data || []).find((r) => r[key] === val) : null;
  };
  const money = (v) => '$' + (Math.abs(v) >= 1000 ? d3.format(',.0f')(v) : d3.format(',.2f')(v));
  const pct = (v) => d3.format('+.1f')(v) + '%';
  const tone = (s) => (s >= 10 ? 'is-buy' : s <= -10 ? 'is-sell' : 'is-hold');
  const signedCol = (s) => (s > 0 ? 'var(--color-ok)' : s < 0 ? 'var(--color-bad)' : 'var(--chart-muted)');
  const fmtDate = (s) => { const d = new Date(String(s).slice(0, 10) + 'T00:00:00Z'); return isNaN(d) ? '—' : d3.utcFormat('%-d %b %Y')(d); };
  const fetchedAt = () => {
    const r = rowOf('prices', 'asset', 'Gold');
    const t = r && r.fetched_at ? new Date(r.fetched_at) : null;
    return t && !isNaN(t) ? t : null;
  };

  // ---------- Controls ----------
  document.querySelectorAll('.mt-seg button').forEach((b) => {
    b.addEventListener('click', () => dash.setParams({ asset: b.dataset.asset }));
  });
  document.querySelectorAll('.mt-refresh').forEach((b) => {
    b.addEventListener('click', () => dash.refreshAll());
  });
  dash.onData(() => {
    const a = dash.params().asset || 'Gold';
    document.querySelectorAll('.mt-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.asset === a)));
    const busy = dash.sources.some((id) => { const d = dash.data(id); return d.refreshing || d.status === 'loading'; });
    document.querySelectorAll('.mt-refresh').forEach((b) => { b.disabled = busy; b.setAttribute('aria-busy', String(busy)); });
    document.querySelectorAll('.mt-refresh-idle').forEach((s) => { s.hidden = busy; });
    document.querySelectorAll('.mt-refresh-busy').forEach((s) => { s.hidden = !busy; });
  });

  // Link to the "Run workflow" page when hosted on GitHub Pages (user.github.io/repo).
  (() => {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    const repo = location.pathname.split('/').filter(Boolean)[0];
    if (!m || !repo) return;
    const href = `https://github.com/${m[1]}/${repo}/actions/workflows/update-data.yml`;
    document.querySelectorAll('.mt-runlink').forEach((a) => { a.href = href; });
    document.querySelectorAll('.mt-runwrap').forEach((s) => { s.hidden = false; });
  })();

  // ---------- Small drawings ----------
  dash.draw('fetched', (el) => {
    const t = fetchedAt();
    const p = dash.data('prices');
    el.classList.toggle('mt-error', p.status === 'error');
    el.textContent = p.status === 'error' ? 'data failed to load' : t ? d3.timeFormat('%-I:%M %p, %-d %b %Y')(t) : '—';
  });
  dash.draw('fresh-dot', (el) => {
    const t = fetchedAt();
    const stale = t && (Date.now() - t.getTime()) / 36e5 > STALE_HOURS;
    el.className = 'mt-dot' + (t ? (stale ? ' is-stale' : ' is-fresh') : '');
    el.title = t ? (stale ? 'Older than ' + STALE_HOURS + ' hours' : 'Up to date') : '';
  });
  dash.draw('asof', (el) => {
    const r = rowOf('prices', 'asset', 'Gold');
    el.textContent = r ? fmtDate(r.as_of) : '—';
  });
  dash.draw('verdict-text', (el) => {
    const r = rowOf('asset_scores', 'asset', el.dataset.asset);
    el.textContent = r ? r.verdict : '—';
  });
  dash.draw('driver', (el) => {
    const r = rowOf('top_drivers', 'side', el.dataset.side);
    el.textContent = r ? r.indicator : '—';
  });
  dash.draw('badge', (el) => {
    const r = rowOf('asset_scores', 'asset', el.dataset.asset);
    el.className = 'mt-badge' + (r ? ' ' + tone(r.score) : '');
    el.textContent = r ? r.verdict : '—';
  });
  dash.draw('price', (el) => {
    const r = rowOf('prices', 'asset', el.dataset.asset);
    el.textContent = r && r.price != null ? money(Number(r.price)) : '—';
  });
  dash.draw('chg', (el) => {
    const r = rowOf('prices', 'asset', el.dataset.asset);
    const v = r && r.change_1m_pct != null ? Number(r.change_1m_pct) : null;
    el.className = v == null ? '' : v >= 0 ? 'mt-up' : 'mt-down';
    el.textContent = v == null ? '—' : pct(v);
  });
  dash.draw('offrec', (el) => {
    const r = rowOf('price_stats', 'asset', el.dataset.asset);
    const v = r && r.from_record_pct != null ? Number(r.from_record_pct) : null;
    el.textContent = v == null ? '—' : pct(v);
  });
  dash.draw('score', (el) => {
    const r = rowOf('asset_scores', 'asset', el.dataset.asset);
    el.textContent = r ? d3.format('+d')(r.score) : '—';
  });
  dash.draw('cbv', (el) => {
    const r = rowOf('cb_summary', 'metric', el.dataset.metric);
    el.textContent = r ? d3.format(',')(Number(r.value)) : '—';
  });
  dash.draw('cb-period', (el) => {
    const d = dash.data('cb_flows');
    el.textContent = d.status === 'ok' && d.data.length ? d.data[0].period : '—';
  });

  dash.draw('lean', (el) => {
    el.replaceChildren();
    const r = rowOf('asset_scores', 'asset', el.dataset.asset);
    if (!r) return;
    const bar = document.createElement('div');
    bar.className = 'mt-bar';
    const legend = document.createElement('div');
    legend.className = 'mt-legend';
    [['Buy', r.buy, 'mt-seg-buy'], ['Hold', r.hold, 'mt-seg-hold'], ['Sell', r.sell, 'mt-seg-sell']].forEach(([name, v, cls]) => {
      if (v > 0) { const s = document.createElement('div'); s.className = cls; s.style.width = v + '%'; bar.appendChild(s); }
      const item = document.createElement('span');
      const sw = document.createElement('i'); sw.className = cls;
      item.append(sw, document.createTextNode(name + ' ' + v + '%'));
      legend.appendChild(item);
    });
    el.append(bar, legend);
  });

  dash.draw('groups', (el) => {
    el.replaceChildren();
    const d = dash.data('group_scores');
    if (d.status !== 'ok') return;
    d.data.filter((g) => g.asset === el.dataset.asset).forEach((g) => {
      const row = document.createElement('div'); row.className = 'mt-grow';
      const lab = document.createElement('span'); lab.textContent = g.grp;
      const track = document.createElement('div'); track.className = 'mt-grow-track';
      const val = document.createElement('span'); val.className = 'mt-grow-val';
      if (g.score != null) {
        const fill = document.createElement('div'); fill.className = 'mt-grow-fill';
        const w = Math.min(50, Math.abs(g.score) / 2);
        fill.style.left = (g.score >= 0 ? 50 : 50 - w) + '%';
        fill.style.width = w + '%';
        fill.style.background = signedCol(g.score);
        track.appendChild(fill);
        val.textContent = d3.format('+d')(g.score);
      } else { val.textContent = '—'; }
      row.append(lab, track, val);
      el.appendChild(row);
    });
  });

  // ---------- Charts ----------
  const measure = (svg, texts, cls) => {
    let max = 0;
    texts.forEach((t) => {
      const n = svg.append('text').attr('class', cls || null).text(t);
      max = Math.max(max, n.node().getComputedTextLength());
      n.remove();
    });
    return max;
  };
  // Truncate text to fit a pixel width, measuring the real rendered length.
  const fitText = (node, text, px) => {
    node.text(text);
    if (node.node().getComputedTextLength() <= px) return;
    let lo = 1, hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      node.text(text.slice(0, mid) + '…');
      if (node.node().getComputedTextLength() <= px) lo = mid; else hi = mid - 1;
    }
    node.text(text.slice(0, lo) + '…');
    node.append('title').text(text);
  };
  const makeTip = (el) => {
    const tip = document.createElement('div'); tip.className = 'mt-tip'; tip.style.display = 'none';
    const th = document.createElement('div'); th.className = 'mt-tip-h';
    const tb = document.createElement('div');
    tip.append(th, tb);
    el.appendChild(tip);
    return {
      show(head, body, x, y) {
        th.textContent = head; tb.textContent = body; tip.style.display = 'block';
        const tw = tip.offsetWidth;
        tip.style.left = Math.max(0, Math.min(el.clientWidth - tw, x + 12)) + 'px';
        tip.style.top = y + 'px';
      },
      hide() { tip.style.display = 'none'; },
    };
  };

  dash.draw('drivers', (el) => {
    el.replaceChildren();
    const d = dash.data('signals');
    if (d.status !== 'ok') { el.textContent = d.status === 'error' ? 'Signals failed to load.' : ''; return; }
    const asset = dash.params().asset || 'Gold';
    const f = ASSETS[asset] || 'f_gold';
    const rows = [];
    ['Macro', 'Flows', 'Sentiment'].forEach((g) => {
      const items = d.data.filter((s) => s.grp === g && Number(s[f]))
        .map((s) => ({ ...s, impact: Math.max(-100, Math.min(100, Math.round(Number(s.score) * Number(s[f])))) }))
        .sort((a, b) => b.impact - a.impact);
      if (items.length) { rows.push({ header: g }); items.forEach((i) => rows.push(i)); }
    });
    const W = Math.max(280, el.clientWidth);
    const rowH = 26, headH = 26, top = 22;
    const H = top + rows.reduce((h, r) => h + (r.header ? headH : rowH), 0) + 4;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Signal impact on ' + asset);
    const maxLab = Math.min(W * 0.42, measure(svg, rows.filter((r) => !r.header).map((r) => r.indicator)) + 8);
    const valW = measure(svg, ['-100'], 'mt-tick') + 10;
    const x = d3.scaleLinear([-100, 100], [maxLab + valW, W - valW]);
    [-100, -50, 0, 50, 100].forEach((t) => {
      svg.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', top - 4).attr('y2', H)
        .attr('stroke', t === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)').attr('stroke-width', 1);
      svg.append('text').attr('class', 'mt-tick').attr('x', x(t)).attr('y', 12).attr('text-anchor', 'middle').text(t === 0 ? '0' : d3.format('+d')(t));
    });
    const tip = makeTip(el);
    let y = top;
    rows.forEach((r) => {
      if (r.header) {
        svg.append('text').attr('class', 'mt-grp').attr('x', 0).attr('y', y + 17).text(r.header);
        y += headH; return;
      }
      const g = svg.append('g');
      g.append('rect').attr('x', 0).attr('y', y).attr('width', W).attr('height', rowH).attr('fill', 'transparent');
      fitText(g.append('text').attr('x', 0).attr('y', y + rowH / 2 + 4), r.indicator, maxLab - 8);
      const x0 = x(0), x1 = x(r.impact);
      g.append('rect').attr('x', Math.min(x0, x1)).attr('y', y + 6).attr('width', Math.max(2, Math.abs(x1 - x0))).attr('height', rowH - 12)
        .attr('rx', 3).attr('fill', signedCol(r.impact));
      g.append('text').attr('class', 'mt-tick').attr('x', r.impact >= 0 ? x1 + 5 : x1 - 5).attr('y', y + rowH / 2 + 4)
        .attr('text-anchor', r.impact >= 0 ? 'start' : 'end').text(d3.format('+d')(r.impact));
      const ry = y;
      g.on('mouseenter mousemove click', (ev) => {
        const [mx] = d3.pointer(ev, el);
        tip.show(r.pillar + ' · ' + fmtDate(r.as_of), r.reading, mx, (ry + rowH) * el.clientWidth / W + 4);
      }).on('mouseleave', () => tip.hide());
      y += rowH;
    });
  });

  dash.draw('cb', (el) => {
    el.replaceChildren();
    const d = dash.data('cb_flows');
    if (d.status !== 'ok') return;
    const rows = [...d.data].sort((a, b) => Number(b.tonnes) - Number(a.tonnes));
    const W = Math.max(260, el.clientWidth), rowH = 28, top = 6;
    const H = top + rows.length * rowH + 4;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Central bank net gold change by country');
    const labW = measure(svg, rows.map((r) => r.country)) + 10;
    const valW = measure(svg, rows.map((r) => d3.format('+d')(Number(r.tonnes)) + ' t'), 'mt-tick') + 8;
    const ext = d3.max(rows, (r) => Math.abs(Number(r.tonnes))) || 1;
    const x = d3.scaleLinear([-ext, ext], [labW + valW, W - valW]);
    svg.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', 0).attr('y2', H).attr('stroke', 'var(--chart-axis)');
    rows.forEach((r, i) => {
      const t = Number(r.tonnes), y = top + i * rowH, x0 = x(0), x1 = x(t);
      svg.append('text').attr('x', 0).attr('y', y + rowH / 2 + 4).text(r.country);
      svg.append('rect').attr('x', Math.min(x0, x1)).attr('y', y + 6).attr('width', Math.max(2, Math.abs(x1 - x0))).attr('height', rowH - 12)
        .attr('rx', 3).attr('fill', signedCol(t));
      svg.append('text').attr('class', 'mt-tick').attr('x', t >= 0 ? x1 + 5 : x1 - 5).attr('y', y + rowH / 2 + 4)
        .attr('text-anchor', t >= 0 ? 'start' : 'end').text(d3.format('+d')(t) + ' t');
    });
  });

  dash.draw('banks', (el) => {
    el.replaceChildren();
    const b = dash.data('bank_targets'), p = rowOf('prices', 'asset', 'Gold');
    if (b.status !== 'ok' || !p) return;
    const spot = Number(p.price);
    const rows = [...b.data].sort((a, c) => Number(c.target) - Number(a.target));
    const W = Math.max(280, el.clientWidth), rowH = 40, top = 26;
    const H = top + rows.length * rowH + 6;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Bank gold targets compared with spot');
    const labW = Math.min(W * 0.4, measure(svg, rows.map((r) => r.bank)) + 12);
    const endLab = (r) => money(Number(r.target)) + ' · ' + d3.format('+.0%')(Number(r.target) / spot - 1);
    const endW = measure(svg, rows.map(endLab), 'mt-tick') + 10;
    const lo = Math.min(spot, d3.min(rows, (r) => Number(r.target))) * 0.97;
    const hi = Math.max(spot, d3.max(rows, (r) => Number(r.target)));
    const x = d3.scaleLinear([lo, hi], [labW, W - endW]);
    svg.append('line').attr('x1', x(spot)).attr('x2', x(spot)).attr('y1', top - 6).attr('y2', H)
      .attr('stroke', 'var(--chart-reference)').attr('stroke-dasharray', '4 3');
    const todayLab = 'Today ' + money(spot);
    const tlw = measure(svg, [todayLab], 'mt-tick');
    svg.append('text').attr('class', 'mt-tick').attr('x', Math.max(tlw / 2, Math.min(W - tlw / 2, x(spot)))).attr('y', 12).attr('text-anchor', 'middle').text(todayLab);
    rows.forEach((r, i) => {
      const y = top + i * rowH + 12, t = Number(r.target);
      fitText(svg.append('text').attr('x', 0).attr('y', y + 4), r.bank, labW - 8);
      fitText(svg.append('text').attr('class', 'mt-tick').attr('x', 0).attr('y', y + 18), r.horizon + ' · ' + r.scenario, labW - 8);
      const c = t >= spot ? 'var(--color-ok)' : 'var(--color-bad)';
      svg.append('line').attr('x1', x(spot)).attr('x2', x(t)).attr('y1', y).attr('y2', y).attr('stroke', c).attr('stroke-width', 2).attr('stroke-linecap', 'round');
      svg.append('circle').attr('cx', x(t)).attr('cy', y).attr('r', 5).attr('fill', c);
      svg.append('text').attr('class', 'mt-tick').attr('x', x(t) + 9).attr('y', y + 4).text(endLab(r));
    });
  });

  dash.draw('sig-rows', (el) => {
    el.replaceChildren();
    const d = dash.data('signals');
    if (d.status !== 'ok') return;
    d.data.forEach((s) => {
      const tr = document.createElement('tr');
      const cell = (txt, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = txt; tr.appendChild(td); return td; };
      cell(s.pillar);
      const ind = cell(s.indicator);
      const tag = document.createElement('span'); tag.className = 'mt-tag'; tag.textContent = s.mode === 'auto' ? 'auto' : 'manual';
      ind.appendChild(tag);
      cell(s.reading, 'mt-hide-narrow');
      cell(fmtDate(s.as_of));
      const sc = cell(d3.format('+d')(Number(s.score)), 'mt-num');
      sc.style.color = signedCol(Number(s.score));
      const src = document.createElement('td'); src.className = 'mt-hide-narrow';
      if (typeof s.url === 'string' && s.url.startsWith('https://')) {
        const a = document.createElement('a'); a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = s.source;
        src.appendChild(a);
      } else { src.textContent = s.source; }
      tr.appendChild(src);
      el.appendChild(tr);
    });
  });
})();
