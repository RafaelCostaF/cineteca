// Renders promo.html to docs/promo.mp4 and docs/promo.gif.
// Usage: npx electron docs/promo/render.js   (needs ffmpeg with libx264)
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FPS = 30;
const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'cineteca-promo-'));
const docs = path.join(__dirname, '..');

app.setPath('userData', path.join(frames, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 720, show: false, webPreferences: { offscreen: true } });
  await win.loadFile(path.join(__dirname, 'promo.html'));
  await new Promise(r => setTimeout(r, 500));
  const total = await win.webContents.executeJavaScript('DURATION') * FPS;
  for (let i = 0; i < total; i++) {
    await win.webContents.executeJavaScript(`seek(${i / FPS})`);
    await new Promise(r => setTimeout(r, 20));
    const png = (await win.capturePage()).resize({ width: 1920, height: 1080, quality: 'best' }).toPNG();
    fs.writeFileSync(path.join(frames, `f${String(i).padStart(4, '0')}.png`), png);
  }
  const input = ['-y', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png')];
  execFileSync('ffmpeg', [...input, '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', path.join(docs, 'promo.mp4')], { stdio: 'inherit' });
  execFileSync('ffmpeg', [...input, '-vf', 'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer',
    path.join(docs, 'promo.gif')], { stdio: 'inherit' });
  fs.rmSync(frames, { recursive: true, force: true });
  app.quit();
});
