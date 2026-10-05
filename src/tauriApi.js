// thin wrapper around the tauri v2 js api, used by the main window to talk
// to the miniplayer. no-ops completely in a browser/pwa context (where
// @tauri-apps/api exists as a dep but theres no actual tauri runtime
// backing it) and in the miniplayer itself (which just uses these events
// directly via Miniplayer.js instead)

let cachedApi = null;
let cachedIsTauri = null;

// writes into the same rust_debug.log file the rust side uses, via the
// frontend_log command, so ONE trace shows both sides of whatever just
// happened instead of me trying to guess from a vague description of what
// broke. goes through the same imported api this file already uses
// (cachedApi), NOT window.__TAURI__ - that global is only reliable on
// plain unbundled pages, using it here just silently no-ops even when the
// api's totally fine, which is somehow worse than not logging at all
export function frontendLog(source, message) {
  if (!cachedApi?.invoke) return;
  cachedApi.invoke('frontend_log', { source, message }).catch(() => {});
}

async function loadApi() {
  if (cachedIsTauri === null) {
    try {
      const core = await import('@tauri-apps/api/core');
      cachedIsTauri = core.isTauri();
      if (cachedIsTauri) {
        const event = await import('@tauri-apps/api/event');
        cachedApi = { ...core, ...event };
        frontendLog('tauriApi', 'loadApi: ready');
      }
    } catch (err) {
      cachedIsTauri = false;
      // cant log this one to the file lol, the api that wouldve carried it
      // is literally the thing that just failed. console it is
      console.error('tauriApi loadApi failed:', err);
    }
  }
  return cachedApi;
}

export async function isTauriApp() {
  await loadApi();
  return !!cachedIsTauri;
}

// native "save as" dialog, writes the bytes wherever they pick. returns
// the path, or null if they cancelled. separate try/catch from loadApi()
// bc these are their own plugins (dialog/fs), not the core api
export async function saveFileWithDialog(suggestedName, bytes) {
  const isTauri = await isTauriApp();
  if (!isTauri) return null;
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: suggestedName });
    if (!path) return null; // they bailed
    await writeFile(path, bytes);
    frontendLog('tauriApi', `saveFileWithDialog: wrote ${bytes.length} bytes to ${path}`);
    return path;
  } catch (err) {
    frontendLog('tauriApi', `saveFileWithDialog FAILED: ${err?.message || err}`);
    throw err;
  }
}

// os "downloads" folder + a subfolder, resolved fresh every time. this is
// the default for the downloads-folder setting until i pick something
// else myself, so a fresh install has somewhere sane to save to without
// ever popping a dialog
export async function getDefaultDownloadsDir() {
  const isTauri = await isTauriApp();
  if (!isTauri) return null;
  try {
    const { downloadDir, join } = await import('@tauri-apps/api/path');
    const base = await downloadDir();
    return await join(base, 'SMP Downloads');
  } catch (err) {
    frontendLog('tauriApi', `getDefaultDownloadsDir FAILED: ${err?.message || err}`);
    return null;
  }
}

// native folder picker for the "downloads folder" setting
export async function chooseDownloadsFolder(currentPath) {
  const isTauri = await isTauriApp();
  if (!isTauri) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, defaultPath: currentPath || undefined });
    return picked || null; // bailed
  } catch (err) {
    frontendLog('tauriApi', `chooseDownloadsFolder FAILED: ${err?.message || err}`);
    return null;
  }
}

// native "open" dialog for picking a single file to read (playlist
// import), as opposed to saveFileWithDialog's "save as". no-ops outside
// tauri like everything else here - the browser path (a plain <input
// type="file">) lives in App.js itself since it needs no tauri api at all
export async function pickTextFile(extensions) {
  const isTauri = await isTauriApp();
  if (!isTauri) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await open({
      multiple: false,
      filters: [{ name: 'playlist', extensions }]
    });
    if (!path || typeof path !== 'string') return null; // bailed
    const text = await readTextFile(path);
    const name = path.split(/[\\/]/).pop() || path;
    frontendLog('tauriApi', `pickTextFile: read ${text.length} chars from ${path}`);
    return { name, text };
  } catch (err) {
    frontendLog('tauriApi', `pickTextFile FAILED: ${err?.message || err}`);
    throw err;
  }
}

