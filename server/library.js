'use strict';
// Small JSON database stored inside the cripto folder: metadata for each
// torrent (title, cover, category) and playback / reading positions.
const fs = require('fs');
const { paths } = require('./config');

let data = { torrents: {}, progress: {} };
try {
  data = { ...data, ...JSON.parse(fs.readFileSync(paths.db, 'utf8')) };
} catch { /* first run */ }

let timer = null;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(flush, 500);
}

function flush() {
  clearTimeout(timer);
  const tmp = paths.db + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, paths.db);
}

const progressKey = (hash, index) => `${hash}:${index}`;

module.exports = {
  flush,
  getTorrent: hash => data.torrents[hash],
  allTorrents: () => data.torrents,
  putTorrent(hash, meta) {
    data.torrents[hash] = { ...(data.torrents[hash] || {}), ...meta, hash };
    persist();
  },
  removeTorrent(hash) {
    delete data.torrents[hash];
    for (const key of Object.keys(data.progress)) {
      if (key.startsWith(hash + ':')) delete data.progress[key];
    }
    persist();
  },
  getProgress: (hash, index) => data.progress[progressKey(hash, index)] || null,
  progressFor: hash => Object.fromEntries(
    Object.entries(data.progress)
      .filter(([k]) => k.startsWith(hash + ':'))
      .map(([k, v]) => [k.slice(hash.length + 1), v])),
  allProgress: () => data.progress,
  setProgress(hash, index, value) {
    data.progress[progressKey(hash, index)] = { ...value, hash, index: Number(index), updatedAt: Date.now() };
    persist();
  },
};
