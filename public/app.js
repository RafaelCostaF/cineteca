'use strict';
/* Cineteca front-end: one page app used by the desktop window and by every
   phone, tablet and TV browser on the network. */

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const CATS = ['Movies', 'Series', 'Anime', 'Books'];
let cleanup = [];          // functions to run when leaving the current view
let info = null;           // /api/info

// ------------------------------------------------------------ helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}) } };
  if (opts.json !== undefined) {
    init.body = JSON.stringify(opts.json);
    init.headers['Content-Type'] = 'application/json';
    init.method ||= 'POST';
  }
  const res = await fetch(path, init);
  if (res.status === 401) { location.href = '/login'; throw new Error('PIN required'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

const fmtBytes = n => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
};
const fmtTime = s => {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
  return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : `${mm}`) + `:${String(ss).padStart(2, '0')}`;
};
const fmtEta = s => (s >= 8640000 || s < 0 ? '∞' : s > 3600 ? `${Math.round(s / 3600)} h` : s > 60 ? `${Math.round(s / 60)} min` : `${s} s`);
const pct = v => `${Math.floor((v || 0) * 100)}%`;

function toast(message, ms = 3500) {
  const el = h('div', { class: 'toast', role: 'status' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

function confirmDialog(title, text, okLabel = 'Delete') {
  const dlg = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  return new Promise(resolve => {
    const done = v => { dlg.close(); resolve(v); };
    $('#confirm-ok').onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
    $('#confirm-cancel').focus();
  });
}

function every(ms, fn) {
  fn();
  const id = setInterval(() => { if (!document.hidden) fn(); }, ms);
  cleanup.push(() => clearInterval(id));
}

function stateLabel(t) {
  if (t.stopped) return t.done ? 'Ready' : 'Paused';
  if (t.done) return 'Ready';
  if (/metaDL/i.test(t.state)) return 'Fetching info…';
  if (/stalled/i.test(t.state)) return `Waiting for peers · ${pct(t.progress)}`;
  if (/queued/i.test(t.state)) return 'Queued';
  if (/checking/i.test(t.state)) return 'Checking…';
  if (/error|missing/i.test(t.state)) return 'Error';
  return `${pct(t.progress)} · ${fmtBytes(t.dlspeed)}/s · ${fmtEta(t.eta)} left`;
}

function cover(src, title, extra) {
  const box = h('div', { class: 'cover' }, h('div', { class: 'placeholder' }, title));
  if (src) {
    const img = h('img', { src, alt: '', loading: 'lazy' });
    img.onerror = () => img.remove();
    box.append(img);
  }
  if (extra) box.append(...[].concat(extra));
  return box;
}

const bar = (value, cls = '') => h('div', { class: `bar ${cls}` }, h('span', { style: `width:${Math.min(100, (value || 0) * 100)}%` }));

// ------------------------------------------------------------ views

async function homeView() {
  view.replaceChildren(h('h1', {}, 'Welcome back'));
  const contRow = h('div', { class: 'grid wide' });
  const dlRow = h('div', { class: 'grid' });
  const recent = h('div', { class: 'grid' });
  const contSec = h('section', {}, h('h2', {}, 'Continue watching & reading'), contRow);
  const dlSec = h('section', {}, h('h2', {}, 'Downloading now'), dlRow);
  view.append(contSec, dlSec, h('h2', {}, 'Recently added'), recent);

  api('/api/continue').then(({ items }) => {
    if (!items.length) return contSec.remove();
    contRow.replaceChildren(...items.map(p => {
      const book = p.kind === 'book';
      const href = book ? `#/read/${p.hash}/${p.index}` : `#/watch/${p.hash}/${p.index}`;
      const progress = book ? p.percent : p.position / (p.duration || 1);
      const img = book ? p.cover : `/api/thumb/${p.hash}/${p.index}`;
      return h('a', { class: 'card', href },
        cover(img, p.title, bar(progress)),
        h('div', { class: 'body' },
          h('div', { class: 'title' }, p.title),
          h('div', { class: 'meta' }, book ? `${pct(p.percent)} read` : `${fmtTime(p.position)} of ${fmtTime(p.duration)}`)));
    }));
  }).catch(() => contSec.remove());

  every(3000, async () => {
    const { torrents } = await api('/api/torrents');
    const active = torrents.filter(t => !t.done && !t.stopped);
    dlSec.classList.toggle('hidden', !active.length);
    dlRow.replaceChildren(...active.map(torrentCard));
    if (!recent.childElementCount || recent.dataset.n !== String(torrents.length)) {
      recent.dataset.n = torrents.length;
      recent.replaceChildren(...(torrents.length ? torrents.slice(0, 12).map(torrentCard)
        : [h('div', { class: 'empty', style: 'grid-column:1/-1' }, 'Your library is empty. ',
          h('a', { href: '#/discover' }, 'Discover something to download'), '.')]));
    }
  });
}

function torrentCard(t) {
  return h('a', { class: 'card', href: `#/item/${t.hash}` },
    cover(t.cover, t.title, [
      t.done ? h('span', { class: 'badge ok' }, t.category) : h('span', { class: 'badge' }, t.category),
      t.done ? null : bar(t.progress, 'dl'),
    ]),
    h('div', { class: 'body' },
      h('div', { class: 'title' }, t.title),
      h('div', { class: 'meta' }, stateLabel(t))));
}

async function discoverView(params) {
  const cat = CATS.includes(params.get('cat')) ? params.get('cat') : 'Movies';
  const q = params.get('q') || '';
  const curated = params.get('all') !== '1';
  let page = 1;
  const input = h('input', { type: 'search', class: 'grow', placeholder: `Search ${cat.toLowerCase()}…`, value: q, 'aria-label': 'Search' });
  const status = h('div', { class: 'status' });
  const grid = h('div', { class: 'grid' });
  const more = h('button', { class: 'btn hidden', onclick: () => load(page + 1) }, 'Load more');
  const curatedBox = h('input', { type: 'checkbox', id: 'curated', checked: curated, onchange: () => go(cat, input.value, curatedBox.checked) });

  const go = (c, query, cur = curated) => {
    location.hash = `#/discover?${new URLSearchParams({ cat: c, q: query, ...(cur ? {} : { all: '1' }) })}`;
  };
  view.replaceChildren(
    h('h1', {}, 'Discover'),
    h('div', { class: 'chips' }, CATS.map(c => h('button', { class: `chip ${c === cat ? 'active' : ''}`, onclick: () => go(c, input.value) }, c))),
    h('form', { class: 'row', onsubmit: e => { e.preventDefault(); go(cat, input.value); } }, input, h('button', { class: 'btn primary' }, 'Search')),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('label', { class: 'row', for: 'curated' }, curatedBox, h('strong', {}, 'Curated')),
      h('span', { class: 'muted' }, curated
        ? 'Only staff-maintained collections (Feature Films, Film Noir, Classic TV, Animation, Project Gutenberg…), no trailers or clips, duplicate copies merged.'
        : 'Everything uploaded to the Internet Archive. Expect duplicates and low-quality uploads.')),
    status, grid, h('div', { class: 'row', style: 'justify-content:center;margin-top:18px' }, more),
    addOwnTorrent(cat),
  );

  async function load(p) {
    status.textContent = q ? 'Searching…' : `Loading the most watched ${cat.toLowerCase()}…`;
    more.classList.add('hidden');
    try {
      const data = await api(`/api/search?${new URLSearchParams({ q, category: cat, page: p, curated: curated ? '1' : '0' })}`);
      page = p;
      if (p === 1) grid.replaceChildren();
      status.textContent = grid.childElementCount + data.items.length
        ? (q ? `Results for “${q}”` : `Most watched ${cat.toLowerCase()}`)
        : (curated ? 'Nothing found in the curated collections. Try other words or untick Curated.' : 'Nothing found. Try other words.');
      grid.append(...data.items.map(resultCard));
      more.classList.toggle('hidden', !data.more);
    } catch (e) {
      status.textContent = `Could not search: ${e.message}`;
    }
  }
  load(1);
  if (!q) input.focus();
}

function resultCard(item) {
  const isVideo = item.category !== 'Books';
  const actions = h('div', { class: 'actions' });
  let chosen = item.versions[0];
  const versionSel = item.versions.length > 1 ? h('select', {
    'aria-label': 'Version', title: 'Several copies of this title exist; the most watched is selected',
    style: 'width:100%;padding:6px 8px;font-size:13px',
    onchange: () => { chosen = item.versions[versionSel.selectedIndex]; },
  }, item.versions.map((v, i) => h('option', { value: v.id }, `${i === 0 ? 'Best: ' : ''}${v.label}`))) : null;
  const add = async (stream, btn) => {
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      const { hash } = await api('/api/torrents', { json: {
        archiveId: chosen.id, title: item.title, category: item.category, stream,
        cover: `https://archive.org/services/img/${encodeURIComponent(chosen.id)}`,
        page: `https://archive.org/details/${encodeURIComponent(chosen.id)}`,
      } });
      item.hash = hash;
      if (stream) location.hash = `#/item/${hash}`;
      else { toast(`“${item.title}” is downloading`); render(); }
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  };
  const render = () => {
    actions.replaceChildren(...(item.hash
      ? [h('a', { class: 'btn', href: `#/item/${item.hash}` }, 'In library')]
      : [h('button', { class: 'btn primary', onclick: e => add(false, e.currentTarget) }, 'Download'),
        isVideo ? h('button', { class: 'btn', title: 'Download in order so you can start watching right away', onclick: e => add(true, e.currentTarget) }, '▶ Stream') : null]
    ).filter(Boolean));
  };
  render();
  const runtime = item.runtime ? (item.runtime >= 60 ? `${Math.floor(item.runtime / 60)} h ${item.runtime % 60} min` : `${item.runtime} min`) : '';
  return h('div', { class: 'card' },
    cover(item.cover, item.title),
    h('div', { class: 'body' },
      h('div', { class: 'title', title: item.description || item.title }, item.title),
      h('div', { class: 'meta' }, [item.year, runtime, item.category === 'Books' ? item.creator : ''].filter(Boolean).join(' · ')),
      h('div', { class: 'meta' }, [item.downloads ? `${Number(item.downloads).toLocaleString()} views` : '', item.size ? fmtBytes(item.size) : ''].filter(Boolean).join(' · ')),
      h('a', { class: 'meta', href: item.page, target: '_blank', rel: 'noopener' }, 'Details ↗'),
      versionSel,
      actions));
}

function addOwnTorrent(defaultCat) {
  const link = h('input', { type: 'text', class: 'grow', placeholder: 'magnet:?xt=… or https://…/file.torrent', 'aria-label': 'Magnet link or torrent URL' });
  const cat = h('select', { 'aria-label': 'Category' }, [...CATS, 'Other'].map(c => h('option', { value: c, selected: c === defaultCat }, c)));
  const stream = h('input', { type: 'checkbox', id: 'own-stream' });
  const file = h('input', { type: 'file', accept: '.torrent,application/x-bittorrent', class: 'hidden' });
  const done = hash => { toast('Torrent added'); location.hash = `#/item/${hash}`; };
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try {
      const qs = new URLSearchParams({ category: cat.value, stream: stream.checked ? '1' : '0', title: file.files[0].name.replace(/\.torrent$/i, '') });
      done((await api(`/api/torrents/upload?${qs}`, { method: 'POST', body: file.files[0] })).hash);
    } catch (e) { toast(e.message); }
    file.value = '';
  });
  return h('section', { class: 'panel', style: 'margin-top:36px' },
    h('h2', { style: 'margin-top:0' }, 'Add your own torrent'),
    h('p', { class: 'muted' }, 'Paste a magnet link or a .torrent URL, or open a .torrent file. It is saved in the chosen category inside your cripto folder.'),
    h('form', { class: 'row', onsubmit: async e => {
      e.preventDefault();
      if (!link.value.trim()) return;
      try { done((await api('/api/torrents', { json: { link: link.value.trim(), category: cat.value, stream: stream.checked } })).hash); }
      catch (err) { toast(err.message); }
    } }, link, cat, h('button', { class: 'btn primary' }, 'Add')),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, 'Open .torrent file…'), file,
      h('label', { class: 'row', for: 'own-stream' }, stream, 'Download in order (watch while downloading)')));
}

