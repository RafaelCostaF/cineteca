'use strict';
// Starts a private qBittorrent instance in the background and talks to it
// through its Web API. The instance uses its own profile inside the cripto
// folder, so it never touches a qBittorrent you may already be running.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { config, paths, CATEGORIES } = require('./config');

const BASE = `http://127.0.0.1:${config.qbitPort}/api/v2`;
let child = null;
let cookie = '';
let binaryInUse = '';
let lastError = '';

function findBinary() {
  const candidates = config.qbitBinary ? [config.qbitBinary] : [
    'qbittorrent-nox', 'qbittorrent',
    '/usr/bin/qbittorrent-nox', '/usr/local/bin/qbittorrent-nox',
    '/opt/homebrew/bin/qbittorrent-nox',
    '/Applications/qBittorrent.app/Contents/MacOS/qbittorrent',
    'C:\\Program Files\\qBittorrent\\qbittorrent.exe',
  ];
  for (const bin of candidates) {
    try {
      if (path.isAbsolute(bin)) {
        if (fs.existsSync(bin)) return bin;
      } else {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        return execFileSync(cmd, [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString().split(/\r?\n/)[0].trim();
      }
    } catch { /* try next */ }
  }
  return '';
}

// Minimal config so the Web API starts on localhost without a password.
function writeInitialConfig() {
  const dir = path.join(paths.qbitProfile, 'qBittorrent', 'config');
  const file = path.join(dir, 'qBittorrent.conf');
  fs.mkdirSync(dir, { recursive: true });
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new profile */ }
  const wanted = {
    LegalNotice: { Accepted: 'true' },
    Preferences: {
      'WebUI\\Enabled': 'true',
      'WebUI\\Address': '127.0.0.1',
      'WebUI\\Port': String(config.qbitPort),
      'WebUI\\LocalHostAuth': 'false',
      'WebUI\\HostHeaderValidation': 'false',
      'WebUI\\CSRFProtection': 'false',
      'General\\CloseToTray': 'false',
      'General\\StartMinimized': 'true',
      'General\\NoSplashScreen': 'true',
    },
    BitTorrent: {
      'Session\\DefaultSavePath': paths.downloads,
      'Session\\TempPathEnabled': 'false',
    },
  };
  const sections = {};
  let current = '';
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\[(.+)\]$/);
    if (m) { current = m[1]; sections[current] ||= {}; continue; }
    const eq = line.indexOf('=');
    if (eq > 0 && current) sections[current][line.slice(0, eq)] = line.slice(eq + 1);
  }
  for (const [sec, values] of Object.entries(wanted)) {
    sections[sec] = { ...(sections[sec] || {}), ...values };
  }
  const out = Object.entries(sections)
    .map(([sec, values]) => `[${sec}]\n` + Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n'))
    .join('\n\n') + '\n';
  fs.writeFileSync(file, out, { mode: 0o600 });
}

