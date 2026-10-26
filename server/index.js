'use strict';
// Cineteca server: web API + media streaming for the desktop window and for
// every other device on the local network (phones, tablets, TVs).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');

const { config, paths, save, CATEGORIES } = require('./config');
const qbit = require('./qbit');
const library = require('./library');
const catalog = require('./catalog');
const media = require('./media');
const dlna = require('./dlna');
const trackers = require('./trackers');
const { parseTorrent, parseMagnet } = require('./bencode');

const VERSION = require('../package.json').version;

// ---------------------------------------------------------------- security

const secretFile = path.join(paths.state, 'secret');
let secret;
try { secret = fs.readFileSync(secretFile, 'utf8'); } catch {
  secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
}
const sign = value => crypto.createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
const MEDIA_TOKEN = sign('media');

const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/)
  .map(c => c.split('=')).find(([k]) => k === name)?.[1];

function requireAccess(req, res, next) {
  if (!config.accessPin || isLocal(req)) return next();
  if (cookieOf(req, 'cineteca_pin') === sign('pin:' + config.accessPin)) return next();
  // DLNA players (TVs) cannot type a PIN; they receive signed media URLs.
  if (req.query.t === MEDIA_TOKEN && (req.path.startsWith('/media/') || req.path.startsWith('/api/thumb/'))) return next();
  if (req.path.startsWith('/dlna/') || req.path === '/login' || req.path === '/api/login'
    || /^\/(styles\.css|icon\.svg|manifest\.webmanifest)$/.test(req.path)) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) return res.status(401).json({ error: 'PIN required' });
  return res.redirect('/login');
}

function localOnly(req, res, next) {
  if (isLocal(req)) return next();
  res.status(403).json({ error: 'This setting can only be changed on the computer running Cineteca' });
}

// ---------------------------------------------------------------- helpers

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  console.error('[api]', req.method, req.path, err.message);
  if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
});

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isHash = h => /^[a-f0-9]{40}$/.test(h);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

async function torrentInfo(hash) {
  if (!isHash(hash)) throw httpError(400, 'Invalid torrent id');
  const [t] = await qbit.call('torrents/info', { query: { hashes: hash } });
  if (!t) throw httpError(404, 'Torrent not found');
  return t;
}

async function torrentFiles(hash) {
  const t = await torrentInfo(hash);
  const files = await qbit.call('torrents/files', { query: { hash } });
  return {
    torrent: t,
    files: files.map((f, i) => ({
      index: f.index ?? i,
      name: f.name,
      base: path.basename(f.name),
      size: f.size,
      progress: f.progress,
      priority: f.priority,
      kind: media.kindOf(f.name),
      abs: path.join(t.save_path, f.name),
    })),
  };
}

async function fileFor(hash, index) {
  const { torrent, files } = await torrentFiles(hash);
  const file = files.find(f => f.index === Number(index));
  if (!file) throw httpError(404, 'File not found');
  file.abs = media.safePath(file.abs);
  if (!fs.existsSync(file.abs)) throw httpError(404, 'File has not been downloaded yet');
  return { torrent, file, files };
}

function describe(t) {
  const meta = library.getTorrent(t.hash) || {};
  const stopped = /^(paused|stopped)/i.test(t.state);
  return {
    hash: t.hash,
    title: meta.title || t.name,
    name: t.name,
    category: t.category || meta.category || 'Other',
    cover: meta.cover || '',
    page: meta.page || '',
    progress: t.progress,
    size: t.size,
    downloaded: t.completed,
    state: t.state,
    stopped,
    done: t.progress >= 1,
    dlspeed: t.dlspeed,
    upspeed: t.upspeed,
    eta: t.eta,
    seeds: t.num_seeds,
    peers: t.num_leechs,
    sequential: !!t.seq_dl,
    addedOn: t.added_on,
  };
}