async function libraryView(params) {
  const filters = ['All', ...CATS, 'Other'];
  const cat = filters.includes(params.get('cat')) ? params.get('cat') : 'All';
  const grid = h('div', { class: 'grid' });
  const search = h('input', { type: 'search', placeholder: 'Filter library…', class: 'grow', 'aria-label': 'Filter library', oninput: () => draw() });
  let torrents = [];
  view.replaceChildren(
    h('h1', {}, 'Library'),
    h('div', { class: 'chips' }, filters.map(c => h('a', { class: `chip ${c === cat ? 'active' : ''}`, href: `#/library?cat=${c}` }, c))),
    h('div', { class: 'row', style: 'margin-bottom:18px' }, search),
    grid);
  const draw = () => {
    const term = search.value.trim().toLowerCase();
    const list = torrents.filter(t => (cat === 'All' || t.category === cat) && (!term || t.title.toLowerCase().includes(term)));
    grid.replaceChildren(...(list.length ? list.map(torrentCard)
      : [h('div', { class: 'empty', style: 'grid-column:1/-1' }, 'Nothing here yet.')]));
  };
  every(3000, async () => {
    const focused = document.activeElement?.getAttribute('href');
    const next = (await api('/api/torrents')).torrents;
    const sig = JSON.stringify(next.map(t => [t.hash, t.title, t.category, Math.floor(t.progress * 100), t.state, Math.round(t.dlspeed / 100000)]));
    torrents = next;
    if (sig === grid.dataset.sig) return;
    grid.dataset.sig = sig;
    draw();
    if (focused) grid.querySelector(`[href="${CSS.escape(focused)}"]`)?.focus();
  });
}

