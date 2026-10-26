'use strict';
// Public tracker list from https://github.com/ngosang/trackerslist, refreshed
// every time Cineteca starts. More trackers = more peers found per torrent.
// The last good list is cached in the cripto folder for offline starts.
const fs = require('fs');
const path = require('path');
const { config, paths } = require('./config');
const qbit = require('./qbit');

const CACHE = path.join(paths.state, 'trackers.txt');
let state = { count: 0, updatedAt: 0, source: '', error: '' };
let current = [];

const parse = text => [...new Set(text.split(/\r?\n/).map(l => l.trim())
  .filter(l => /^(udp|https?|wss?):\/\//i.test(l)))];

async function download() {
  const res = await fetch(config.trackersUrl, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const list = parse(await res.text());
  if (!list.length) throw new Error('the list was empty');
  fs.writeFileSync(CACHE, list.join('\n') + '\n');
  return list;
}

async function update() {
  if (!config.trackers) return state;
  let list;
  try {
    list = await download();
    state = { count: list.length, updatedAt: Date.now(), source: 'online', error: '' };
  } catch (e) {
    try {
      list = parse(fs.readFileSync(CACHE, 'utf8'));
      state = { count: list.length, updatedAt: fs.statSync(CACHE).mtimeMs, source: 'cache', error: `Could not refresh tracker list: ${e.message}` };
    } catch {
      state = { count: 0, updatedAt: 0, source: '', error: `Could not download tracker list: ${e.message}` };
      return state;
    }
  }

  // New torrents get the list automatically...
  await qbit.call('app/setPreferences', {
    form: { json: JSON.stringify({ add_trackers_enabled: true, add_trackers: list.join('\n') }) },
  });
  current = list;
  await applyToExisting();
  // qBittorrent restores saved torrents shortly after its API is up, so
  // run once more for any that were still loading.
  setTimeout(() => applyToExisting().catch(() => {}), 30000).unref();
  console.log(`[trackers] ${list.length} public trackers applied (${state.source})`);
  return state;
}

// ...and existing torrents get any trackers they are missing (qBittorrent
// ignores ones a torrent already has).
async function applyToExisting() {
  if (!current.length) return;
  const torrents = await qbit.call('torrents/info').catch(() => []);
  for (const t of torrents) {
    if (t.private) continue; // never add public trackers to private torrents
    await qbit.call('torrents/addTrackers', { form: { hash: t.hash, urls: current.join('\n') } }).catch(() => {});
  }
}

module.exports = { update, status: () => state };