async function fetchBuffer(url, limit = 10 * 1024 * 1024) {
  if (!/^https?:\/\//i.test(url)) throw httpError(400, 'Only http(s) links or magnet links are supported');
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
  if (!res.ok) throw httpError(502, `Could not download the torrent file (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limit) throw httpError(413, 'Torrent file is too large');
  return buf;
}

// For catalog items only fetch what is useful (Internet Archive items also
// carry scans, metadata XML and several encodes of the same video).
function chooseFiles(files, category) {
  if (category === 'Books') {
    // Gutenberg items carry two EPUB editions; keep only the richer one.
    const epubs = files.filter(f => /\.epub$/i.test(f.name)).sort((a, b) => b.size - a.size).slice(0, 1);
    const books = epubs.length ? epubs : files.filter(f => f.kind === 'book');
    return books.length ? new Set(books.map(f => f.index)) : null;
  }
  const videos = files.filter(f => f.kind === 'video');
  if (!videos.length) return null;
  const groups = new Map();
  for (const v of videos) {
    const stem = v.name.replace(/\.[^.]+$/, '').replace(/(_512kb|\.ia|_edit)$/i, '').toLowerCase();
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(v);
  }
  const keep = new Set();
  for (const group of groups.values()) {
    const preferred = group.filter(f => /\.(mp4|m4v|webm|mkv)$/i.test(f.name));
    const pool = preferred.length ? preferred : group;
    keep.add(pool.reduce((a, b) => (b.size > a.size ? b : a)).index);
  }
  for (const f of files) if (f.kind === 'subtitle') keep.add(f.index);
  return keep;
}

async function addTorrent({ buffer, magnet, category, title, cover, page, source, stream, smartSelect, webSeeds = [] }) {
  if (!CATEGORIES.includes(category)) category = 'Other';
  const parsed = buffer ? parseTorrent(buffer) : parseMagnet(magnet);
  const { hash } = parsed;
  const form = new FormData();
  if (buffer) form.append('torrents', new Blob([buffer], { type: 'application/x-bittorrent' }), 'file.torrent');
  else form.append('urls', magnet);
  form.append('category', category);
  form.append('autoTMM', 'true');
  form.append('tags', 'cineteca');
  if (stream) {
    form.append('sequentialDownload', 'true');
    form.append('firstLastPiecePrio', 'true');
  }
  if (smartSelect) {
    // Added stopped so nothing unwanted starts downloading before the file selection.
    form.append('stopped', 'true');
    form.append('paused', 'true');
  }
  const reply = await qbit.call('torrents/add', { body: form });
  if (String(reply).trim() === 'Fails.') {
    const exists = await qbit.call('torrents/info', { query: { hashes: hash } }).catch(() => []);
    if (!exists.length) throw httpError(502, 'qBittorrent rejected this torrent');
  }

  if (webSeeds.length) {
    await qbit.call('torrents/addWebSeeds', { form: { hash, urls: webSeeds.join('|') } }).catch(() => {});
  }

  library.putTorrent(hash, {
    title: title || parsed.name || hash,
    category, cover: cover || '', page: page || '', source: source || 'manual', addedAt: Date.now(),
  });

  if (smartSelect) {
    // Wait until qBittorrent knows the file list, deselect the extras, then start.
    for (let i = 0; i < 40; i++) {
      try {
        const { files } = await torrentFiles(hash);
        if (files.length) {
          const keep = chooseFiles(files, category);
          const skip = keep ? files.filter(f => !keep.has(f.index)).map(f => f.index) : [];
          if (skip.length) await qbit.call('torrents/filePrio', { form: { hash, id: skip.join('|'), priority: '0' } });
          break;
        }
      } catch { /* not registered yet */ }
      await new Promise(r => setTimeout(r, 500));
    }
    await startTorrent(hash);
  }
  dlnaRouter.bump();
  return { hash };
}

async function startTorrent(hash) {
  try { await qbit.call('torrents/start', { form: { hashes: hash } }); }
  catch { await qbit.call('torrents/resume', { form: { hashes: hash } }); }
}

async function stopTorrent(hash) {
  try { await qbit.call('torrents/stop', { form: { hashes: hash } }); }
  catch { await qbit.call('torrents/pause', { form: { hashes: hash } }); }
}

function removeEmptyParents(dir) {
  const stopAt = new Set([path.resolve(paths.downloads), ...CATEGORIES.map(c => path.resolve(paths.downloads, c))]);
  let current = path.resolve(dir);
  while (!stopAt.has(current) && current.startsWith(path.resolve(paths.downloads) + path.sep)) {
    try { fs.rmdirSync(current); } catch { break; }
    current = path.dirname(current);
  }
}

async function deleteTorrent(hash) {
  const { torrent: t, files } = await torrentFiles(hash);
  await qbit.call('torrents/delete', { form: { hashes: hash, deleteFiles: 'true' } });

  // qBittorrent leaves skipped-file stubs (.parts) and empty folders behind;
  // remove everything this torrent owned, but never outside downloads/.
  const protectedDirs = new Set([path.resolve(paths.downloads), ...CATEGORIES.map(c => path.resolve(paths.downloads, c))]);
  const targets = new Set();
  try {
    const content = media.safePath(t.content_path);
    if (!protectedDirs.has(content)) targets.add(content);
  } catch { /* outside downloads: leave it alone */ }
  const root = files.length && files[0].name.includes('/') ? files[0].name.split('/')[0] : '';
  if (root) {
    try {
      const dir = media.safePath(path.join(t.save_path, root));
      if (!protectedDirs.has(dir)) targets.add(dir);
    } catch { /* ignore */ }
  }
  for (const f of files) {
    try { targets.add(media.safePath(f.abs)); } catch { /* ignore */ }
  }
  await new Promise(r => setTimeout(r, 800)); // let qBittorrent release the files
  for (const target of targets) {
    fs.rmSync(target, { recursive: true, force: true });
    const dir = path.dirname(target);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('.') && f.includes(hash) && f.endsWith('.parts')) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch { /* directory gone */ }
    removeEmptyParents(dir);
  }
  media.removeThumbnails(hash);
  library.removeTorrent(hash);
  dlnaRouter.bump();
}

function lanUrls() {
  return dlna.lanAddresses().map(a => ({ name: a.name, url: `http://${a.address}:${config.port}` }));
}

// ---------------------------------------------------------------- DLNA tree

let treeCache = { at: 0, tree: [] };
async function dlnaTree() {
  if (Date.now() - treeCache.at < 15000) return treeCache.tree;
  const torrents = await qbit.call('torrents/info');
  const byCat = new Map();
  for (const t of torrents) {
    const d = describe(t);
    if (d.category === 'Books') continue;
    let files;
    try { files = (await torrentFiles(t.hash)).files; } catch { continue; }
    const videos = files.filter(f => f.kind === 'video' && f.priority > 0 && f.progress > 0.02)
      .sort((a, b) => collator.compare(a.name, b.name));
    if (!videos.length) continue;
    const items = videos.map(f => ({
      id: `f:${t.hash}:${f.index}`,
      title: videos.length === 1 ? d.title : f.base.replace(/\.[^.]+$/, ''),
      size: f.size, mime: media.mimeOf(f.name), hash: t.hash, index: f.index, base: f.base,
      thumb: `/api/thumb/${t.hash}/${f.index}?t=${MEDIA_TOKEN}`,
    }));
    const node = items.length === 1 ? items[0] : { id: `t:${t.hash}`, title: d.title, children: items };
    if (!byCat.has(d.category)) byCat.set(d.category, []);
    byCat.get(d.category).push(node);
  }
  const tree = CATEGORIES.filter(c => byCat.has(c)).map(c => ({
    id: `c:${c}`, title: c, children: byCat.get(c).sort((a, b) => collator.compare(a.title, b.title)),
  }));
  treeCache = { at: Date.now(), tree };
  return tree;
}

const dlnaRouter = dlna.createRouter(dlnaTree,
  node => `/media/${node.hash}/${node.index}/${encodeURIComponent(node.base)}?t=${MEDIA_TOKEN}`);
const origBump = dlnaRouter.bump;
dlnaRouter.bump = () => { treeCache.at = 0; origBump(); };

// ---------------------------------------------------------------- app

const app = express();
app.disable('x-powered-by');
app.use(requireAccess);
app.use('/dlna', dlnaRouter);
app.use(express.json({ limit: '1mb' }));

const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { index: 'index.html' }));
app.get('/vendor/epub.min.js', (req, res) => res.sendFile(require.resolve('epubjs/dist/epub.min.js')));
app.get('/vendor/jszip.min.js', (req, res) => res.sendFile(require.resolve('jszip/dist/jszip.min.js')));

