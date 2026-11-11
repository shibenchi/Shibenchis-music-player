// how big the whole interface is. on a computer (the desktop app) it follows ctrl and plus or minus, ctrl 0 puts it back to normal, and ctrl with the
// mouse wheel does the same; the phone has a setting. it is css zoom on the page, remembered on this device. zoom also scales the viewport
// units (a box of 100vh would come out 100vh times the zoom), so the few places that use vh or vw go through --vh and --vw (index.css), which
// are divided by --ui-scale

const KEY = 'music_ui_scale';
export const SCALE_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const MIN = 0.5;
const MAX = 2.5;

export function getUiScale() {
  try {
    const value = parseFloat(window.localStorage.getItem(KEY));
    return value >= MIN && value <= MAX ? value : 1;
  } catch {
    return 1;
  }
}

export function applyUiScale(scale) {
  const root = document.documentElement;
  root.style.zoom = scale === 1 ? '' : String(scale);
  root.style.setProperty('--ui-scale', String(scale));
}

// the scale as a whole percent, for showing
export const scalePercent = (scale) => `${Math.round(scale * 100)}%`;

export function setUiScale(scale) {
  const next = Math.max(MIN, Math.min(MAX, Math.round(scale * 100) / 100));
  applyUiScale(next);
  try {
    if (next === 1) window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, String(next));
  } catch {
    // not remembered after a restart
  }
  window.dispatchEvent(new CustomEvent('smp-ui-scale', { detail: next }));
  return next;
}

// one step bigger (+1) or smaller (-1) along SCALE_STEPS, from whatever the scale is now
export function stepUiScale(direction) {
  const current = getUiScale();
  const next = direction > 0 ? SCALE_STEPS.find((step) => step > current + 0.004) : [...SCALE_STEPS].reverse().find((step) => step < current - 0.004);
  return setUiScale(next === undefined ? current : next);
}

const isDesktopApp = () => typeof window !== 'undefined' && Boolean(window.isTauri || window.__TAURI_INTERNALS__) && !window.SmpNative;

// called once when the app starts: puts the remembered size on, and on the desktop app listens for the keys and the wheel
export function initUiScale() {
  applyUiScale(getUiScale());
  if (!isDesktopApp()) return;
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key;
    if (key === '+' || key === '=' || key === 'Add') { event.preventDefault(); stepUiScale(1); }
    else if (key === '-' || key === '_' || key === 'Subtract') { event.preventDefault(); stepUiScale(-1); }
    else if (key === '0' || key === 'Insert') { event.preventDefault(); setUiScale(1); }
  }, true);
  // a touchpad sends a stream of wheel events for one pinch: one step per 180 ms
  let lastWheel = 0;
  window.addEventListener('wheel', (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const now = Date.now();
    if (now - lastWheel < 180) return;
    lastWheel = now;
    stepUiScale(event.deltaY < 0 ? 1 : -1);
  }, { passive: false, capture: true });
}