// writes straight into whatever folder is configured, NO per-download
// dialog anymore (thank god). makes the folder first if it doesnt exist
// yet - the default "SMP Downloads" subfolder wont until the first
// actual download happens
export async function saveFileToFolder(folderPath, suggestedName, bytes) {
  const isTauri = await isTauriApp();
  if (!isTauri || !folderPath) return null;
  try {
    const { join } = await import('@tauri-apps/api/path');
    const { writeFile, mkdir, exists } = await import('@tauri-apps/plugin-fs');
    const fullPath = await join(folderPath, suggestedName);
    const alreadyThere = await exists(folderPath).catch(() => false);
    if (!alreadyThere) {
      await mkdir(folderPath, { recursive: true });
    }
    await writeFile(fullPath, bytes);
    frontendLog('tauriApi', `saveFileToFolder: wrote ${bytes.length} bytes to ${fullPath}`);
    return fullPath;
  } catch (err) {
    frontendLog('tauriApi', `saveFileToFolder FAILED: ${err?.message || err}`);
    throw err;
  }
}

// fires once, right after the first-run welcome popup, with whatever i
// picked there. desktop shortcut gets made unconditionally by the wix
// installer, so "off" here just means go delete it; taskbar pin never
// gets made at all unless this says yes. no-ops outside tauri obviously
export async function applyShortcutPrefs(desktop, taskbar) {
  const api = await loadApi();
  if (!api) return;
  frontendLog('tauriApi', `applyShortcutPrefs: desktop=${desktop} taskbar=${taskbar}`);
  api.invoke('apply_shortcut_prefs', { desktop, taskbar }).catch((err) => {
    frontendLog('tauriApi', `applyShortcutPrefs FAILED: ${err?.message || err}`);
  });
}

// the desktop and taskbar shortcuts carry their own icon file, so a new theme
// color has to be written into them (rust does the writing, windows only)
export async function recolorShortcuts(pngBytes, key) {
  const api = await loadApi();
  if (!api) return;
  try {
    await api.invoke('set_shortcut_icon', { png: Array.from(pngBytes), key });
  } catch (err) {
    frontendLog('tauriApi', `recolorShortcuts FAILED: ${err?.message || err}`);
  }
}

// external links (ko-fi, etc) - a plain <a target="_blank"> silently does
// nothing inside the tauri webview, theres no "open in system browser"
// behavior for it to fall back on like a real browser tab has. has to go
// through the opener plugin explicitly instead. no-ops-to-window.open in a
// plain browser/pwa context, same pattern as everything else in this file
export async function openExternalUrl(url) {
  const isTauri = await isTauriApp();
  if (!isTauri) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch (err) {
    frontendLog('tauriApi', `openExternalUrl FAILED for ${url}: ${err?.message || err}`);
  }
}

// whether the mini player window may show up at all (the setting). the desktop
// app only, the phone has its own switch
export async function setMiniplayerEnabled(enabled) {
  if (isAndroidApp()) return;
  const api = await loadApi();
  if (!api) return;
  api.invoke('set_miniplayer_enabled', { enabled }).catch((err) => {
    frontendLog('tauriApi', `setMiniplayerEnabled FAILED: ${err?.message || err}`);
  });
}

export async function toggleMiniplayer() {
  const api = await loadApi();
  if (!api) {
    frontendLog('tauriApi', 'toggleMiniplayer: no api, aborting');
    return;
  }
  frontendLog('tauriApi', 'toggleMiniplayer: invoking toggle_miniplayer');
  api.invoke('toggle_miniplayer');
}

// the android app. its notification, home screen widget and floating (picture in
// picture) player are native, and the native side hands the page a
// window.SmpNative to report to. checked each time rather than once, it can
// show up a moment after the page starts
export function isAndroidApp() {
  return typeof window !== 'undefined' && !!window.SmpNative;
}

let lastNativeReport = { key: '', pos: 0, at: 0, playing: false };