app.get('/login', (req, res) => res.sendFile(path.join(pub, 'login.html')));
app.post('/api/login', wrap(async (req, res) => {
  if (config.accessPin && String(req.body.pin || '') === config.accessPin) {
    res.setHeader('Set-Cookie', `cineteca_pin=${sign('pin:' + config.accessPin)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`);
    return res.json({ ok: true });
  }
  await new Promise(r => setTimeout(r, 800));
  res.status(401).json({ error: 'Wrong PIN' });
}));

app.get('/api/info', wrap(async (req, res) => {
  const urls = lanUrls();
  let disk = null;
  try {
    const s = fs.statfsSync(paths.root);
    disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { /* unsupported */ }
  const qr = urls[0] ? await QRCode.toString(urls[0].url, { type: 'svg', margin: 1 }) : '';
  res.json({
    version: VERSION, local: isLocal(req), urls, qr, disk,
    mediaRoot: paths.root, qbit: await qbit.status(), trackers: { enabled: config.trackers, ...trackers.status() },
    settings: { dlna: config.dlna, hasPin: !!config.accessPin, serverName: config.serverName, port: config.port },
    categories: CATEGORIES,
  });
}));

app.put('/api/settings', localOnly, wrap(async (req, res) => {
  const changes = {};
  const b = req.body || {};
  if (typeof b.accessPin === 'string') {
    if (b.accessPin && !/^\d{4,12}$/.test(b.accessPin)) throw httpError(400, 'PIN must be 4 to 12 digits');
    changes.accessPin = b.accessPin;
  }
  if (typeof b.dlna === 'boolean') changes.dlna = b.dlna;
  if (typeof b.trackers === 'boolean') changes.trackers = b.trackers;
  if (typeof b.serverName === 'string' && b.serverName.trim()) changes.serverName = b.serverName.trim().slice(0, 60);
  if (typeof b.mediaRoot === 'string' && b.mediaRoot.trim()) changes.mediaRoot = b.mediaRoot.trim();
  if (b.port !== undefined) {
    const p = Number(b.port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw httpError(400, 'Port must be between 1024 and 65535');
    changes.port = p;
  }
  save(changes);
  const restart = ['mediaRoot', 'port', 'dlna', 'serverName'].some(k => k in changes && changes[k] !== config[k]);
  if ('accessPin' in changes) config.accessPin = changes.accessPin;
  if ('trackers' in changes) {
    config.trackers = changes.trackers;
    if (config.trackers) trackers.update().catch(() => {});
  }
  res.json({ ok: true, restartRequired: restart });
}));

app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 150);
  const category = String(req.query.category || 'Movies');
  const page = Math.max(1, Number(req.query.page) || 1);
  const result = await catalog.search(q, category, page, req.query.curated !== '0');
  const known = new Map(Object.values(library.allTorrents())
    .filter(t => t.source?.startsWith('archive:')).map(t => [t.source.slice(8), t.hash]));
  result.items.forEach(i => {
    const v = i.versions.find(x => known.has(x.id));
    i.hash = v ? known.get(v.id) : null;
  });
  res.json(result);
}));

