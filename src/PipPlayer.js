import React, { useEffect, useRef, useState } from 'react';
import Marquee from './Marquee';

// what the app shows while it is shrunk into android's floating picture in
// picture window: the player card from the app and the desktop mini player, drawn
// over the real page. the audio keeps playing in the page underneath.
//
// android does not hand touches on the content of that window to the app: a tap
// on it shows the system's own buttons (previous, play, next, which the app sets
// up natively) and that is all. so the buttons and the seek bar here are wired up
// (they act the moment a touch does reach them, on phones that deliver it) but
// the reliable controls are the system ones, and the seek bar of the media
// notification

// the size everything is laid out at, then scaled to the real window
const BASE_WIDTH = 300;
const BASE_HEIGHT = 150;
// the colored outline: drawn as the window's own background so it runs right to
// the edge, with the card inside it. no black strip outside the color, and the
// rounded corners the system cuts into the window only cut into the outline
const BORDER = 3;

const formatTime = (seconds) => {
  if (!seconds || Number.isNaN(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

// a command to the app, the same path the notification and the widget use
const send = (command, arg) => {
  try {
    if (typeof window.__smpNativeCommand === 'function') window.__smpNativeCommand(command, arg);
  } catch {
    // nothing to tell
  }
};

const Svg = ({ children, color, size = 15, stroke = 2.4 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const ShuffleIcon = ({ color }) => <Svg color={color}><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></Svg>;
const PrevIcon = ({ color }) => <Svg color={color} stroke={1.4}><path d="M19 20 9 12l10-8v16zM5 19V5" fill={color} /></Svg>;
const NextIcon = ({ color }) => <Svg color={color} stroke={1.4}><path d="M5 4l10 8-10 8V4zM19 5v14" fill={color} /></Svg>;
const PlayIcon = ({ color }) => <Svg color={color} size={20} stroke={1.2}><path d="M6 4l14 8-14 8V4z" fill={color} /></Svg>;
const PauseIcon = ({ color }) => <Svg color={color} size={20} stroke={1}><path d="M6.5 4h3.8v16H6.5zM13.7 4h3.8v16h-3.8z" fill={color} /></Svg>;
const RepeatIcon = ({ color, one }) => (
  <Svg color={color}>
    <path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" />
    {one && <path d="M11 10h1v4" />}
  </Svg>
);
const VolumeIcon = ({ color, muted }) => (
  <Svg color={color} size={13}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    {muted ? <path d="M23 9l-6 6M17 9l6 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />}
  </Svg>
);

export default function PipPlayer({ nowPlaying }) {
  const cardRef = useRef(null);
  const canvasRef = useRef(null);
  const barRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [thumbTier, setThumbTier] = useState(0);

  // the card's real size, taken from the card itself: window.innerWidth comes
  // rounded and moves while the window is being resized, the card never lies
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return undefined;
    const fit = () => {
      const width = card.clientWidth || BASE_WIDTH;
      const height = card.clientHeight || BASE_HEIGHT;
      setScale(Math.max(0.2, Math.min(width / BASE_WIDTH, height / BASE_HEIGHT)));
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = width;
        canvas.height = height;
      }
    };
    fit();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', fit);
      return () => window.removeEventListener('resize', fit);
    }
    const observer = new ResizeObserver(fit);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  // the visualizer behind the card's content: the page's own audio analysis,
  // handed over by the app on every frame while this window is showing
  useEffect(() => {
    let animationId = 0;
    let drawn = null;
    const softCeiling = (x) => (x <= 0.65 ? x : 0.65 + 0.35 * Math.tanh((x - 0.65) / 0.35));
    const draw = () => {
      animationId = requestAnimationFrame(draw);
      const frame = window.__smpVizFrame;
      if (frame === drawn) return;
      drawn = frame;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!frame || !frame.isPlaying) return;
      const { baseHue, preset, bins, wave, bassPulse = 0 } = frame;

      if (preset === 'wave' && wave && wave.length > 1) {
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
        ctx.strokeStyle = `hsla(${baseHue}, 85%, 60%, 0.18)`;
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = `hsla(${baseHue}, 85%, 60%, 0.8)`;
        ctx.stroke();
      } else if (bins) {
        const barCount = bins.length;
        const gap = 2;
        const barWidth = canvas.width / barCount - gap;
        for (let i = 0; i < barCount; i++) {
          const bassWeight = Math.max(0, 1 - i / (barCount * 0.3));
          const boosted = softCeiling((bins[i] / 255) * (1 + bassPulse * bassWeight * 2.5));
          const height = Math.max(2, boosted * canvas.height * 0.85);
          const gradient = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - height);
          gradient.addColorStop(0, `hsla(${baseHue}, 85%, 55%, 0.6)`);
          gradient.addColorStop(1, `hsla(${baseHue}, 90%, 65%, 0.12)`);
          ctx.fillStyle = gradient;
          ctx.fillRect(i * (barWidth + gap), canvas.height - height, barWidth, height);
        }
      }
    };
    animationId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animationId);
  }, []);

  useEffect(() => {
    setThumbTier(0);
  }, [nowPlaying?.videoId, nowPlaying?.thumbnail]);

  const thumbSources = [
    nowPlaying?.thumbnail,
    nowPlaying?.videoId ? `https://img.youtube.com/vi/${nowPlaying.videoId}/mqdefault.jpg` : null,
    nowPlaying?.videoId ? `https://img.youtube.com/vi/${nowPlaying.videoId}/default.jpg` : null
  ].filter(Boolean);

  const color = nowPlaying?.themeColor;
  const accent = color ? `rgb(${color.r}, ${color.g}, ${color.b})` : '#ff5900';
  const dim = 'rgba(255, 255, 255, 0.35)';
  const isPlaying = !!nowPlaying?.isPlaying;
  const duration = nowPlaying?.duration || 0;
  const current = nowPlaying?.currentTime || 0;
  const progressPct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const muted = !!nowPlaying?.muted;
  const volumePct = muted ? 0 : Math.round((typeof nowPlaying?.volume === 'number' ? nowPlaying.volume : 1) * 100);
  const repeatMode = nowPlaying?.repeat || 'off';

  const seekFromPointer = (event) => {
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    if (!rect.width) return;
    send('seek', Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)));
  };

  const iconButton = (icon, onPress, label) => (
    <button
      type="button"
      onClick={onPress}
      aria-label={label}
      style={{ background: 'transparent', border: 'none', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {icon}
    </button>
  );

  return (
    // the window's background is the outline color, the card is laid inside it
    <div style={{ position: 'fixed', inset: 0, zIndex: 100000, background: accent }}>
      <div
        ref={cardRef}
        style={{
          position: 'absolute',
          inset: BORDER,
          borderRadius: 11,
          background: '#0a0a0a',
          overflow: 'hidden',
          userSelect: 'none',
          // its own layer, so the spinning record and the drawing do not repaint each other
          transform: 'translateZ(0)',
          isolation: 'isolate'
        }}
      >
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }} />

        {/* laid out at a fixed size and scaled as one piece, centered by the
            transform itself so the margins on every side come out the same */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: BASE_WIDTH,
            height: BASE_HEIGHT,
            transform: `translate(-50%, -50%) scale(${scale})`,
            transformOrigin: 'center center',
            color: '#fef3e2',
            fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 5,
            padding: '8px 14px',
            boxSizing: 'border-box',
            zIndex: 1
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div className={`vinyl-record ${isPlaying ? '' : 'paused'}`} style={{ width: 44, height: 44, flexShrink: 0, position: 'relative', margin: 0 }}>
              {thumbTier < thumbSources.length && (
                <img className="record-thumb" src={thumbSources[thumbTier]} alt="" onError={() => setThumbTier((t) => t + 1)} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Marquee text={nowPlaying?.title || 'nothing playing'} style={{ fontSize: 13, fontWeight: 600 }} />
              <Marquee text={nowPlaying?.author || ' '} style={{ fontSize: 11, opacity: 0.7, marginTop: 1 }} />
            </div>
          </div>

          <div>
            <div ref={barRef} onPointerDown={seekFromPointer} style={{ padding: '5px 0', touchAction: 'none' }}>
              <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.15)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progressPct}%`, background: accent }} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, opacity: 0.7, marginTop: -2 }}>
              <span>{formatTime(current)}</span>
              <span>{duration > 0 ? formatTime(duration) : '--:--'}</span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            {iconButton(<ShuffleIcon color={nowPlaying?.shuffle ? accent : dim} />, () => send('shuffle'), 'shuffle')}
            {iconButton(<PrevIcon color={accent} />, () => send('previous'), 'previous')}
            {iconButton(isPlaying ? <PauseIcon color={accent} /> : <PlayIcon color={accent} />, () => send(isPlaying ? 'pause' : 'play'), 'play or pause')}
            {iconButton(<NextIcon color={accent} />, () => send('next'), 'next')}
            {iconButton(<RepeatIcon color={repeatMode === 'off' ? dim : accent} one={repeatMode === 'one'} />, () => send('repeat'), 'repeat')}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 11 }}>
            {iconButton(<VolumeIcon color={muted ? dim : accent} muted={muted} />, () => send('mute'), 'mute')}
            <span style={{ minWidth: 38, textAlign: 'center', color: muted ? dim : '#fef3e2' }}>{muted ? 'muted' : `${volumePct}%`}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