// tells the native side what is playing. sendNowPlaying runs several times a
// second while music plays, so this only passes it on when something real
// changed (track, play or pause), when the position jumped (a seek), or every
// ten seconds so the notification's progress bar cannot drift
function reportToAndroid(state) {
  if (!isAndroidApp() || !window.SmpNative.updateState) return;
  const hasTrack = !!(state && state.title);
  const position = (state && state.currentTime) || 0;
  const now = Date.now();
  const key = [hasTrack, state?.title, state?.author, state?.thumbnail, !!state?.isPlaying, Math.round(state?.duration || 0), !!state?.shuffle, state?.repeat, state?.muted ? 'm' : Math.round((state?.volume ?? 1) * 100), !!state?.inRoom, !!state?.isBuffering].join('|');
  const expected = lastNativeReport.pos + (lastNativeReport.playing ? (now - lastNativeReport.at) / 1000 : 0);
  const jumped = Math.abs(position - expected) > 2.5;
  if (key === lastNativeReport.key && !jumped && now - lastNativeReport.at < 10000) return;
  lastNativeReport = { key, pos: position, at: now, playing: !!state?.isPlaying };
  const color = state?.themeColor;
  try {
    window.SmpNative.updateState(JSON.stringify({
      hasTrack,
      title: state?.title || '',
      artist: state?.author || '',
      thumb: state?.thumbnail || '',
      playing: !!state?.isPlaying,
      pos: position,
      dur: state?.duration || 0,
      shuffle: !!state?.shuffle,
      repeat: state?.repeat || 'off',
      volume: typeof state?.volume === 'number' ? state.volume : 1,
      muted: !!state?.muted,
      inRoom: !!state?.inRoom,
      // getting a song ready (between two songs the app is not playing but it is busy), the
      // phone keeps the app in the foreground for as long as this is true
      loading: !!state?.isBuffering,
      accent: color ? [color.r, color.g, color.b] : undefined
    }));
  } catch (err) {
    frontendLog('tauriApi', `reportToAndroid failed: ${err?.message || err}`);
  }
}

// the floating player window opening or closing. returns an unsubscribe fn
export function onPictureInPicture(callback) {
  if (typeof window === 'undefined') return () => {};
  window.__smpPip = (on) => callback(!!on);
  // the page may load while the window is already small
  try {
    if (isAndroidApp() && window.SmpNative.inPip && window.SmpNative.inPip()) callback(true);
  } catch {}
  return () => { delete window.__smpPip; };
}

export async function sendNowPlaying(state) {
  reportToAndroid(state);
  const api = await loadApi();
  if (!api) return;
  api.emitTo('miniplayer', 'now-playing-update', state).catch((err) => {
    // miniplayer's just not open, nothing to send it to, whatever, thats
    // fine. still logging it (quietly) tho since a real permissions error
    // would look identical and id rather have the trace than not
    frontendLog('tauriApi', `sendNowPlaying: emitTo rejected - ${err?.message || err}`);
  });
}

// fires a LOT (several times a sec) whenever the miniplayer's open, unlike
// sendNowPlaying - deliberately not logging rejections here, miniplayer
// just being closed is the normal case and logging that every frame would
// flood the file with noise for something that isnt even an error
export async function sendVisualizerFrame(frame) {
  const api = await loadApi();
  if (!api) return;
  api.emitTo('miniplayer', 'visualizer-frame', frame).catch(() => {});
}

// returns an unsubscribe fn (async since listen() itself is async)
export function onMiniplayerControl(callback) {
  let unlisten = null;
  let cancelled = false;

  // on android the notification, the widget and the floating player send their
  // button presses here, and they map onto the same actions the desktop mini
  // player sends
  const nativeCommand = (command, arg) => {
    if (['previous', 'next', 'play', 'pause', 'shuffle', 'repeat', 'mute', 'volume_up', 'volume_down'].includes(command)) callback(command);
    else if (command === 'seek') callback({ type: 'seek', percent: arg });
  };
  if (typeof window !== 'undefined') window.__smpNativeCommand = nativeCommand;

  loadApi().then((api) => {
    if (!api || cancelled) return;
    api.listen('miniplayer-control', (event) => {
      frontendLog('tauriApi', `onMiniplayerControl: received ${event.payload}`);
      callback(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
  });

  return () => {
    cancelled = true;
    if (unlisten) unlisten();
    if (typeof window !== 'undefined' && window.__smpNativeCommand === nativeCommand) delete window.__smpNativeCommand;
  };
}

// miniplayer window only exists for like a split second before it
// announces itself - without this it just sits on "nothing playing"
// until whatever's already playing happens to tick over on its own
// (track change, progress tick, theme change), which couldve been ages
export function onMiniplayerReady(callback) {
  let unlisten = null;
  let cancelled = false;

  loadApi().then((api) => {
    if (!api || cancelled) return;
    api.listen('miniplayer-ready', () => {
      frontendLog('tauriApi', 'onMiniplayerReady: received');
      callback();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
  });

  return () => {
    cancelled = true;
    if (unlisten) unlisten();
  };
}

export async function announceMiniplayerReady() {
  const api = await loadApi();
  if (!api) {
    frontendLog('tauriApi', 'announceMiniplayerReady: no api, aborting');
    return;
  }
  frontendLog('tauriApi', 'announceMiniplayerReady: emitting miniplayer-ready to main');
  api.emitTo('main', 'miniplayer-ready', null).catch((err) => {
    frontendLog('tauriApi', `announceMiniplayerReady: emitTo rejected - ${err?.message || err}`);
  });
}