app.get('/api/torrents', wrap(async (req, res) => {
  const list = await qbit.call('torrents/info', { query: { sort: 'added_on', reverse: 'true' } });
  res.json({ torrents: list.map(describe) });
}));

app.post('/api/torrents', wrap(async (req, res) => {
  const b = req.body || {};
  const category = String(b.category || 'Other');
  if (b.archiveId) {
    const src = await catalog.torrentSource(b.archiveId);
    const buffer = await fetchBuffer(src.url);
    return res.json(await addTorrent({
      buffer, category, title: b.title, cover: b.cover, page: b.page, webSeeds: src.webSeeds,
      source: `archive:${b.archiveId}`, stream: !!b.stream, smartSelect: true,
    }));
  }
  const link = String(b.link || '').trim();
  if (!link) throw httpError(400, 'Paste a magnet link or a .torrent URL');
  if (link.startsWith('magnet:')) {
    return res.json(await addTorrent({ magnet: link, category, title: b.title, stream: !!b.stream }));
  }
  const buffer = await fetchBuffer(link);
  res.json(await addTorrent({ buffer, category, title: b.title, stream: !!b.stream }));
}));

app.post('/api/torrents/upload', express.raw({ type: '*/*', limit: '10mb' }), wrap(async (req, res) => {
  if (!req.body?.length) throw httpError(400, 'Empty torrent file');
  res.json(await addTorrent({
    buffer: req.body, category: String(req.query.category || 'Other'),
    title: String(req.query.title || ''), stream: req.query.stream === '1',
  }));
}));