async function itemView(hash) {
  let first = true;
  const head = h('div');
  const filesBox = h('div');
  view.replaceChildren(head, filesBox);

  every(3000, async () => {
    let data;
    try { data = await api(`/api/torrents/${hash}`); } catch (e) {
      view.replaceChildren(h('div', { class: 'empty' }, e.message, ' · ', h('a', { href: '#/library' }, 'Back to library')));
      cleanup.forEach(f => f()); cleanup = [];
      return;
    }
    const { torrent: t, files } = data;
    if (first) { drawHead(t); first = false; } else updateHead(t);
    const sig = JSON.stringify([t.sequential, files]);
    if (sig !== filesBox.dataset.sig) { filesBox.dataset.sig = sig; drawFiles(t, files); }
  });

  function drawHead(t) {
    const pause = h('button', { class: 'btn', id: 'pause' });
    const seq = h('input', { type: 'checkbox', id: 'seq' });
    const catSel = h('select', { 'aria-label': 'Category', onchange: async () => {
      await api(`/api/torrents/${hash}/category`, { json: { category: catSel.value } });
      toast(`Moved to ${catSel.value}`);
    } }, [...CATS, 'Other'].map(c => h('option', { value: c, selected: c === t.category }, c)));
    pause.onclick = async () => {
      await api(`/api/torrents/${hash}/${head.dataset.stopped === '1' ? 'start' : 'stop'}`, { method: 'POST' });
      toast(head.dataset.stopped === '1' ? 'Resumed' : 'Paused');
    };
    seq.onchange = () => api(`/api/torrents/${hash}/stream`, { json: { on: seq.checked } });
    const del = h('button', { class: 'btn danger', onclick: async () => {
      const ok = await confirmDialog(`Delete “${t.title}”?`,
        'The torrent and ALL of its downloaded files will be permanently removed from your cripto folder. Watch progress is forgotten too.');
      if (!ok) return;
      del.disabled = true;
      try {
        await api(`/api/torrents/${hash}`, { method: 'DELETE' });
        toast('Deleted, with all of its files');
        location.hash = '#/library';
      } catch (e) { toast(e.message); del.disabled = false; }
    } }, 'Delete with files');
    head.replaceChildren(h('div', { class: 'item-head' },
      cover(t.cover, t.title),
      h('div', {},
        h('a', { href: '#/library', class: 'muted' }, '← Library'),
        h('h1', {}, t.title),
        h('div', { class: 'facts', id: 'facts' }),
        h('div', { id: 'dlbar' }),
        h('div', { class: 'row', style: 'margin-top:16px' }, pause, catSel,
          h('label', { class: 'row', for: 'seq', title: 'Downloads pieces in order so videos can play before they finish' }, seq, 'Watch while downloading'),
          del),
        t.page ? h('p', {}, h('a', { href: t.page, target: '_blank', rel: 'noopener', class: 'muted' }, 'Source page ↗')) : null)));
    updateHead(t);
  }

  function updateHead(t) {
    head.dataset.stopped = t.stopped ? '1' : '0';
    $('#pause', head).textContent = t.stopped ? (t.done ? '▶ Resume sharing' : '▶ Resume download') : (t.done ? '❚❚ Stop sharing' : '❚❚ Pause');
    $('#seq', head).checked = t.sequential;
    $('#facts', head).replaceChildren(...[
      h('span', {}, stateLabel(t)), h('span', {}, fmtBytes(t.size)),
      t.done ? null : h('span', {}, `${t.seeds} seeds · ${t.peers} peers`)].filter(Boolean));
    $('#dlbar', head).replaceChildren(...(t.done ? [] : [bar(t.progress, 'dl')]));
  }

  function drawFiles(t, files) {
    const wanted = files.filter(f => f.priority > 0);
    const skipped = files.length - wanted.length;
    const videos = wanted.filter(f => f.kind === 'video');
    const books = wanted.filter(f => f.kind === 'book');
    const others = wanted.filter(f => !['video', 'book', 'subtitle'].includes(f.kind));
    const focused = document.activeElement?.dataset?.key;
    const sections = [];
    if (videos.length) {
      sections.push(h('h2', {}, videos.length > 1 ? `Episodes & videos (${videos.length})` : 'Watch'),
        h('div', { class: 'files' }, videos.map(f => videoRow(t, f))));
    }
    if (books.length) sections.push(h('h2', {}, 'Books'), h('div', { class: 'files' }, books.map(f => bookRow(t, f))));
    if (others.length) sections.push(h('h2', {}, 'Other files'), h('div', { class: 'files' }, others.map(f => otherRow(t, f))));
    if (!wanted.length) sections.push(h('div', { class: 'empty', style: 'margin-top:24px' }, 'Waiting for the file list…'));
    if (skipped) sections.push(h('p', { class: 'muted' }, `${skipped} extra file(s) from the source were skipped to save space.`));
    filesBox.replaceChildren(...sections);
    if (focused) filesBox.querySelector(`[data-key="${focused}"]`)?.focus();
  }

  function videoRow(t, f) {
    const w = f.watch;
    const watchedPct = w && w.duration ? w.position / w.duration : 0;
    const playable = f.progress >= 1 || (t.sequential && f.progress > 0.03);
    const label = w?.finished ? '↻ Watch again' : w && w.position > 20 ? `▶ Resume ${fmtTime(w.position)}` : '▶ Play';
    const thumb = h('div', { class: 'thumb' });
    if (f.progress > 0.05) {
      const img = h('img', { src: `/api/thumb/${t.hash}/${f.index}`, alt: '', loading: 'lazy' });
      img.onerror = () => img.remove();
      thumb.append(img);
    }
    if (watchedPct) thumb.append(bar(watchedPct));
    return h('div', { class: 'file' }, thumb,
      h('div', {},
        h('div', { class: 'name' }, f.base),
        h('div', { class: 'sub' }, [fmtBytes(f.size), f.progress < 1 ? `${pct(f.progress)} downloaded` : null,
          w?.finished ? 'Watched' : null].filter(Boolean).join(' · '))),
      h('div', { class: 'acts' },
        playable ? h('a', { class: 'btn primary', href: `#/watch/${t.hash}/${f.index}`, 'data-key': `p${f.index}` }, label)
          : h('span', { class: 'muted' }, t.sequential ? 'Buffering…' : 'Downloading…'),
        f.progress >= 1 ? h('a', { class: 'btn', href: `/media/${t.hash}/${f.index}/${encodeURIComponent(f.base)}?download=1`, 'data-key': `d${f.index}` }, 'Save') : null));
  }

  function bookRow(t, f) {
    const w = f.watch;
    const epub = /\.epub$/i.test(f.name);
    const url = `/media/${t.hash}/${f.index}/${encodeURIComponent(f.base)}`;
    return h('div', { class: 'file simple' },
      h('div', {}, h('div', { class: 'name' }, f.base),
        h('div', { class: 'sub' }, [fmtBytes(f.size), f.progress < 1 ? `${pct(f.progress)} downloaded` : null,
          w ? `${pct(w.percent)} read` : null].filter(Boolean).join(' · '))),
      f.progress < 1 ? h('span', { class: 'muted' }, 'Downloading…') : h('div', { class: 'acts' },
        epub ? h('a', { class: 'btn primary', href: `#/read/${t.hash}/${f.index}`, 'data-key': `r${f.index}` }, w ? 'Continue reading' : 'Read')
          : h('a', { class: 'btn primary', href: url, target: '_blank', 'data-key': `o${f.index}` }, 'Open'),
        h('a', { class: 'btn', href: `${url}?download=1`, 'data-key': `d${f.index}` }, 'Save to device')));
  }

  function otherRow(t, f) {
    return h('div', { class: 'file simple' },
      h('div', {}, h('div', { class: 'name' }, f.name), h('div', { class: 'sub' }, `${fmtBytes(f.size)} · ${pct(f.progress)}`)),
      f.progress >= 1 ? h('div', { class: 'acts' }, h('a', { class: 'btn', href: `/media/${t.hash}/${f.index}/${encodeURIComponent(f.base)}?download=1`, 'data-key': `d${f.index}` }, 'Save')) : null);
  }
}

