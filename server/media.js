'use strict';
// Playback helpers built on ffmpeg/ffprobe: codec detection, on-the-fly
// remux/transcode for devices that cannot play a file directly, subtitle
// conversion to WebVTT and thumbnails.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const os = require('os');
const { paths } = require('./config');

// Prefer a full ffmpeg build in CINETECA_FFMPEG_DIR or ~/.local/bin over the
// system one: distro builds like Fedora's ffmpeg-free cannot decode HEVC.
// Checked explicitly because apps started from the menu often lack ~/.local/bin in PATH.
function tool(name) {
  for (const dir of [process.env.CINETECA_FFMPEG_DIR, path.join(os.homedir(), '.local', 'bin')]) {
    const p = dir && path.join(dir, name);
    try { if (p) { fs.accessSync(p, fs.constants.X_OK); return p; } } catch { /* not there */ }
  }
  return name;
}
const FFMPEG = tool('ffmpeg');
const FFPROBE = tool('ffprobe');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.wmv', '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.ogv', '.3gp']);
const BOOK_EXT = new Set(['.epub', '.pdf', '.mobi', '.azw3', '.cbz', '.cbr', '.djvu', '.txt']);
const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub']);
const AUDIO_EXT = new Set(['.mp3', '.flac', '.ogg', '.m4a', '.wav', '.opus']);

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t',
  '.ogv': 'video/ogg', '.3gp': 'video/3gpp', '.epub': 'application/epub+zip', '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.srt': 'application/x-subrip', '.vtt': 'text/vtt', '.txt': 'text/plain',
};

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (BOOK_EXT.has(ext)) return 'book';
  if (SUB_EXT.has(ext)) return 'subtitle';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'other';
}

const mimeOf = name => MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';

// Resolve a path and make sure it stays inside the downloads folder.
function safePath(p) {
  const resolved = path.resolve(p);
  const root = path.resolve(paths.downloads) + path.sep;
  if (!resolved.startsWith(root)) throw new Error('Path is outside the cripto downloads folder');
  return resolved;
}

const probeCache = new Map();

function probe(file) {
  const stat = fs.statSync(file);
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (probeCache.has(key)) return Promise.resolve(probeCache.get(key));
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
        if (err) return reject(new Error('ffprobe could not read this file (is ffmpeg installed?)'));
        const info = JSON.parse(stdout);
        const streams = info.streams || [];
        const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
        const lang = s => s.tags?.language || '';
        const title = s => s.tags?.title || '';
        const result = {
          duration: Number(info.format?.duration) || 0,
          container: info.format?.format_name || '',
          video: video ? { codec: video.codec_name, pixFmt: video.pix_fmt || '', width: video.width, height: video.height } : null,
          audio: streams.filter(s => s.codec_type === 'audio')
            .map((s, i) => ({ index: i, codec: s.codec_name, channels: s.channels, language: lang(s), title: title(s), default: !!s.disposition?.default })),
          subtitles: streams.filter(s => s.codec_type === 'subtitle')
            .map((s, i) => ({ index: i, codec: s.codec_name, language: lang(s), title: title(s),
              text: ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'].includes(s.codec_name) })),
        };
        result.mode = chooseMode(file, result);
        probeCache.set(key, result);
        resolve(result);
      });
  });
}

const BROWSER_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

// direct    = the device gets the original file (seekable, no CPU cost)
// remux     = video copied as-is into fragmented MP4, audio converted if needed
// transcode = full conversion to H.264/AAC (works everywhere, uses CPU)
function chooseMode(file, info) {
  const ext = path.extname(file).toLowerCase();
  const v = info.video;
  if (!v) return 'transcode';
  const tenBit = /10|12/.test(v.pixFmt);
  const audioOk = info.audio.length === 0 || BROWSER_AUDIO.has(info.audio[0].codec);
  if (['.mp4', '.m4v', '.webm', '.mov'].includes(ext) && BROWSER_VIDEO.has(v.codec) && !tenBit && audioOk) return 'direct';
  if (v.codec === 'h264' && !tenBit) return 'remux';
  return 'transcode';
}

// Pick an H.264 encoder that actually works on this machine. Many distro
// builds (e.g. Fedora's ffmpeg-free) ship OpenH264 instead of x264.
let encoder = null;
function detectEncoder() {
  for (const name of ['libx264', 'libopenh264']) {
    try {
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=128x72:rate=1',
        '-frames:v', '1', '-c:v', name, '-f', 'null', '-'], { stdio: 'ignore', timeout: 15000 });
      return name;
    } catch { /* not available */ }
  }
  return '';
}