app.get('/api/torrents/:hash', wrap(async (req, res) => {
  const { torrent, files } = await torrentFiles(req.params.hash);
  const progress = library.progressFor(torrent.hash);
  res.json({
    torrent: describe(torrent),
    files: files.sort((a, b) => collator.compare(a.name, b.name))
      .map(({ abs, ...f }) => ({ ...f, watch: progress[f.index] || null })),
  });
}));

app.post('/api/torrents/:hash/:action(start|stop|stream)', wrap(async (req, res) => {
  const t = await torrentInfo(req.params.hash);
  if (req.params.action === 'start') await startTorrent(t.hash);
  else if (req.params.action === 'stop') await stopTorrent(t.hash);
  else {
    const on = req.body?.on !== false;
    if (!!t.seq_dl !== on) await qbit.call('torrents/toggleSequentialDownload', { form: { hashes: t.hash } });
    if (!!t.f_l_piece_prio !== on) await qbit.call('torrents/toggleFirstLastPiecePrio', { form: { hashes: t.hash } });
  }
  res.json({ ok: true });
}));

app.post('/api/torrents/:hash/category', wrap(async (req, res) => {
  const t = await torrentInfo(req.params.hash);
  const category = String(req.body?.category || '');
  if (!CATEGORIES.includes(category)) throw httpError(400, 'Unknown category');
  await qbit.call('torrents/setCategory', { form: { hashes: t.hash, category } });
  library.putTorrent(t.hash, { category });
  dlnaRouter.bump();
  res.json({ ok: true });
}));

app.delete('/api/torrents/:hash', wrap(async (req, res) => {
  await deleteTorrent(req.params.hash);
  res.json({ ok: true });
}));

app.get('/api/probe/:hash/:index', wrap(async (req, res) => {
  const { torrent, file, files } = await fileFor(req.params.hash, req.params.index);
  const info = await media.probe(file.abs);
  const stem = file.base.replace(/\.[^.]+$/, '').toLowerCase();
  const sidecars = files.filter(f => f.kind === 'subtitle' && f.progress >= 1)
    .sort((a, b) => Number(b.base.toLowerCase().startsWith(stem)) - Number(a.base.toLowerCase().startsWith(stem)))
    .map(f => ({ index: f.index, name: f.base }));
  const videos = files.filter(f => f.kind === 'video' && f.priority > 0).sort((a, b) => collator.compare(a.name, b.name));
  const pos = videos.findIndex(v => v.index === file.index);
  const next = pos >= 0 ? videos[pos + 1] : null;
  const meta = describe(torrent);
  res.json({
    ...info,
    title: videos.length > 1 ? file.base.replace(/\.[^.]+$/, '') : meta.title,
    show: meta.title, name: file.base, fileProgress: file.progress,
    sidecars, next: next ? { index: next.index, name: next.base } : null,
    watch: library.getProgress(torrent.hash, file.index),
    url: `/media/${torrent.hash}/${file.index}/${encodeURIComponent(file.base)}`,
  });
}));

app.get('/api/stream/:hash/:index', wrap(async (req, res) => {
  const { file } = await fileFor(req.params.hash, req.params.index);
  const mode = req.query.mode === 'remux' ? 'remux' : 'transcode';
  media.stream(file.abs, { mode, start: Math.max(0, Number(req.query.start) || 0), audio: Math.max(0, Number(req.query.audio) || 0) }, req, res);
}));

app.post('/api/hls/:hash/:index', wrap(async (req, res) => {
  const { file } = await fileFor(req.params.hash, req.params.index);
  const id = await media.hlsStart(file.abs, {
    mode: req.query.mode === 'remux' ? 'remux' : 'transcode',
    start: Math.max(0, Number(req.query.start) || 0),
    audio: Math.max(0, Number(req.query.audio) || 0),
    client: String(req.query.client || req.socket.remoteAddress),
  });
  res.json({ url: `/hls/${id}/index.m3u8` });
}));

app.get('/hls/:id/:name', (req, res) => {
  const file = media.hlsFile(req.params.id, req.params.name);
  if (!file || !fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file, { dotfiles: 'allow', headers: {
    'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t', 'Cache-Control': 'no-store',
  } });
});

