'use strict';
// Desktop shell: runs the Cineteca server (which starts qBittorrent in the
// background), shows it in a native window and keeps serving the network
// from the system tray when the window is closed.
const path = require('path');
const { app, BrowserWindow, Tray, Menu, shell, clipboard, dialog, Notification, nativeImage, ipcMain } = require('electron');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let server;
let info;
let win = null;
let tray = null;
let quitting = false;
let notifiedBackground = false;

const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));

function createWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 420, minHeight: 500,
    backgroundColor: '#0d1017', title: 'Cineteca', icon, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadURL(info.local);
  // Links to other sites open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(info.local)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!notifiedBackground && Notification.isSupported()) {
      notifiedBackground = true;
      new Notification({
        title: 'Cineteca is still running',
        body: 'Downloads continue and other devices can keep watching. Open Cineteca again or use the tray icon to quit.',
        icon,
      }).show();
    }
  });
  win.on('closed', () => { win = null; });
}

function createTray() {
  tray = new Tray(icon.resize({ width: 22, height: 22 }));
  tray.setToolTip('Cineteca');
  const lan = info.urls[0]?.url;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Cineteca', click: createWindow },
    { label: 'Open in web browser', click: () => shell.openExternal(info.local) },
    { label: lan ? `Copy network address (${lan})` : 'No network connection', enabled: !!lan, click: () => clipboard.writeText(lan) },
    { type: 'separator' },
    { label: 'Quit Cineteca', click: quit },
  ]));
  tray.on('click', createWindow);
}

async function quit() {
  if (quitting) return;
  quitting = true;
  tray?.destroy();
  win?.destroy();
  try { await server.stop(); } catch (e) { console.error(e); }
  app.exit(0);
}

app.on('second-instance', () => { if (info) createWindow(); });
app.on('activate', () => { if (info) createWindow(); });
app.on('window-all-closed', () => { /* keep running in the background */ });
app.on('before-quit', e => {
  if (!quitting) { e.preventDefault(); quit(); }
});
ipcMain.on('cineteca:quit', quit);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, quit);

app.whenReady().then(async () => {
  try {
    server = require('../server');
    info = await server.start();
  } catch (e) {
    dialog.showErrorBox('Cineteca could not start', e.message);
    app.exit(1);
    return;
  }
  if (info.qbitError) {
    dialog.showMessageBox({
      type: 'warning', title: 'qBittorrent is missing', icon,
      message: 'Cineteca needs qBittorrent to download.',
      detail: `${info.qbitError}\n\nAfter installing it, restart Cineteca.`,
      buttons: ['Open qbittorrent.org', 'Later'],
    }).then(r => { if (r.response === 0) shell.openExternal('https://www.qbittorrent.org/download'); });
  }
  createTray();
  if (!process.argv.includes('--hidden')) createWindow();
});