// ------------------------------------------------------------ player

const isAppleSafari = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent)
  && !/Chrome|Chromium|Edg|Firefox/.test(navigator.userAgent);
const clientId = (() => {
  try {
    let id = localStorage.getItem('cineteca-client');
    if (!id) { id = Math.random().toString(36).slice(2); localStorage.setItem('cineteca-client', id); }
    return id;
  } catch { return Math.random().toString(36).slice(2); }
})();

async function watchView(hash, index) {
  document.body.style.overflow = 'hidden';
  const video = h('video', { playsinline: true, autoplay: true, preload: 'auto' });
  const spinner = h('div', { class: 'spinner' });
  const seek = h('input', { type: 'range', class: 'seek', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Seek' });
  const time = h('span', { class: 'time' }, '0:00');
  const playBtn = h('button', { class: 'icon', 'aria-label': 'Play/pause' }, '❚❚');
  const back10 = h('button', { class: 'icon', 'aria-label': 'Back 10 seconds' }, '↺');
  const fwd30 = h('button', { class: 'icon', 'aria-label': 'Forward 30 seconds' }, '↻');
  const fullBtn = h('button', { class: 'icon', 'aria-label': 'Fullscreen' }, '⛶');
  const subSel = h('select', { 'aria-label': 'Subtitles' });
  const audioSel = h('select', { 'aria-label': 'Audio track', class: 'hidden' });
  const modeSel = h('select', { 'aria-label': 'Playback mode', title: 'Use “Compatible” if the video does not play' },
    h('option', { value: 'auto' }, 'Auto'), h('option', { value: 'direct' }, 'Original file'),
    h('option', { value: 'transcode' }, 'Compatible (convert)'));
  const title = h('div', { class: 't' });
  const subtitle = h('div', { class: 's' });
  const backBtn = h('a', { class: 'icon', href: `#/item/${hash}`, 'aria-label': 'Back' }, '←');
  const overlay = h('div', { class: 'overlay' },
    h('div', { class: 'top' }, backBtn, h('div', {}, title, subtitle)),
    h('div', { class: 'bottom' }, seek,
      h('div', { class: 'ctrls' }, playBtn, back10, fwd30, time, audioSel, subSel, modeSel, fullBtn)));
  const root = h('div', { class: 'player' }, video, spinner, overlay);
  view.replaceChildren(root);

  let meta;
  try { meta = await api(`/api/probe/${hash}/${index}`); } catch (e) {
    root.replaceChildren(h('div', { class: 'empty' }, e.message, ' · ', h('a', { href: `#/item/${hash}` }, 'Back')));
    return;
  }
  title.textContent = meta.title;
  subtitle.textContent = meta.title !== meta.show ? meta.show : '';
  document.title = `${meta.title} · Cineteca`;

  const s = { mode: meta.mode, offset: 0, audio: 0, duration: meta.duration, sub: null, saved: 0 };
  const now = () => s.offset + (video.currentTime || 0);
  const total = () => s.duration || (Number.isFinite(video.duration) ? video.duration : 0);

  if (meta.audio.length > 1) {
    audioSel.classList.remove('hidden');
    audioSel.append(...meta.audio.map(a => h('option', { value: a.index },
      `Audio: ${[a.language, a.title, a.codec].filter(Boolean).join(' · ') || `track ${a.index + 1}`}`)));
  }
  subSel.append(h('option', { value: '' }, 'Subtitles: off'),
    ...meta.subtitles.filter(x => x.text).map(x => h('option', { value: `s${x.index}` }, `Subs: ${[x.language, x.title].filter(Boolean).join(' · ') || `track ${x.index + 1}`}`)),
    ...meta.sidecars.map(x => h('option', { value: `f${x.index}` }, `Subs: ${x.name}`)));
  if (subSel.options.length === 1) subSel.classList.add('hidden');

  async function load(at) {
    spinner.classList.remove('hidden');
    const mode = s.mode;
    if (mode === 'direct') {
      s.offset = 0;
      if (!video.src.endsWith(meta.url)) video.src = meta.url;
      video.currentTime = at;
    } else if (isAppleSafari) {
      s.offset = at;
      const qs = new URLSearchParams({ mode, start: at.toFixed(2), audio: s.audio, client: clientId });
      const { url } = await api(`/api/hls/${hash}/${index}?${qs}`, { method: 'POST' });
      video.src = url;
    } else {
      s.offset = at;
      video.src = `/api/stream/${hash}/${index}?${new URLSearchParams({ mode, start: at.toFixed(2), audio: s.audio })}`;
    }
    video.play().catch(() => {});
    applySubs();
  }

  function seekTo(t) {
    t = Math.max(0, Math.min(total() ? total() - 1 : t, t));
    if (s.mode === 'direct') video.currentTime = t;
    else load(t);
    update();
  }

  video.addEventListener('error', () => {
    // The device cannot decode the original: fall back to conversion.
    if (s.mode !== 'transcode' && modeSel.value === 'auto') {
      const at = now();
      s.mode = s.mode === 'direct' && meta.video?.codec === 'h264' ? 'remux' : 'transcode';
      toast('Switching to compatible playback…');
      load(at);
    } else {
      spinner.classList.add('hidden');
      toast('This video cannot be played. Try “Compatible” mode.');
    }
  });
  video.addEventListener('waiting', () => spinner.classList.remove('hidden'));
  video.addEventListener('playing', () => spinner.classList.add('hidden'));
  video.addEventListener('canplay', () => spinner.classList.add('hidden'));
  video.addEventListener('play', () => { playBtn.textContent = '❚❚'; });
  video.addEventListener('pause', () => { playBtn.textContent = '▶'; save(); wake(); });
  video.addEventListener('timeupdate', () => {
    update();
    if (Date.now() - s.saved > 5000) save();
  });
  video.addEventListener('ended', () => { save(true); showNext(); });

  let dragging = false;
  seek.addEventListener('input', () => { dragging = true; time.textContent = `${fmtTime(seek.value / 1000 * total())} / ${fmtTime(total())}`; });
  seek.addEventListener('change', () => { dragging = false; seekTo(seek.value / 1000 * total()); });
  function update() {
    if (!dragging && total()) seek.value = Math.round(now() / total() * 1000);
    time.textContent = `${fmtTime(now())} / ${fmtTime(total())}`;
  }

  playBtn.onclick = () => (video.paused ? video.play() : video.pause());
  back10.onclick = () => seekTo(now() - 10);
  fwd30.onclick = () => seekTo(now() + 30);
  fullBtn.onclick = toggleFull;
  video.addEventListener('click', () => (video.paused ? video.play() : video.pause()));
  video.addEventListener('dblclick', toggleFull);
  audioSel.onchange = () => {
    s.audio = Number(audioSel.value);
    if (s.mode === 'direct') s.mode = meta.video?.codec === 'h264' ? 'remux' : 'transcode';
    load(now());
  };
  modeSel.onchange = () => {
    s.mode = modeSel.value === 'auto' ? meta.mode : modeSel.value;
    load(now());
  };
  subSel.onchange = () => { s.sub = subSel.value || null; s.subText = null; applySubs(); };

  async function applySubs() {
    video.querySelectorAll('track').forEach(t => { URL.revokeObjectURL(t.src); t.remove(); });
    if (!s.sub) return;
    if (!s.subText) {
      const url = s.sub[0] === 's' ? `/api/subs/${hash}/${index}?stream=${s.sub.slice(1)}` : `/api/subs/${hash}/${s.sub.slice(1)}`;
      s.subText = await (await fetch(url)).text();
    }
    const vtt = shiftVtt(s.subText, s.offset);
    const track = h('track', { kind: 'subtitles', default: true, src: URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })) });
    video.append(track);
    track.track.mode = 'showing';
  }

  // Resume from where this was left on any device.
  const w = meta.watch;
  let start = 0;
  if (w && !w.finished && w.position > 20 && (!w.duration || w.position < w.duration * 0.95)) {
    start = w.position - 3;
    const box = h('div', { class: 'toast' }, `Resumed at ${fmtTime(w.position)}`,
      h('button', { class: 'btn small', onclick: () => { seekTo(0); box.remove(); } }, 'Start over'));
    root.append(box);
    setTimeout(() => box.remove(), 8000);
  }
  load(start);

  function save(finished = false) {
    if (!total()) return;
    s.saved = Date.now();
    const body = { position: finished ? total() : now(), duration: total(), name: meta.name, kind: 'video' };
    fetch(`/api/progress/${hash}/${index}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  }
  const beacon = () => {
    if (!total()) return;
    navigator.sendBeacon?.(`/api/progress/${hash}/${index}`, JSON.stringify({ position: now(), duration: total(), name: meta.name, kind: 'video' }));
  };
  window.addEventListener('pagehide', beacon);

  function showNext() {
    if (!meta.next) return;
    let n = 10;
    const label = h('span', {}, `in ${n}s`);
    const go = () => { location.hash = `#/watch/${hash}/${meta.next.index}`; };
    const card = h('div', { class: 'next-up' }, h('div', { class: 'muted' }, 'Up next'),
      h('div', { style: 'font-weight:700;margin:6px 0 12px' }, meta.next.name),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: go }, 'Play now ', label),
        h('button', { class: 'btn', onclick: () => { clearInterval(timer); card.remove(); } }, 'Cancel')));
    root.append(card);
    card.querySelector('button').focus();
    const timer = setInterval(() => { n--; label.textContent = `in ${n}s`; if (n <= 0) { clearInterval(timer); go(); } }, 1000);
    cleanup.push(() => clearInterval(timer));
  }

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else video.webkitEnterFullscreen?.();
  }

  // Auto-hide controls; keyboard and TV remote shortcuts.
  let idleTimer;
  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused) root.classList.add('idle'); }, 3500);
  }
  root.addEventListener('mousemove', wake);
  root.addEventListener('touchstart', wake, { passive: true });
  wake();

  const onKey = e => {
    if (e.target.tagName === 'SELECT') return;
    const hidden = root.classList.contains('idle');
    const key = e.key;
    if (key === ' ' || key === 'k' || key === 'MediaPlayPause' || (key === 'Enter' && hidden)) {
      e.preventDefault(); video.paused ? video.play() : video.pause();
    } else if ((key === 'ArrowLeft' && (hidden || e.target === seek)) || key === 'j' || key === 'MediaRewind') {
      e.preventDefault(); seekTo(now() - 10);
    } else if ((key === 'ArrowRight' && (hidden || e.target === seek)) || key === 'l' || key === 'MediaFastForward') {
      e.preventDefault(); seekTo(now() + 30);
    } else if (key === 'f') toggleFull();
    else if (key === 'm') video.muted = !video.muted;
    else if (key === 'Escape' || key === 'Backspace' || key === 'GoBack') {
      if (document.fullscreenElement) return;
      if (!hidden && !video.paused) { root.classList.add('idle'); return; }
      location.hash = `#/item/${hash}`;
    } else if (hidden && (key === 'ArrowUp' || key === 'ArrowDown')) {
      e.preventDefault(); wake(); playBtn.focus();
      return;
    }
    wake();
  };
  document.addEventListener('keydown', onKey, true);

  cleanup.push(() => {
    save();
    window.removeEventListener('pagehide', beacon);
    document.removeEventListener('keydown', onKey, true);
    clearTimeout(idleTimer);
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.body.style.overflow = '';
    document.title = 'Cineteca';
  });
}

