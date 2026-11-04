// Minimal data runtime for the Metals Signal Tracker.
// Loads the JSON files in /data, runs calculations, and redraws every
// element marked data-draw="name" whenever data, filters or width change.
(() => {
  const FILES = {
    signals: 'data/signals.json',
    prices: 'data/prices.json',
    cb_flows: 'data/cb_flows.json',
    cb_summary: 'data/cb_summary.json',
    bank_targets: 'data/bank_targets.json',
  };
  const DEFAULT_PARAMS = { asset: 'Gold' };

  const store = {};
  const calcs = {};
  const draws = {};
  const listeners = [];
  let params = { ...DEFAULT_PARAMS };
  let started = false;
  let queued = false;

  const rowsOf = (json) => (Array.isArray(json) ? json : json && (json.rows || json.data || json.results)) || [];

  function load(id, fresh) {
    const prev = store[id];
    store[id] = prev && prev.status === 'ok'
      ? { ...prev, refreshing: true }
      : { status: 'loading', data: [], refreshing: false };
    schedule();
    const url = FILES[id] + (fresh ? '?t=' + Date.now() : '');
    return fetch(url, { cache: fresh ? 'no-store' : 'default' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((json) => { store[id] = { status: 'ok', data: rowsOf(json), refreshing: false }; })
      .catch((e) => { store[id] = { status: 'error', data: [], refreshing: false, message: String(e.message || e) }; })
      .finally(schedule);
  }

  function data(id) {
    if (calcs[id]) {
      const c = calcs[id];
      const ins = c.inputs.map((i) => data(i));
      const bad = ins.find((x) => x.status !== 'ok');
      if (bad) return { status: bad.status, data: [], refreshing: false };
      try {
        return { status: 'ok', data: c.fn(...ins.map((x) => x.data)), refreshing: ins.some((x) => x.refreshing) };
      } catch (e) {
        console.error('Calculation ' + id + ' failed', e);
        return { status: 'error', data: [], refreshing: false };
      }
    }
    if (!store[id] && FILES[id]) load(id);
    return store[id] || { status: 'missing', data: [], refreshing: false };
  }

  function render() {
    queued = false;
    if (!started) return;
    listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    Object.entries(draws).forEach(([name, fn]) => {
      document.querySelectorAll('[data-draw="' + name + '"]').forEach((el) => {
        try { fn(el); } catch (e) { console.error('Drawing ' + name + ' failed', e); el.textContent = '—'; }
      });
    });
  }
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(render);
  }

  window.dash = {
    data,
    calc: (id, def) => { calcs[id] = def; },
    draw: (name, fn) => { draws[name] = fn; schedule(); },
    onData: (fn) => { listeners.push(fn); schedule(); },
    params: () => ({ ...params }),
    setParams: (p) => { params = { ...params, ...p }; schedule(); },
    resetParams: () => { params = { ...DEFAULT_PARAMS }; schedule(); },
    refresh: (id) => load(id, true),
    refreshAll: () => Promise.all(Object.keys(FILES).map((id) => load(id, true))),
    sources: Object.keys(FILES),
  };

  const start = () => {
    started = true;
    Object.keys(FILES).forEach((id) => load(id));
    let w = window.innerWidth;
    window.addEventListener('resize', () => {
      if (window.innerWidth !== w) { w = window.innerWidth; schedule(); }
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
