'use strict';
// Search the Internet Archive (public-domain and openly licensed media).
// Every Archive item comes with a web-seeded .torrent, so downloads are fast
// even with no other peers.
//
// "Curated" mode only searches collections that the Archive staff maintain
// (Feature Films, Film Noir, Sci-Fi & Horror, Silent Films, Classic TV,
// Animation & Cartoons, Project Gutenberg, Standard Ebooks), hides trailers,
// clips and other short uploads and merges duplicate copies of a title into
// one result with selectable versions.

const CURATED = {
  Movies: 'mediatype:movies AND collection:(feature_films OR Film_Noir OR SciFi_Horror OR silent_films)',
  Series: 'mediatype:movies AND collection:classic_tv',
  Anime: 'mediatype:movies AND collection:(animationandcartoons OR classic_cartoons)',
  Books: 'mediatype:texts AND collection:(gutenberg OR standardebooks) AND format:EPUB',
};

const EVERYTHING = {
  Movies: 'mediatype:movies AND NOT collection:(classic_tv OR animationandcartoons)',
  Series: 'mediatype:movies AND (collection:classic_tv OR subject:("tv series" OR episode))',
  Anime: 'mediatype:movies AND (subject:(anime OR animation OR cartoon) OR collection:animationandcartoons)',
  Books: 'mediatype:texts AND format:EPUB',
};

// Minimum running time (minutes) of a curated result, when the Archive knows it.
const MIN_RUNTIME = { Movies: 40, Series: 5, Anime: 0, Books: 0 };
const JUNK = /\b(trailers?|teasers?|clips?|samples?|promos?|previews?|ipod|psp|test upload|commercials?|bloopers?|outtakes)\b/i;

const PAGE = 100;

function minutes(runtime) {
  if (!runtime) return 0;
  const s = String(Array.isArray(runtime) ? runtime[0] : runtime).trim();
  const m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?/);
  if (m) return m[3] !== undefined ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 60 : Number(m[1]) + Number(m[2]) / 60;
  const n = s.match(/(\d+(?:\.\d+)?)\s*(h|hour|hr)?/i);
  if (!n) return 0;
  return n[2] ? Number(n[1]) * 60 : Number(n[1]);
}

const first = v => (Array.isArray(v) ? v[0] : v);

// "Night Of The Living Dead (1968) - restored 1080p" -> "night of the living dead"
function titleKey(title) {
  return String(title).toLowerCase()
    .replace(/[([].*?[)\]]/g, ' ')
    .replace(/\b(19|20)\d\d\b/g, ' ')
    .replace(/\b(full|movie|film|hd|sd|hq|1080p|720p|480p|4k|dvd|dvdrip|bluray|restored|remastered|colori[sz]ed|english|version|complete|uncut|widescreen|ws|raw)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function versionLabel(d) {
  const bits = [];
  const t = String(first(d.title) || '');
  const extra = t.match(/\b(1080p|720p|4k|hd|restored|remastered|colori[sz]ed|dvd|widescreen)\b/i);
  if (extra) bits.push(extra[1]);
  if (d.item_size) bits.push(d.item_size >= 1073741824 ? `${(d.item_size / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(d.item_size / 1048576))} MB`);
  if (d.downloads) bits.push(`${Number(d.downloads).toLocaleString('en')} views`);
  return bits.join(' · ') || d.identifier;
}

async function search(query, category = 'Movies', page = 1, curated = true) {
  if (!CURATED[category]) category = 'Movies';
  const filter = (curated ? CURATED : EVERYTHING)[category];
  // Every word must appear in the title; operators typed by the user are ignored.
  const words = query.replace(/[\\"():[\]{}^~*?!+\-/]/g, ' ').split(/\s+/)
    .filter(w => w && !/^(AND|OR|NOT)$/.test(w)).slice(0, 12);
  const base = `${filter} AND NOT access-restricted-item:true`;
  const q = words.length ? `title:(${words.join(' AND ')}) AND ${base}` : base;
  const params = new URLSearchParams({ q, rows: String(PAGE), page: String(page), output: 'json' });
  for (const f of ['identifier', 'title', 'year', 'creator', 'downloads', 'item_size', 'runtime', 'description']) params.append('fl[]', f);
  params.append('sort[]', 'downloads desc');

  const res = await fetch(`https://archive.org/advancedsearch.php?${params}`, {
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'Cineteca/1.0' },
  });
  if (!res.ok) throw new Error(`Internet Archive returned HTTP ${res.status}`);
  const body = await res.json();
  const response = body.response || {};
  let docs = (response.docs || []).filter(d => d.identifier);

  if (curated) {
    docs = docs.filter(d => {
      const title = String(first(d.title) || '');
      if (JUNK.test(title)) return false;
      const mins = minutes(d.runtime);
      return !(mins && mins < MIN_RUNTIME[category]);
    });
  }

  // Merge copies of the same work; the most watched copy leads.
  const groups = new Map();
  for (const d of docs) {
    const key = `${titleKey(first(d.title) || d.identifier)}|${category === 'Books' ? first(d.creator) || '' : ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  const items = [...groups.values()].map(group => {
    const d = group[0];
    const year = d.year || group.find(g => g.year)?.year || '';
    const desc = String(first(d.description) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      id: d.identifier,
      title: String(first(d.title) || d.identifier),
      year,
      creator: Array.isArray(d.creator) ? d.creator.slice(0, 3).join(', ') : (d.creator || ''),
      size: d.item_size || 0,
      runtime: minutes(d.runtime) ? Math.round(minutes(d.runtime)) : 0,
      downloads: d.downloads || 0,
      description: desc.slice(0, 280),
      cover: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
      page: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
      category,
      versions: group.map(g => ({ id: g.identifier, label: versionLabel(g) })),
    };
  });
  return { items, total: response.numFound || 0, page, more: page * PAGE < (response.numFound || 0), curated };
}

// Not every item has a torrent, so look it up in the item's file list.
// Also returns direct mirror URLs: the Archive's generic web seed redirects
// per file, and libtorrent then stalls on pieces that span two files.
async function torrentSource(id) {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Invalid Internet Archive identifier');
  const res = await fetch(`https://archive.org/metadata/${id}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Internet Archive returned HTTP ${res.status}`);
  const meta = await res.json();
  const file = (meta.files || []).find(f => f.format === 'Archive BitTorrent' || f.name?.endsWith('_archive.torrent'));
  if (!file) throw Object.assign(new Error('This Internet Archive item has no torrent. Please pick another result.'), { status: 404 });
  const parent = String(meta.dir || '').replace(/\/[^/]+\/?$/, '/');
  const servers = [...new Set([...(meta.workable_servers || []), meta.d1, meta.d2].filter(Boolean))];
  return {
    url: `https://archive.org/download/${id}/${encodeURIComponent(file.name)}`,
    webSeeds: parent ? servers.map(s => `https://${s}${parent}`) : [],
  };
}

module.exports = { search, torrentSource };
