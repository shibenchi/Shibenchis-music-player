import { frontendLog, isAndroidApp, isTauriApp, recolorShortcuts } from './tauriApi';

// the app icon: a record, and nothing else. drawn here so it can take the
// person's theme color. it is the same drawing as the launcher icon and the
// installer icon (src-tauri/icons/source/record.svg), on a 108 x 108 grid with the
// record a circle of radius 31 around the middle

const shapes = (accent) => [
  { d: 'M23,54 a31,31 0 1 0 62,0 a31,31 0 1 0 -62,0 Z', fill: '#0b0b0d', stroke: accent, width: 2.6 },
  { d: 'M28,54 a26,26 0 1 0 52,0 a26,26 0 1 0 -52,0 Z', fill: null, stroke: '#25252a', width: 0.9 },
  { d: 'M33,54 a21,21 0 1 0 42,0 a21,21 0 1 0 -42,0 Z', fill: null, stroke: '#25252a', width: 0.9 },
  { d: 'M38,54 a16,16 0 1 0 32,0 a16,16 0 1 0 -32,0 Z', fill: null, stroke: '#25252a', width: 0.9 },
  { d: 'M43,54 a11,11 0 1 0 22,0 a11,11 0 1 0 -22,0 Z', fill: accent },
  { d: 'M51.8,54 a2.2,2.2 0 1 0 4.4,0 a2.2,2.2 0 1 0 -4.4,0 Z', fill: '#0b0b0d' }
];

// the picture as a canvas, with nothing behind the record. adaptive is the layer
// android cuts its own shape out of, which has to stay inside the middle of the
// grid. otherwise the record is drawn bigger, for a window or a tab
function drawIcon(size, color, adaptive) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const accent = `rgb(${color.r}, ${color.g}, ${color.b})`;
  ctx.scale(size / 108, size / 108);
  if (!adaptive) {
    ctx.translate(54, 54);
    ctx.scale(1.55, 1.55);
    ctx.translate(-54, -54);
  }
  shapes(accent).forEach((shape) => {
    const path = new Path2D(shape.d);
    if (shape.fill) {
      ctx.fillStyle = shape.fill;
      ctx.fill(path);
    }
    if (shape.stroke) {
      ctx.strokeStyle = shape.stroke;
      ctx.lineWidth = shape.width;
      ctx.lineCap = shape.cap || 'butt';
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    }
  });
  return canvas;
}

const toBytes = (canvas) => new Promise((resolve) => {
  canvas.toBlob(async (blob) => {
    if (!blob) { resolve(null); return; }
    resolve(new Uint8Array(await blob.arrayBuffer()));
  }, 'image/png');
});

const toBase64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

// the home screen icon on the phone. when the app's shortcut is already on the
// home screen it is updated in place, so a new theme color changes it without it
// ever disappearing. pin = true also asks android to put one there (the system
// shows its own box to confirm)
export async function setHomeScreenIcon(color, pin = false) {
  if (!isAndroidApp() || !window.SmpNative || typeof window.SmpNative.setShortcutIcon !== 'function') return false;
  try {
    const bytes = await toBytes(drawIcon(432, color, true));
    if (!bytes) return false;
    return Boolean(window.SmpNative.setShortcutIcon(toBase64(bytes), pin));
  } catch {
    return false;
  }
}

// the launcher icon itself (the app drawer): android cannot redraw it, so the app
// has twelve colored copies and switches which one is on. it waits until the color
// has stopped changing, a slider drag would otherwise flip the icon over and over
let launcherTimer = null;
function scheduleLauncherIcon(color) {
  clearTimeout(launcherTimer);
  launcherTimer = setTimeout(() => {
    try {
      if (window.SmpNative && typeof window.SmpNative.setLauncherIcon === 'function') {
        window.SmpNative.setLauncherIcon(color.r, color.g, color.b);
      }
    } catch {
      // the icon stays as it was
    }
  }, 700);
}

// the icon on the computer's window (taskbar and title bar), the browser tab, and
// on the phone both the launcher icon and the home screen shortcut
export async function applyAppIconColor(color) {
  try {
    if (isAndroidApp()) {
      scheduleLauncherIcon(color);
      await setHomeScreenIcon(color, false);
      return;
    }
    const canvas = drawIcon(128, color, false);
    const link = document.querySelector("link[rel~='icon']");
    if (link) link.href = canvas.toDataURL('image/png');
    if (await isTauriApp()) {
      const bytes = await toBytes(canvas);
      if (!bytes) return;
      // the window (title bar and taskbar button while it is open)
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().setIcon(bytes);
      } catch (err) {
        frontendLog('appIcon', `window icon not changed: ${err?.message || err}`);
      }
      // the desktop shortcut and the taskbar pin, which are files with an icon of their own
      await recolorShortcuts(bytes, `${color.r}-${color.g}-${color.b}`);
    }
  } catch {
    // an icon that does not change is no reason to complain
  }
}
