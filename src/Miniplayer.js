import React, { useEffect, useRef, useState, useCallback } from 'react';
import { announceMiniplayerReady, frontendLog } from './tauriApi';
import Marquee from './Marquee';

// catches anything that wouldve crashed this window silently. a blank,
// totally dead miniplayer looks EXACTLY the same whether its a real bug or
// it just never mounted, so at least log it instead of staring at nothing
// wondering wtf happened (spent way too long doing that already)
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    frontendLog('miniplayer', `window error: ${e.message} at ${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    frontendLog('miniplayer', `unhandled rejection: ${e.reason?.message || e.reason}`);
  });
}

// only loads when opened w/ ?view=miniplayer (see index.js). same bundle,
// same css as the main window so the vinyl record + theme vars just work
// for free. runs in its own tauri webview, talks to the main window
// purely over the event bus, no shared react state. main window is the
// only place audio actually plays, this is just a remote

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' };
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>
);
const PrevIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
);
const NextIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" /></svg>
);
const ShuffleIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" {...stroke}><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
);
const RepeatIcon = ({ one }) => (
  <svg viewBox="0 0 24 24" width="15" height="15" {...stroke}>
    <path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" />
    {one && <path d="M11 10h1v4" />}
  </svg>
);
const VolumeIcon = ({ muted }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" {...stroke}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    {muted ? <path d="M23 9l-6 6M17 9l6 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />}
  </svg>
);
const MinusIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" {...stroke}><path d="M5 12h14" /></svg>
);
const PlusIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" {...stroke}><path d="M12 5v14M5 12h14" /></svg>
);
const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" /></svg>
);

const formatTime = (seconds) => {
  if (!seconds || Number.isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

// base size everything is laid out at, then scaled up/down uniformly to
// whatever the window actually ends up being. can get away with ONE scale
// factor (not x/y separately) bc rust locks the window to this exact
// aspect ratio now - any resize either keeps it or gets snapped back, so
// width/height always move together. keep these in step with MINI_WIDTH and
// MINI_HEIGHT in src-tauri/src/desktop.rs
const MINI_BASE_WIDTH = 300;
const MINI_BASE_HEIGHT = 150;

export default function Miniplayer() {
  const [nowPlaying, setNowPlaying] = useState(null);
  const [tauriApi, setTauriApi] = useState(null);
  const [scale, setScale] = useState(1);
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const progressBarRef = useRef(null);
  const [thumbTier, setThumbTier] = useState(0);

  useEffect(() => {
    frontendLog('miniplayer', `component mounted, __TAURI__ present: ${!!window.__TAURI__}`);
    let unlistenNowPlaying;
    let unlistenVizFrame;
    let cancelled = false;
    let receivedAnyUpdate = false;
    let vizAnimationId = 0;

    (async () => {
      try {
        const eventApi = await import('@tauri-apps/api/event');
        const coreApi = await import('@tauri-apps/api/core');
        frontendLog('miniplayer', 'imported @tauri-apps/api modules ok');
        if (cancelled) return;
        setTauriApi({ ...eventApi, ...coreApi });

        unlistenNowPlaying = await eventApi.listen('now-playing-update', (event) => {
          frontendLog('miniplayer', `now-playing-update received: ${JSON.stringify(event.payload).slice(0, 200)}`);
          receivedAnyUpdate = true;
          setNowPlaying(event.payload);
        });
        frontendLog('miniplayer', 'listen(now-playing-update) registered ok');

        // zero audio plays in this window, so this is literally the only
        // way the bg can react to the music - main window (where the real
        // analysernode lives) shoves it a downsampled snapshot every few
        // frames. drawing directly here instead of react state so it's
        // not re-rendering the whole component every single frame
        // the newest snapshot is drawn on the window's own frames. drawing
        // straight from each message drew twice in one frame when two arrived
        // together and skipped a frame when one came late
        let latestFrame = null;
        let frameSerial = 0;
        let drawnSerial = 0;
        unlistenVizFrame = await eventApi.listen('visualizer-frame', (event) => {
          latestFrame = event.payload || null;
          frameSerial += 1;
        });

        // same softening the main window uses on the bars: untouched up to
        // 0.65, then easing toward 1 instead of going flat against a ceiling
        const softCeiling = (x) => (x <= 0.65 ? x : 0.65 + 0.35 * Math.tanh((x - 0.65) / 0.35));

        const drawViz = () => {
          vizAnimationId = requestAnimationFrame(drawViz);
          if (frameSerial === drawnSerial) return;
          drawnSerial = frameSerial;
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const { baseHue, isPlaying, preset, bins, wave, bassPulse = 0 } = latestFrame || {};
          if (!isPlaying) return;

          if (preset === 'wave' && wave && wave.length > 1) {
            // the main window's wave: a wide faint stroke under a sharp one, swings
            // around the middle that grow with the bass
            const midY = canvas.height / 2;
            const swing = midY * 0.8 * (1 + bassPulse * 0.9);
            const stepX = canvas.width / (wave.length - 1);
            ctx.beginPath();
            for (let i = 0; i < wave.length; i++) {
              const y = midY + ((wave[i] - 128) / 128) * swing;
              if (i === 0) ctx.moveTo(0, y);
              else ctx.lineTo(i * stepX, y);
            }
            ctx.lineJoin = 'round';
            ctx.lineWidth = 6 + bassPulse * 6;
            ctx.strokeStyle = `hsla(${baseHue}, 85%, 60%, 0.14)`;
            ctx.stroke();
            ctx.lineWidth = 2;
            ctx.strokeStyle = `hsla(${baseHue}, 85%, 60%, 0.7)`;
            ctx.stroke();
          } else if (bins) {
            const barCount = bins.length;
            const gap = 2;
            const barWidth = canvas.width / barCount - gap;
            for (let i = 0; i < barCount; i++) {
              // the bass bars get the same extra push on a hit as in the main window
              const bassWeight = Math.max(0, 1 - i / (barCount * 0.3));
              const boosted = softCeiling((bins[i] / 255) * (1 + bassPulse * bassWeight * 2.5));
              const height = Math.max(2, boosted * canvas.height * 0.8);
              const x = i * (barWidth + gap);
              const gradient = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - height);
              gradient.addColorStop(0, `hsla(${baseHue}, 85%, 55%, 0.5)`);
              gradient.addColorStop(1, `hsla(${baseHue}, 90%, 65%, 0.1)`);
              ctx.fillStyle = gradient;
              ctx.fillRect(x, canvas.height - height, barWidth, height);
            }
          }
        };
        if (!cancelled) vizAnimationId = requestAnimationFrame(drawViz);

        // main window has literally no clue this window just opened, so
        // just ask it directly for the current state instead of sitting
        // around waiting for the next incidental update. retries once
        // after a beat if nothing comes back - on a fresh install both
        // windows are cold-booting webview2 at the same time and this can
        // straight up go out before the main window's listener is even
        // registered yet, silently dropped, no error, nothing. took
        // forever to figure out why it kept opening blank on first launch
        announceMiniplayerReady();
        setTimeout(() => {
          if (cancelled || receivedAnyUpdate) return;
          frontendLog('miniplayer', 'no now-playing-update received yet, re-announcing ready');
          announceMiniplayerReady();
        }, 1200);
      } catch (err) {
        frontendLog('miniplayer', `mount effect FAILED: ${err?.message || err}`);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(vizAnimationId);
      if (unlistenNowPlaying) unlistenNowPlaying();
      if (unlistenVizFrame) unlistenVizFrame();
    };
  }, []);

  // canvas has its own backing-store size separate from its css size, so
  // without this it just stays stretched and blurry instead of tracking
  // the real window size as you resize it. rest of the ui scales by the
  // same factor (derived from width only - height tracks 1:1 since the
  // aspect ratio's locked anyway)
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const syncSize = () => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      setScale(container.clientWidth / MINI_BASE_WIDTH);
    };
    syncSize();
    const observer = new ResizeObserver(syncSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // thumbnail url can just fail on its own sometimes (expired cdn link, a
  // res youtube never even generated for that video) - falls through to
  // safer tiers instead of showing nothing forever, resets back to tier 0
  // once the track actually changes
  useEffect(() => {
    setThumbTier(0);
  }, [nowPlaying?.videoId, nowPlaying?.thumbnail]);

  const thumbSources = [
    nowPlaying?.thumbnail,
    nowPlaying?.videoId ? `https://img.youtube.com/vi/${nowPlaying.videoId}/mqdefault.jpg` : null,
    nowPlaying?.videoId ? `https://img.youtube.com/vi/${nowPlaying.videoId}/default.jpg` : null
  ].filter(Boolean);

  // same theme color as the main window, applied to the same css vars the
  // vinyl-record styling reads from - separate window/document so it does
  // NOT inherit the main window's <html> styles automatically, learned
  // that one the hard way
  useEffect(() => {
    const c = nowPlaying?.themeColor;
    if (!c) return;
    const root = document.documentElement;
    root.style.setProperty('--theme-primary', `rgb(${c.r}, ${c.g}, ${c.b})`);
    root.style.setProperty('--theme-glow', `rgba(${c.r}, ${c.g}, ${c.b}, 0.5)`);
  }, [nowPlaying?.themeColor]);

  const sendControl = useCallback((action) => {
    frontendLog('miniplayer', `sendControl(${JSON.stringify(action)}) clicked, tauriApi ready: ${!!tauriApi}`);
    if (!tauriApi) return;
    tauriApi.emitTo('main', 'miniplayer-control', action);
  }, [tauriApi]);

  const seekFromClientX = useCallback((clientX) => {
    const bar = progressBarRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    if (!rect.width) return;
    const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    sendControl({ type: 'seek', percent });
  }, [sendControl]);

  const handleProgressPointerDown = useCallback((e) => {
    e.stopPropagation();
    seekFromClientX(e.clientX);
    const handleMove = (moveEvent) => seekFromClientX(moveEvent.clientX);
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [seekFromClientX]);

  const closeMiniplayer = useCallback(() => {
    frontendLog('miniplayer', `closeMiniplayer clicked, tauriApi ready: ${!!tauriApi}`);
    if (!tauriApi) return;
    tauriApi.invoke('toggle_miniplayer');
  }, [tauriApi]);

  const title = nowPlaying?.title || 'nothing playing';
  const author = nowPlaying?.author || 'open the main window and pick a track';
  const isPlaying = !!nowPlaying?.isPlaying;
  const duration = nowPlaying?.duration || 0;
  const currentTime = nowPlaying?.currentTime || 0;
  const progressPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const accent = nowPlaying?.themeColor
    ? `rgb(${nowPlaying.themeColor.r}, ${nowPlaying.themeColor.g}, ${nowPlaying.themeColor.b})`
    : 'var(--theme-primary, #ff5900)';
  const dim = 'rgba(255, 255, 255, 0.32)';
  const shuffleOn = !!nowPlaying?.shuffle;
  const repeatMode = nowPlaying?.repeat || 'off';
  const muted = !!nowPlaying?.muted;
  const volumePct = muted ? 0 : Math.round((typeof nowPlaying?.volume === 'number' ? nowPlaying.volume : 1) * 100);

  const iconButton = (icon, action, label, color, size = 5) => (
    <button
      key={action}
      onClick={() => sendControl(action)}
      title={label}
      style={{
        background: 'transparent', border: 'none', color,
        cursor: 'pointer', padding: size, borderRadius: 4,
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}
    >
      {icon}
    </button>
  );

  return (
    <div
      ref={containerRef}
      data-tauri-drag-region="deep"
      style={{
        height: '100vh',
        width: '100vw',
        background: '#0a0a0a',
        position: 'relative',
        userSelect: 'none',
        // the outline is drawn inside the window instead of as a border, so a
        // resize never changes the size of the box it is drawn on. squarer
        // corners: the window itself is not transparent, a round border left
        // little wedges of window showing at each corner
        boxShadow: `inset 0 0 0 2px ${accent}`,
        borderRadius: 7,
        overflow: 'hidden',
        boxSizing: 'border-box'
      }}
    >
      <canvas
        ref={canvasRef}
        width={MINI_BASE_WIDTH}
        height={MINI_BASE_HEIGHT}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }}
      />

      {/* fixed base size, scaled by ONE uniform factor to fill the real
          (aspect-locked) window size - icons/text/spacing all grow or
          shrink together, cant ever get stretched weird since width and
          height literally cannot diverge from each other anymore */}
      <div
        data-tauri-drag-region="deep"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: MINI_BASE_WIDTH,
          height: MINI_BASE_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          color: '#fef3e2',
          fontFamily: '-apple-system, "Segoe UI", sans-serif',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 5,
          padding: '8px 14px',
          boxSizing: 'border-box',
          zIndex: 1
        }}
      >
        <button
          onClick={closeMiniplayer}
          title="close miniplayer"
          style={{
            position: 'absolute', top: 6, right: 6,
            background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.5)',
            cursor: 'pointer', padding: 3, display: 'flex', zIndex: 2
          }}
        >
          <CloseIcon />
        </button>

        <div data-tauri-drag-region="deep" style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <div data-tauri-drag-region="deep" className={`vinyl-record ${isPlaying ? '' : 'paused'}`} style={{ width: 44, height: 44, flexShrink: 0, position: 'relative', margin: 0 }}>
            {thumbTier < thumbSources.length && (
              <img
                data-tauri-drag-region="deep"
                className="record-thumb"
                src={thumbSources[thumbTier]}
                alt="thumbnail"
                onError={() => setThumbTier((t) => t + 1)}
              />
            )}
          </div>
          <div data-tauri-drag-region="deep" style={{ flex: 1, minWidth: 0, paddingRight: 14 }}>
            <Marquee text={title} style={{ fontSize: 13, fontWeight: 600 }} />
            <Marquee text={author} style={{ fontSize: 11, opacity: 0.7, marginTop: 1 }} />
          </div>
        </div>

        <div>
          <div
            ref={progressBarRef}
            data-tauri-drag-region="false"
            onMouseDown={handleProgressPointerDown}
            style={{ padding: '5px 0', cursor: 'pointer' }}
          >
            <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.15)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${progressPct}%`, background: accent }} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, opacity: 0.7, marginTop: -2 }}>
            <span>{formatTime(currentTime)}</span>
            <span>{duration > 0 ? formatTime(duration) : '--:--'}</span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          {iconButton(<ShuffleIcon />, 'shuffle', shuffleOn ? 'shuffle on' : 'shuffle off', shuffleOn ? accent : dim)}
          {iconButton(<PrevIcon />, 'previous', 'previous', accent)}
          {iconButton(isPlaying ? <PauseIcon /> : <PlayIcon />, 'toggle', 'play/pause', accent, 3)}
          {iconButton(<NextIcon />, 'next', 'next', accent)}
          {iconButton(<RepeatIcon one={repeatMode === 'one'} />, 'repeat', `repeat ${repeatMode}`, repeatMode === 'off' ? dim : accent)}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          {iconButton(<VolumeIcon muted={muted} />, 'mute', muted ? 'unmute' : 'mute', muted ? dim : accent, 4)}
          {iconButton(<MinusIcon />, 'volume_down', 'volume down', accent, 4)}
          <span style={{ fontSize: 11, minWidth: 38, textAlign: 'center', color: muted ? dim : '#fef3e2' }}>{muted ? 'muted' : `${volumePct}%`}</span>
          {iconButton(<PlusIcon />, 'volume_up', 'volume up', accent, 4)}
        </div>
      </div>
    </div>
  );
}