async function call(endpoint, { method = 'GET', form, body, query, raw = false } = {}) {
  let url = `${BASE}/${endpoint}`;
  if (query) url += '?' + new URLSearchParams(query);
  const opts = { method, headers: { Referer: `http://127.0.0.1:${config.qbitPort}/` } };
  if (cookie) opts.headers.Cookie = cookie;
  if (form) {
    opts.method = 'POST';
    opts.body = new URLSearchParams(form);
  } else if (body) {
    opts.method = 'POST';
    opts.body = body;
  }
  const res = await fetch(url, opts);
  if (res.status === 403 && endpoint !== 'auth/login') {
    throw new Error('qBittorrent refused the request (authentication)');
  }
  if (!res.ok) {
    const msg = (await res.text()).slice(0, 200);
    throw new Error(`qBittorrent ${endpoint} failed: HTTP ${res.status} ${msg}`);
  }
  if (raw) return res;
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

async function isUp() {
  try {
    await call('app/version');
    return true;
  } catch {
    return false;
  }
}

async function waitUntilUp(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await isUp()) return true;
    if (child && child.exitCode !== null) return false;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

async function configure() {
  await call('app/setPreferences', {
    form: {
      json: JSON.stringify({
        save_path: paths.downloads,
        temp_path_enabled: false,
        auto_tmm_enabled: true,
        torrent_changed_tmm_enabled: true,
        category_changed_tmm_enabled: true,
        bypass_local_auth: true,
        web_ui_address: '127.0.0.1',
        ...(config.torrentingPort ? { listen_port: config.torrentingPort } : {}),
      }),
    },
  });
  const existing = await call('torrents/categories').catch(() => ({}));
  for (const cat of CATEGORIES) {
    const savePath = path.join(paths.downloads, cat);
    const endpoint = existing[cat] ? 'torrents/editCategory' : 'torrents/createCategory';
    await call(endpoint, { form: { category: cat, savePath } }).catch(() => {});
  }
}

// Which profile does the qBittorrent on our port use? qBittorrent logs its
// config directory at startup; fall back to the save path if the log rotated.
async function instanceProfile() {
  const log = await call('log/main', { query: { normal: 'true', info: 'true', warning: 'true', critical: 'true' } }).catch(() => []);
  const line = log.find(l => /Using config directory: /.test(l.message));
  if (line) {
    const dir = line.message.split('Using config directory: ')[1].trim();
    return path.resolve(dir, '..', '..'); // <profile>/qBittorrent/config -> <profile>
  }
  const prefs = await call('app/preferences').catch(() => ({}));
  return path.resolve(prefs.save_path || '') === path.resolve(paths.downloads) ? path.resolve(paths.qbitProfile) : '';
}

async function start() {
  if (await isUp()) {
    // A previous run may have left our instance alive; reuse it, but only if
    // it really is ours (another qBittorrent could be using this port).
    const owner = await instanceProfile();
    if (owner !== path.resolve(paths.qbitProfile)) {
      lastError = `Port ${config.qbitPort} is used by another qBittorrent (${owner || 'unknown profile'}). `
        + 'Quit it or set a different "qbitPort" in the Cineteca config.';
      throw new Error(lastError);
    }
    await configure();
    return { reused: true };
  }
  const bin = findBinary();
  if (!bin) {
    lastError = 'qBittorrent was not found. Install it from https://www.qbittorrent.org/download (qbittorrent-nox recommended).';
    throw new Error(lastError);
  }
  writeInitialConfig();
  const args = [`--profile=${paths.qbitProfile}`, `--webui-port=${config.qbitPort}`, '--confirm-legal-notice'];
  if (config.torrentingPort) args.push(`--torrenting-port=${config.torrentingPort}`);
  const env = { ...process.env };
  if (!/nox/i.test(path.basename(bin))) {
    // The desktop build has no headless switch; render it off-screen.
    env.QT_QPA_PLATFORM = 'offscreen';
    args.push('--no-splash');
  }
  child = spawn(bin, args, { env, stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  binaryInUse = bin;
  let stderr = '';
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
  child.on('exit', code => {
    if (code) lastError = `qBittorrent exited with code ${code}: ${stderr.trim()}`;
    child = null;
  });
  if (!(await waitUntilUp(30000))) {
    lastError ||= 'qBittorrent did not start its Web API in time. ' + stderr.trim();
    throw new Error(lastError);
  }
  await configure();
  return { reused: false };
}

async function stop() {
  try { await call('app/shutdown', { method: 'POST' }); } catch { /* already gone */ }
  if (child) {
    const proc = child;
    await new Promise(resolve => {
      const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 8000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}

async function status() {
  try {
    const [version, transfer] = await Promise.all([call('app/version'), call('transfer/info')]);
    return { running: true, version, binary: binaryInUse, transfer };
  } catch (e) {
    return { running: false, error: lastError || e.message };
  }
}

module.exports = { call, start, stop, status, isUp };
