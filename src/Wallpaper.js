import React, { useEffect, useRef } from 'react';
import { createVisualizerRenderers } from './vizRenderers';
import { ampFromSpectrum, unpackFrame } from './wallpaperFrame';
import { drawSongInfo, infoInset } from './songInfo';
import { frontendLog } from './tauriApi';

// the live wallpaper (computer app). this is the page of a window that the app puts behind the desktop icons (see wallpaper_win.rs),
// opened with ?view=wallpaper like the mini player. it plays no sound: the app window sends it a picture of the sound about 30 times
// a second (see wallpaperFrame.js) and it draws it with the same drawings as the background of the app.
//
// it is cheap on purpose. nothing is drawn while the desktop cannot be seen (a window covers it, the screen is locked: the app
// says so with 'wallpaper-visible'), while a song plays it draws when a frame arrives and not otherwise, while nothing plays it only
// drifts ten times a second like the background does, and the picture is never wider than 1920 pixels, however big the screen is

const IDLE_FRAME_MS = 100;
const FADE_FRAME_MS = 33;
const MIN_PLAY_GAP_MS = 24;
const MAX_WIDTH = 1920;
const BACKGROUND = '#0a0a0a';
// the plain background (no drawing) would leave the wallpaper empty, so it draws this instead
const FALLBACK_PRESET = 'particles';

// bars the way the drawings ask for them, out of the 64 that came with the frame
const ampForBarRange = (index, count, data) => (data ? ampFromSpectrum(index, count, data) : 0);

export default function Wallpaper() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    let cancelled = false;
    let unlistens = [];
    let idleTimer = 0;
    let pendingDraw = 0;
    let lastDrawAt = 0;

    // what the app window last said about the sound, and whether the desktop can be seen
    let latest = null;
    let shown = true;
    // the song that came with the frames (it only comes when it changes and every second), and when its position was true
    let song = null;
    const fontFamily = (typeof getComputedStyle === 'function' && document.body && getComputedStyle(document.body).fontFamily) || 'sans-serif';

    // the drawings and their scratch state, made again when the preset changes
    let renderers = null;
    let rendererPreset = '';
    const state = {};
    const fade = { progress: 0, target: 0 };

    const resize = () => {
      const scale = Math.min(1, MAX_WIDTH / Math.max(1, window.innerWidth));
      const width = Math.max(2, Math.round(window.innerWidth * scale));
      const height = Math.max(2, Math.round(window.innerHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      if (!latest) return;
      const frame = latest;
      const now = performance.now();
      const wanted = frame.preset === 'none' ? FALLBACK_PRESET : frame.preset;
      if (!renderers || rendererPreset !== wanted) {
        Object.keys(state).forEach((key) => delete state[key]);
        renderers = createVisualizerRenderers({ canvas, ctx, state, ampForBarRange });
        rendererPreset = wanted;
      }
      // the fade the background does when a song starts or stops
      fade.target = frame.isPlaying ? 1 : 0;
      fade.progress += (fade.target - fade.progress) * (fade.target === 0 ? 0.08 : 0.02);
      if (Math.abs(fade.progress - fade.target) < 0.01) fade.progress = fade.target;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const renderer = renderers[wanted] || renderers[FALLBACK_PRESET];
      renderer({
        inset: song && song.title ? infoInset(wanted) : null,
        soft: frame.soft,
        beat: frame.beat,
        bar: frame.bar,
        bpm: frame.bpm,
        locked: frame.locked,
        phase: frame.phase,
        period: frame.period,
        beatCount: frame.beatCount,
        barCount: frame.barCount,
        beatInBar: frame.beatInBar,
        now,
        dt: Math.min(100, Math.max(4, now - (lastDrawAt || now - 33))),
        baseHue: frame.baseHue,
        sat: frame.sat,
        light: frame.light,
        isPlaying: frame.isPlaying,
        fadeProgress: fade.progress,
        bassLevel: frame.bassLevel,
        bassPulse: frame.bassPulse,
        volumeLevel: frame.volumeLevel,
        dataArray: frame.isPlaying ? frame.spec : null,
        timeData: frame.isPlaying ? frame.wave : null
      });
      if (song && song.title) drawSongInfo(ctx, canvas, wanted, song, frame.baseHue, now, 0.35 + 0.65 * fade.progress, fontFamily);
      lastDrawAt = now;
    };

    const stopIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = 0;
    };
    const stopAll = () => {
      stopIdle();
      if (pendingDraw) cancelAnimationFrame(pendingDraw);
      pendingDraw = 0;
    };

    // nothing plays: the background only drifts, and it fades out for a moment first
    const idleStep = () => {
      idleTimer = 0;
      if (cancelled || !shown || !latest || latest.isPlaying) return;
      draw();
      idleTimer = setTimeout(idleStep, fade.progress > 0 ? FADE_FRAME_MS : IDLE_FRAME_MS);
    };

    // what to do now that something changed (a frame, or the desktop showing up again)
    const kick = () => {
      if (cancelled || !shown || !latest) return;
      if (latest.isPlaying) {
        stopIdle();
        if (!pendingDraw && performance.now() - lastDrawAt >= MIN_PLAY_GAP_MS) {
          pendingDraw = requestAnimationFrame(() => {
            pendingDraw = 0;
            if (!cancelled && shown && latest) draw();
          });
        }
      } else if (!idleTimer) {
        idleTimer = setTimeout(idleStep, 0);
      }
    };

    const setShown = (value) => {
      if (shown === value) return;
      shown = value;
      frontendLog('wallpaper', value ? 'on screen again, drawing' : 'covered or hidden, not drawing');
      if (value) kick(); else stopAll();
    };
    // the window can also be hidden without the app saying so: the page then reports it
    const onVisibility = () => { if (document.visibilityState === 'hidden') setShown(false); };
    document.addEventListener('visibilitychange', onVisibility);

    (async () => {
      try {
        const eventApi = await import('@tauri-apps/api/event');
        if (cancelled) return;
        unlistens.push(await eventApi.listen('wallpaper-frame', (event) => {
          latest = unpackFrame(event.payload);
          if (latest.song) song = { ...latest.song, at: performance.now() };
          kick();
        }));
        unlistens.push(await eventApi.listen('wallpaper-visible', (event) => setShown(event.payload !== false)));
        frontendLog('wallpaper', `page ready, ${window.innerWidth}x${window.innerHeight}`);
        // the app window does not know this window just opened: ask it for the state of the sound
        await eventApi.emitTo('main', 'wallpaper-ready', null);
        setTimeout(() => {
          if (!cancelled && !latest) eventApi.emitTo('main', 'wallpaper-ready', null).catch(() => {});
        }, 1500);
      } catch (error) {
        frontendLog('wallpaper', `could not start: ${error?.message || error}`);
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      stopAll();
      unlistens.forEach((fn) => { try { fn(); } catch { /* already gone */ } });
      unlistens = [];
    };
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: BACKGROUND, overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ width: '100vw', height: '100vh', display: 'block' }} />
    </div>
  );
}
