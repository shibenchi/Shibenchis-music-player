import React, { useEffect, useRef, useState, useCallback } from 'react';
import { announceMiniplayerReady, frontendLog } from './tauriApi';

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

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>
);
const PrevIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
);
const NextIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" /></svg>
);
const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z" /></svg>
);

// base size everything is laid out at, then scaled up/down uniformly to
// whatever the window actually ends up being. can get away with ONE scale
// factor (not x/y separately) bc rust locks the window to this exact
// aspect ratio now — any resize either keeps it or gets snapped back, so
// width/height always move together
const MINI_BASE_WIDTH = 300;
const MINI_BASE_HEIGHT = 118;

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
        // way the bg can react to the music — main window (where the real
        // analysernode lives) shoves it a downsampled snapshot every few
        // frames. drawing directly here instead of react state so it's
        // not re-rendering the whole component every single frame
        unlistenVizFrame = await eventApi.listen('visualizer-frame', (event) => {
          const { baseHue, isPlaying, preset, bins, wave } = event.payload || {};
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          if (!isPlaying) return;

          if (preset === 'wave' && wave) {
            ctx.strokeStyle = `hsla(${baseHue}, 80%, 60%, 0.4)`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            const stepX = canvas.width / (wave.length - 1);
            for (let i = 0; i < wave.length; i++) {
              const y = (wave[i] / 255) * canvas.height;
              if (i === 0) ctx.moveTo(0, y);
              else ctx.lineTo(i * stepX, y);
            }
            ctx.stroke();
          } else if (bins) {
            const barCount = bins.length;
            const gap = 2;
            const barWidth = canvas.width / barCount - gap;
            for (let i = 0; i < barCount; i++) {
              const amp = bins[i] / 255;
              const height = Math.max(1, amp * canvas.height * 0.9);
              const x = i * (barWidth + gap);
              ctx.fillStyle = `hsla(${baseHue}, 80%, 55%, 0.35)`;
              ctx.fillRect(x, canvas.height - height, barWidth, height);
            }
          }
        });

        // main window has literally no clue this window just opened, so
        // just ask it directly for the current state instead of sitting
        // around waiting for the next incidental update. retries once
        // after a beat if nothing comes back — on a fresh install both
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
      if (unlistenNowPlaying) unlistenNowPlaying();
      if (unlistenVizFrame) unlistenVizFrame();
    };
  }, []);

  // canvas has its own backing-store size separate from its css size, so
  // without this it just stays stretched and blurry instead of tracking
  // the real window size as you resize it. rest of the ui scales by the
  // same factor (derived from width only — height tracks 1:1 since the
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
  // res youtube never even generated for that video) — falls through to
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
  // vinyl-record styling reads from — separate window/document so it does
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
  const progressPct = nowPlaying?.duration > 0
    ? Math.min(100, (nowPlaying.currentTime / nowPlaying.duration) * 100)
    : 0;
  const accent = nowPlaying?.themeColor
    ? `rgb(${nowPlaying.themeColor.r}, ${nowPlaying.themeColor.g}, ${nowPlaying.themeColor.b})`
    : 'var(--theme-primary, #ff5900)';

  return (
    <div
      ref={containerRef}
      data-tauri-drag-region
      style={{
        height: '100vh',
        width: '100vw',
        background: '#0a0a0a',
        position: 'relative',
        userSelect: 'none',
        border: `1px solid ${accent}`,
        borderRadius: 10,
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
          (aspect-locked) window size — icons/text/spacing all grow or
          shrink together, cant ever get stretched weird since width and
          height literally cannot diverge from each other anymore */}
      <div
        data-tauri-drag-region
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
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px',
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

        <div data-tauri-drag-region className={`vinyl-record ${isPlaying ? '' : 'paused'}`} style={{ width: 40, height: 40, flexShrink: 0, position: 'relative' }}>
          {thumbTier < thumbSources.length && (
            <img
              data-tauri-drag-region
              className="record-thumb"
              src={thumbSources[thumbTier]}
              alt="thumbnail"
              onError={() => setThumbTier((t) => t + 1)}
            />
          )}
        </div>

        <div data-tauri-drag-region style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <div data-tauri-drag-region style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {title}
          </div>
          <div data-tauri-drag-region style={{ fontSize: 11, opacity: 0.7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>
            {author}
          </div>
          <div
            ref={progressBarRef}
            onMouseDown={handleProgressPointerDown}
            style={{ marginTop: 10, padding: '5px 0', cursor: 'pointer' }}
          >
            <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.15)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${progressPct}%`, background: accent }} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 2, marginTop: 8 }}>
            {[
              { icon: <PrevIcon />, action: 'previous', title: 'previous' },
              { icon: isPlaying ? <PauseIcon /> : <PlayIcon />, action: 'toggle', title: 'play/pause' },
              { icon: <NextIcon />, action: 'next', title: 'next' }
            ].map(({ icon, action, title: btnTitle }) => (
              <button
                key={action}
                onClick={() => sendControl(action)}
                title={btnTitle}
                style={{
                  background: 'transparent', border: 'none', color: accent,
                  cursor: 'pointer', padding: 4, borderRadius: 6,
                  display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