app.get('/api/subs/:hash/:index', wrap(async (req, res) => {
  const { file } = await fileFor(req.params.hash, req.params.index);
  media.subtitles(file.abs, { stream: req.query.stream }, res);
}));

app.get('/api/thumb/:hash/:index', wrap(async (req, res) => {
  const { torrent, file } = await fileFor(req.params.hash, req.params.index);
  let duration = 0;
  try { duration = (await media.probe(file.abs)).duration; } catch { /* still try */ }
  const out = await media.thumbnail(torrent.hash, file.index, file.abs, duration);
  res.sendFile(out, { maxAge: 86400000 });
}));

app.get(['/media/:hash/:index', '/media/:hash/:index/:name'], wrap(async (req, res) => {
  const { file } = await fileFor(req.params.hash, req.params.index);
  res.set({
    'transferMode.dlna.org': 'Streaming',
    'contentFeatures.dlna.org': 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
  });
  if (req.query.download) return res.download(file.abs, file.base, { dotfiles: 'allow' });
  res.sendFile(file.abs, { dotfiles: 'allow', headers: { 'Content-Type': media.mimeOf(file.name) } });
}));

function saveProgress(req, res) {
  const { hash, index } = req.params;
  if (!isHash(hash)) return res.status(400).json({ error: 'Invalid torrent id' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  const entry = {
    position: Math.max(0, Number(b.position) || 0),
    duration: Math.max(0, Number(b.duration) || 0),
    name: String(b.name || '').slice(0, 300),
    kind: b.kind === 'book' ? 'book' : 'video',
  };
  if (b.cfi) entry.cfi = String(b.cfi).slice(0, 500);
  if (b.percent !== undefined) entry.percent = Math.min(1, Math.max(0, Number(b.percent) || 0));
  entry.finished = entry.kind === 'video'
    ? entry.duration > 0 && entry.position >= entry.duration * 0.95
    : entry.percent >= 0.99;
  library.setProgress(hash, Number(index), entry);
  res.json({ ok: true });
}
app.put('/api/progress/:hash/:index', saveProgress);
app.post('/api/progress/:hash/:index', express.text({ type: '*/*' }), saveProgress); // sendBeacon

app.get('/api/continue', wrap(async (req, res) => {
  const items = Object.values(library.allProgress())
    .filter(p => !p.finished && (p.kind === 'book' ? p.percent > 0 : p.position > 20))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20)
    .map(p => ({ ...p, title: library.getTorrent(p.hash)?.title || p.name, cover: library.getTorrent(p.hash)?.cover || '' }));
  const existing = new Set((await qbit.call('torrents/info')).map(t => t.hash));
  res.json({ items: items.filter(i => existing.has(i.hash)) });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------------------------------------------------------------- lifecycle

let httpServer = null;
let ssdp = null;

async function start() {
  await new Promise((resolve, reject) => {
    httpServer = app.listen(config.port, '0.0.0.0', resolve);
    httpServer.once('error', err => reject(err.code === 'EADDRINUSE'
      ? new Error(`Port ${config.port} is already in use. Is Cineteca already running?`) : err));
  });
  let qbitError = null;
  try { await qbit.start(); } catch (e) { qbitError = e.message; console.error('[qbittorrent]', e.message); }
  // Refresh the public tracker list in the background; startup does not wait for it.
  if (!qbitError) trackers.update().catch(e => console.warn('[trackers]', e.message));
  if (config.dlna) ssdp = dlna.startSsdp();
  return { port: config.port, local: `http://127.0.0.1:${config.port}`, urls: lanUrls(), qbitError };
}

async function stop() {
  ssdp?.stop();
  library.flush();
  await qbit.stop();
  await new Promise(r => (httpServer ? httpServer.close(() => r()) : r()));
  httpServer?.closeAllConnections?.();
}

module.exports = { start, stop, config };

if (require.main === module) {
  start().then(info => {
    console.log(`Cineteca ${VERSION} is running`);
    console.log(`  This computer: ${info.local}`);
    for (const u of info.urls) console.log(`  Network (${u.name}): ${u.url}`);
    console.log(`  Media folder: ${paths.root}`);
    if (info.qbitError) console.log(`  WARNING: ${info.qbitError}`);
  }).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log('Stopping Cineteca and qBittorrent...');
    stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
