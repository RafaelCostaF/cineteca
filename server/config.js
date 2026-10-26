'use strict';
// Settings live in ~/.config/cineteca/config.json (only the pointer to the
// media folder and network options). Everything that is downloaded or
// generated lives inside the "cripto" folder.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.CINETECA_CONFIG_DIR
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'cineteca');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  mediaRoot: path.join(os.homedir(), 'cripto'),
  port: 8787,              // app / LAN port
  qbitPort: 18080,         // private qBittorrent Web API port (localhost only)
  torrentingPort: 0,       // 0 = let qBittorrent choose
  qbitBinary: '',          // empty = auto-detect qbittorrent-nox / qbittorrent
  accessPin: '',           // optional PIN required for other devices on the LAN
  dlna: true,              // announce a DLNA/UPnP media server for smart TVs
  trackers: true,          // add public trackers from ngosang/trackerslist on every start
  trackersUrl: 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt',
  serverName: `Cineteca (${os.hostname()})`,
};

function load() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* first run */ }
  const cfg = { ...DEFAULTS, ...saved };
  if (process.env.CINETECA_MEDIA_ROOT) cfg.mediaRoot = process.env.CINETECA_MEDIA_ROOT;
  if (process.env.CINETECA_PORT) cfg.port = Number(process.env.CINETECA_PORT);
  if (process.env.CINETECA_PIN) cfg.accessPin = process.env.CINETECA_PIN;
  if (process.env.CINETECA_QBITTORRENT) cfg.qbitBinary = process.env.CINETECA_QBITTORRENT;
  if (process.env.CINETECA_QBIT_PORT) cfg.qbitPort = Number(process.env.CINETECA_QBIT_PORT);
  cfg.mediaRoot = path.resolve(cfg.mediaRoot.replace(/^~(?=$|\/)/, os.homedir()));
  return cfg;
}

function save(changes) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* none yet */ }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...saved, ...changes }, null, 2), { mode: 0o600 });
}

const config = load();

// Folder layout inside the cripto folder.
const paths = {
  root: config.mediaRoot,
  downloads: path.join(config.mediaRoot, 'downloads'),
  state: path.join(config.mediaRoot, '.cineteca'),
  qbitProfile: path.join(config.mediaRoot, '.cineteca', 'qbittorrent'),
  thumbs: path.join(config.mediaRoot, '.cineteca', 'thumbnails'),
  db: path.join(config.mediaRoot, '.cineteca', 'library.json'),
};

const CATEGORIES = ['Movies', 'Series', 'Anime', 'Books', 'Other'];

for (const dir of [paths.downloads, paths.state, paths.qbitProfile, paths.thumbs,
  ...CATEGORIES.map(c => path.join(paths.downloads, c))]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

module.exports = { config, paths, save, CATEGORIES, CONFIG_FILE };