function h264Args() {
  encoder ??= detectEncoder();
  const scale = ['-pix_fmt', 'yuv420p', '-vf', "scale='trunc(min(1920,iw)/2)*2':-2"];
  if (encoder === 'libx264') return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', ...scale];
  if (encoder === 'libopenh264') return ['-c:v', 'libopenh264', '-b:v', '5M', '-maxrate', '8M', '-allow_skip_frames', '1', ...scale];
  throw new Error('ffmpeg has no H.264 encoder (install ffmpeg with libx264 or OpenH264)');
}

// Streams `file` as fragmented MP4 starting at `start` seconds.
function stream(file, { mode, start = 0, audio = 0 }, req, res) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', file, '-map', '0:v:0', '-map', `0:a:${audio}?`, '-sn', '-dn');
  if (mode === 'remux') {
    args.push('-c:v', 'copy');
  } else {
    args.push(...h264Args(), '-g', '96');
  }
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');

  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  ff.stderr.on('data', d => { err = (err + d).slice(-1000); });
  ff.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'ffmpeg is not installed' }); });
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'transferMode.dlna.org': 'Streaming',
  });
  ff.stdout.pipe(res);
  const kill = () => { try { ff.kill('SIGKILL'); } catch { /* exited */ } };
  req.on('close', kill);
  ff.on('close', code => {
    if (code && err && !res.writableEnded) console.error('[ffmpeg]', err.trim());
    res.end();
  });
}

// HLS sessions for iPhone/iPad Safari, which cannot play the progressive
// fragmented-MP4 stream above. Segments are written inside the cripto folder.
const HLS_DIR = path.join(paths.state, 'hls');
fs.rmSync(HLS_DIR, { recursive: true, force: true });
fs.mkdirSync(HLS_DIR, { recursive: true });
const hlsSessions = new Map();

function hlsStart(file, { mode, start = 0, audio = 0, client }) {
  for (const [id, s] of hlsSessions) if (s.client === client) hlsStop(id);
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(HLS_DIR, id);
  fs.mkdirSync(dir);
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', file, '-map', '0:v:0', '-map', `0:a:${audio}?`, '-sn', '-dn');
  if (mode === 'remux') args.push('-c:v', 'copy');
  else {
    args.push(...h264Args(), '-force_key_frames', 'expr:gte(t,n_forced*4)');
  }
  args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k', '-f', 'hls', '-hls_time', '4',
    '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8'));
  const ff = spawn(FFMPEG, args, { stdio: 'ignore' });
  ff.on('error', () => {});
  hlsSessions.set(id, { ff, dir, client, touched: Date.now() });
  return new Promise((resolve, reject) => {
    const begin = Date.now();
    const check = () => {
      const playlist = path.join(dir, 'index.m3u8');
      if (fs.existsSync(playlist) && /seg\d+\.ts/.test(fs.readFileSync(playlist, 'utf8'))) return resolve(id);
      if (ff.exitCode !== null || Date.now() - begin > 30000) { hlsStop(id); return reject(new Error('Could not start the stream')); }
      setTimeout(check, 300);
    };
    check();
  });
}

function hlsFile(id, name) {
  const s = hlsSessions.get(id);
  if (!s || !/^(index\.m3u8|seg\d+\.ts)$/.test(name)) return null;
  s.touched = Date.now();
  return path.join(s.dir, name);
}

function hlsStop(id) {
  const s = hlsSessions.get(id);
  if (!s) return;
  try { s.ff.kill('SIGKILL'); } catch { /* exited */ }
  fs.rmSync(s.dir, { recursive: true, force: true });
  hlsSessions.delete(id);
}

setInterval(() => {
  for (const [id, s] of hlsSessions) if (Date.now() - s.touched > 120000) hlsStop(id);
}, 30000).unref();

// Converts an embedded subtitle stream or a subtitle file to WebVTT.
function subtitles(file, { stream: streamIndex }, res) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', file];
  if (streamIndex !== undefined) args.push('-map', `0:s:${Number(streamIndex)}`);
  args.push('-f', 'webvtt', 'pipe:1');
  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  res.type('text/vtt; charset=utf-8');
  ff.stdout.pipe(res);
  ff.on('error', () => res.status(500).end());
}

function thumbnail(hash, index, file, duration) {
  const out = path.join(paths.thumbs, `${hash}-${index}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  const at = duration ? Math.min(duration * 0.1, 120) : 30;
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', file,
      '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-y', out], { timeout: 60000 }, err => {
      if (err || !fs.existsSync(out)) {
        fs.rmSync(out, { force: true });
        reject(new Error('Could not create thumbnail'));
      } else resolve(out);
    });
  });
}

function removeThumbnails(hash) {
  for (const f of fs.readdirSync(paths.thumbs)) {
    if (f.startsWith(hash + '-')) fs.rmSync(path.join(paths.thumbs, f), { force: true });
  }
}

module.exports = {
  kindOf, mimeOf, safePath, probe, stream, subtitles, thumbnail, removeThumbnails,
  hlsStart, hlsFile, hlsStop,
};