function shiftVtt(text, offset) {
  if (!offset) return text;
  const parse = t => { const p = t.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const out = s => { s = Math.max(0, s); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${(s % 60).toFixed(3).padStart(6, '0')}`; };
  return text.split(/\r?\n\r?\n/).map(block => {
    const lines = block.split(/\r?\n/);
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) return block;
    const [a, rest] = lines[i].split('-->');
    const [b, ...settings] = rest.trim().split(/\s+/);
    const end = parse(b) - offset;
    if (end <= 0) return '';
    lines[i] = `${out(parse(a) - offset)} --> ${out(end)} ${settings.join(' ')}`.trim();
    return lines.join('\n');
  }).filter(Boolean).join('\n\n');
}

// ------------------------------------------------------------ reader

let epubReady = null;
function loadEpubLib() {
  const load = src => new Promise((res, rej) => document.head.append(h('script', { src, onload: res, onerror: rej })));
  epubReady ||= load('/vendor/jszip.min.js').then(() => load('/vendor/epub.min.js'));
  return epubReady;
}

async function readView(hash, index) {
  document.body.style.overflow = 'hidden';
  let dark = false, size = 100;
  try { dark = localStorage.getItem('reader-dark') === '1'; size = Number(localStorage.getItem('reader-size')) || 100; } catch { /* private mode */ }
  const titleEl = h('div', { class: 't' }, 'Loading…');
  const pctEl = h('span', { class: 'muted' });
  const bookEl = h('div', { id: 'book' });
  const toc = h('nav', { class: 'toc hidden' });
  const root = h('div', { class: `reader ${dark ? 'dark' : ''}` },
    h('div', { class: 'rbar' },
      h('a', { class: 'btn small', href: `#/item/${hash}` }, '←'),
      titleEl, pctEl,
      h('button', { class: 'btn small', onclick: () => toc.classList.toggle('hidden') }, 'Contents'),
      h('button', { class: 'btn small', onclick: () => font(-10) }, 'A−'),
      h('button', { class: 'btn small', onclick: () => font(10) }, 'A+'),
      h('button', { class: 'btn small', onclick: () => theme() }, '◐')),
    h('div', { class: 'stage' }, toc, bookEl,
      h('button', { class: 'turn prev', 'aria-label': 'Previous page', onclick: () => rendition?.prev() }, '‹'),
      h('button', { class: 'turn next', 'aria-label': 'Next page', onclick: () => rendition?.next() }, '›')));
  view.replaceChildren(root);

  let rendition, book;
  let meta;
  try {
    [meta] = await Promise.all([api(`/api/torrents/${hash}`), loadEpubLib()]);
  } catch (e) {
    titleEl.textContent = e.message;
    return;
  }
  const file = meta.files.find(f => f.index === Number(index));
  if (!file) { titleEl.textContent = 'Book not found'; return; }
  titleEl.textContent = meta.torrent.title;
  book = window.ePub(`/media/${hash}/${index}/${encodeURIComponent(file.base)}`, { openAs: 'epub' });
  rendition = book.renderTo(bookEl, { width: '100%', height: '100%', flow: 'paginated', spread: 'auto' });
  const applyTheme = () => {
    rendition.themes.override('color', dark ? '#ddd' : '#222');
    rendition.themes.override('background', dark ? '#15171c' : '#f4efe6');
    rendition.themes.fontSize(`${size}%`);
  };
  const font = d => { size = Math.min(200, Math.max(60, size + d)); try { localStorage.setItem('reader-size', size); } catch { /* ignore */ } applyTheme(); };
  const theme = () => { dark = !dark; root.classList.toggle('dark', dark); try { localStorage.setItem('reader-dark', dark ? '1' : '0'); } catch { /* ignore */ } applyTheme(); };
  applyTheme();

  book.loaded.navigation.then(nav => {
    toc.replaceChildren(...nav.toc.map(item => h('a', { href: '#', onclick: e => { e.preventDefault(); rendition.display(item.href); toc.classList.add('hidden'); } }, item.label.trim())));
  });
  book.ready.then(() => book.locations.generate(1200)).then(() => {
    const loc = rendition.currentLocation();
    if (loc?.start) pctEl.textContent = pct(book.locations.percentageFromCfi(loc.start.cfi));
  });

  const saved = meta.files.find(f => f.index === Number(index))?.watch;
  rendition.display(saved?.cfi || undefined);
  rendition.on('relocated', loc => {
    const percent = book.locations.length() ? book.locations.percentageFromCfi(loc.start.cfi) : (saved?.percent || 0);
    pctEl.textContent = pct(percent);
    fetch(`/api/progress/${hash}/${index}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cfi: loc.start.cfi, percent, name: meta.torrent.title, kind: 'book' }) }).catch(() => {});
  });
  const onKey = e => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); rendition.next(); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); rendition.prev(); }
    if (e.key === 'Escape') location.hash = `#/item/${hash}`;
  };
  document.addEventListener('keydown', onKey, true);
  rendition.on('keydown', onKey);
  let touchX = null;
  rendition.on('touchstart', e => { touchX = e.changedTouches[0].screenX; });
  rendition.on('touchend', e => {
    const dx = e.changedTouches[0].screenX - touchX;
    if (Math.abs(dx) > 50) (dx < 0 ? rendition.next() : rendition.prev());
  });
  cleanup.push(() => {
    document.removeEventListener('keydown', onKey, true);
    book?.destroy();
    document.body.style.overflow = '';
  });
}

// ------------------------------------------------------------ settings

async function settingsView() {
  info = await api('/api/info');
  const s = info.settings;
  const qb = info.qbit;
  const urls = info.urls.length ? info.urls : [{ name: 'local', url: location.origin }];
  const pin = h('input', { type: 'password', inputmode: 'numeric', placeholder: s.hasPin ? 'PIN is set; type a new one' : '4–12 digits', 'aria-label': 'Access PIN' });
  const dlnaBox = h('input', { type: 'checkbox', id: 'dlna', checked: s.dlna });
  const nameIn = h('input', { type: 'text', value: s.serverName, 'aria-label': 'Server name' });
  const rootIn = h('input', { type: 'text', value: info.mediaRoot, class: 'grow', 'aria-label': 'Cripto folder' });
  const saveSettings = async body => {
    try {
      const r = await api('/api/settings', { method: 'PUT', json: body });
      toast(r.restartRequired ? 'Saved. Restart Cineteca to apply.' : 'Saved');
      settingsView();
    } catch (e) { toast(e.message); }
  };
  const local = info.local;
  view.replaceChildren(
    h('h1', {}, 'Devices & Settings'),
    h('section', { class: 'panel connect' },
      h('div', { class: 'qr', html: info.qr }),
      h('div', {},
        h('h2', { style: 'margin-top:0' }, 'Watch on your phone, tablet or TV'),
        h('p', { class: 'muted' }, 'Connect the device to the same Wi-Fi or network, then scan the code or open this address in its browser:'),
        ...urls.map(u => h('div', { class: 'url' }, u.url)),
        h('p', { class: 'muted' }, s.dlna
          ? `Smart TVs, consoles and VLC also find the library on their own as the media server “${s.serverName}” (look for Sources, Media server or DLNA).`
          : 'DLNA is off, so TVs need to use their web browser.'))),
    h('div', { class: 'settings-grid', style: 'margin-top:18px' },
      h('section', { class: 'panel' },
        h('h3', {}, 'qBittorrent'),
        qb.running
          ? h('p', {}, `Running in the background (${qb.version}). Download ${fmtBytes(qb.transfer.dl_info_speed)}/s · upload ${fmtBytes(qb.transfer.up_info_speed)}/s.`)
          : h('p', { style: 'color:#ff8589' }, qb.error || 'Not running'),
        !qb.running ? h('p', {}, 'Install it from ', h('a', { href: 'https://www.qbittorrent.org/download', target: '_blank', rel: 'noopener' }, 'qbittorrent.org/download'), ' and restart Cineteca.') : null,
        h('p', { class: 'muted' }, 'Cineteca starts its own private qBittorrent and stops it when you quit.'),
        trackersPanel(info.trackers, local, saveSettings)),
      h('section', { class: 'panel' },
        h('h3', {}, 'Cripto folder'),
        h('p', { class: 'muted' }, 'Every download, the qBittorrent profile, thumbnails and watch progress are stored here.'),
        local ? h('form', { class: 'row', onsubmit: e => { e.preventDefault(); saveSettings({ mediaRoot: rootIn.value }); } }, rootIn, h('button', { class: 'btn' }, 'Change'))
          : h('code', {}, info.mediaRoot),
        info.disk ? h('p', {}, `${fmtBytes(info.disk.free)} free of ${fmtBytes(info.disk.total)}`) : null),
      h('section', { class: 'panel' },
        h('h3', {}, 'Access PIN'),
        h('p', { class: 'muted' }, s.hasPin ? 'Other devices must type the PIN once. This computer never needs it.'
          : 'Off: anyone on your network can open Cineteca. Set a PIN to require it on other devices.'),
        local ? h('form', { class: 'row', onsubmit: e => { e.preventDefault(); saveSettings({ accessPin: pin.value }); } },
          pin, h('button', { class: 'btn' }, 'Save PIN'),
          s.hasPin ? h('button', { class: 'btn danger', type: 'button', onclick: () => saveSettings({ accessPin: '' }) }, 'Remove') : null)
          : h('p', {}, 'Change this on the computer running Cineteca.')),
      local ? h('section', { class: 'panel' },
        h('h3', {}, 'TV media server (DLNA)'),
        h('label', { class: 'row', for: 'dlna' }, dlnaBox, 'Announce the library to smart TVs'),
        h('div', { class: 'row', style: 'margin-top:10px' }, nameIn,
          h('button', { class: 'btn', onclick: () => saveSettings({ dlna: dlnaBox.checked, serverName: nameIn.value }) }, 'Save'))) : null,
      window.cineteca ? h('section', { class: 'panel' },
        h('h3', {}, 'Background'),
        h('p', { class: 'muted' }, 'Closing the window keeps Cineteca and qBittorrent running so other devices can still watch. Quit to stop everything.'),
        h('button', { class: 'btn danger', onclick: () => window.cineteca.quit() }, 'Quit Cineteca')) : null),
    h('p', { class: 'muted', style: 'margin-top:24px' }, `Cineteca ${info.version}`));
}

function trackersPanel(t, local, saveSettings) {
  const box = h('input', { type: 'checkbox', id: 'trackers', checked: t.enabled, disabled: !local,
    onchange: () => saveSettings({ trackers: box.checked }) });
  const text = !t.enabled ? 'Off.'
    : t.count ? `${t.count} public trackers ${t.source === 'cache' ? 'from the saved copy (offline)' : `updated ${new Date(t.updatedAt).toLocaleString()}`}.`
      : (t.error || 'Updating…');
  return h('div', { style: 'margin-top:12px' },
    h('label', { class: 'row', for: 'trackers' }, box, 'Add public trackers on every start'),
    h('p', { class: 'muted' }, text, ' Source: ',
      h('a', { href: 'https://github.com/ngosang/trackerslist', target: '_blank', rel: 'noopener' }, 'ngosang/trackerslist'), '.'));
}

// ------------------------------------------------------------ router

async function route() {
  cleanup.forEach(f => { try { f(); } catch { /* ignore */ } });
  cleanup = [];
  const hash = location.hash.slice(1) || '/';
  const [pathPart, query = ''] = hash.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(query);
  const name = parts[0] || 'home';
  const navName = { item: 'library', watch: 'library', read: 'library' }[name] || name;
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === navName));
  const fullscreen = name === 'watch' || name === 'read';
  $('.topbar').classList.toggle('hidden', fullscreen);
  window.scrollTo(0, 0);
  try {
    if (name === 'discover') await discoverView(params);
    else if (name === 'library') await libraryView(params);
    else if (name === 'item') await itemView(parts[1]);
    else if (name === 'watch') await watchView(parts[1], parts[2]);
    else if (name === 'read') await readView(parts[1], parts[2]);
    else if (name === 'settings') await settingsView();
    else await homeView();
  } catch (e) {
    view.replaceChildren(h('div', { class: 'empty' }, e.message));
  }
  if (!fullscreen && !view.contains(document.activeElement)) {
    view.querySelector('input[type=search], a.card, .btn, a, button')?.focus({ preventScroll: true });
  }
}

