'use strict';
// Just enough bencode to read a .torrent file and compute its info-hash.
const crypto = require('crypto');

function decode(buf) {
  let pos = 0;
  let infoStart = -1;
  let infoEnd = -1;

  function readInt(end) {
    const n = Number(buf.toString('ascii', pos, end));
    pos = end + 1;
    return n;
  }

  function next(depth) {
    const c = buf[pos];
    if (c === 0x69) { // i<n>e
      pos++;
      return readInt(buf.indexOf(0x65, pos));
    }
    if (c === 0x6c) { // l...e
      pos++;
      const list = [];
      while (buf[pos] !== 0x65) list.push(next(depth + 1));
      pos++;
      return list;
    }
    if (c === 0x64) { // d...e
      pos++;
      const dict = {};
      while (buf[pos] !== 0x65) {
        const key = next(depth + 1).toString('utf8');
        const start = pos;
        dict[key] = next(depth + 1);
        if (depth === 0 && key === 'info') { infoStart = start; infoEnd = pos; }
      }
      pos++;
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) { // <len>:<bytes>
      const colon = buf.indexOf(0x3a, pos);
      const len = Number(buf.toString('ascii', pos, colon));
      pos = colon + 1 + len;
      return buf.subarray(colon + 1, pos);
    }
    throw new Error('Invalid torrent file');
  }

  const value = next(0);
  return { value, infoStart, infoEnd };
}

// Returns { hash, name } for a .torrent buffer (v1 info-hash, as qBittorrent reports it).
function parseTorrent(buf) {
  const { value, infoStart, infoEnd } = decode(buf);
  if (!value || infoStart < 0) throw new Error('Torrent file has no info dictionary');
  const info = value.info;
  let hash;
  if (info['meta version'] === 2 && !info.pieces) {
    // Pure v2 torrent: qBittorrent identifies it by the truncated SHA-256.
    hash = crypto.createHash('sha256').update(buf.subarray(infoStart, infoEnd)).digest('hex').slice(0, 40);
  } else {
    hash = crypto.createHash('sha1').update(buf.subarray(infoStart, infoEnd)).digest('hex');
  }
  return { hash, name: info.name ? info.name.toString('utf8') : '' };
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Returns { hash, name } for a magnet link.
function parseMagnet(uri) {
  const params = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
  let hash = '';
  for (const xt of params.getAll('xt')) {
    const m = xt.match(/^urn:btih:([a-z0-9]+)$/i);
    if (!m) continue;
    const v = m[1];
    if (v.length === 40) hash = v.toLowerCase();
    else if (v.length === 32) {
      let bits = '';
      for (const ch of v.toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
      hash = bits.match(/.{8}/g).map(b => parseInt(b, 2).toString(16).padStart(2, '0')).join('');
    }
  }
  if (!hash) {
    const v2 = params.getAll('xt').map(x => x.match(/^urn:btmh:1220([a-f0-9]{64})$/i)).find(Boolean);
    if (v2) hash = v2[1].toLowerCase().slice(0, 40);
  }
  if (!hash) throw new Error('Magnet link has no BitTorrent info-hash');
  return { hash, name: params.get('dn') || '' };
}

module.exports = { parseTorrent, parseMagnet };