window.addEventListener('hashchange', route);
route();

// Global transfer speed in the top bar.
setInterval(async () => {
  if (document.hidden || $('.topbar').classList.contains('hidden')) return;
  try {
    const { torrents } = await api('/api/torrents');
    const dl = torrents.reduce((n, t) => n + t.dlspeed, 0);
    const active = torrents.filter(t => !t.done && !t.stopped).length;
    $('#speed').textContent = active ? `↓ ${fmtBytes(dl)}/s · ${active} downloading` : '';
  } catch { /* offline */ }
}, 3000);

// ------------------------------------------------------------ TV remote navigation
// Arrow keys move focus to the nearest element in that direction, so TV
// remotes and game pads can drive the interface without a mouse.
document.addEventListener('keydown', e => {
  const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const dir = dirs[e.key];
  if (!dir || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const active = document.activeElement;
  if (active && active.matches('input[type=text], input[type=search], input[type=password], input[type=number]') && dir[0] !== 0) return;
  if (active?.tagName === 'SELECT' || active?.type === 'range') return;
  if ($('.reader')) return;
  const candidates = [...document.querySelectorAll('a[href], button, input, select, [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.offsetParent !== null && !el.closest('.hidden, dialog:not([open])'));
  if (!candidates.length) return;
  if (!active || active === document.body) { candidates[0].focus(); e.preventDefault(); return; }
  const r = active.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of candidates) {
    if (el === active) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - cx, dy = b.top + b.height / 2 - cy;
    const along = dx * dir[0] + dy * dir[1];
    if (along <= 4) continue;
    const across = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
    const score = along + across * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) {
    e.preventDefault();
    best.focus();
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
});
