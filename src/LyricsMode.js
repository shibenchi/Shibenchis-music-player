import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from 'react-bootstrap';
import { fetchLyrics, lineIndexAt } from './lyrics';
import { visibleInterval } from './visibleInterval';

export const NO_LYRICS_MESSAGE = "couldn't find lyrics for this song yet. matching gets better with every update";
export const LYRICS_ERROR_MESSAGE = 'could not load lyrics';

export function lyricsDurationForTrack(track, audio, fallbackDuration = 0) {
  const storedMs = Number(track && (track.durationMs || track.duration_ms)) || 0;
  if (storedMs > 0) return storedMs / 1000;
  if (!track?.videoId || audio?.dataset?.loadedTrackVideoId !== String(track.videoId)) return 0;
  if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  const fallback = Number(fallbackDuration) || 0;
  return fallback > 0 ? fallback : 0;
}

// the lyrics screen: the words of the song that plays, line by line, in time with it, the way Spotify shows them. the line that is being sung stays near the
// middle and is the brightest, the others move up as the song goes on. a line can be pressed to jump there.
// the background is the app's own visualizer (the same picture, copied from its canvas about thirty times a second) blurred a little, on a base that is a dark
// tint of the theme color, or a pale one when the theme color is so bright that white words would not show: the words are black on the pale base and white on
// the dark one

// how bright a color is to the eye, 0 to 1 (the WCAG measure)
export const lightOf = ({ r, g, b }) => {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

// the base under the visualizer and the color of the words, from the theme color
export function lyricsLook(color) {
  return { ink: '#fff', inkRgb: '255, 255, 255', base: 'rgb(0, 0, 0)', dark: true };
}

export default function LyricsMode({ track, audioRef, themeColor, canvasRef, duration, onClose }) {
  const look = lyricsLook(themeColor);
  const [result, setResult] = useState({ status: 'loading', kind: 'none', lines: [], plain: '' });
  const [active, setActive] = useState(-1);
  const [shift, setShift] = useState(0);
  const backRef = useRef(null);
  const viewRef = useRef(null);
  const trackRef = useRef(null);
  const linesRef = useRef([]);
  const key = `${(track && track.videoId) || ''}|${(track && track.title) || ''}`;

  // the lyrics of this song (and again when the song changes while the screen is open)
  useEffect(() => {
    let alive = true;
    setResult({ status: 'loading', kind: 'none', lines: [], plain: '' });
    setActive(-1);
    const length = lyricsDurationForTrack(track, audioRef.current, duration);
    fetchLyrics(track, length).then((found) => {
      if (!alive) return;
      // lyrics without time stamps are shown as text: there is no timing to follow them with, so none is guessed
      linesRef.current = found.lines || [];
      setResult({ status: 'done', kind: found.kind, lines: found.lines || [], plain: found.plain || '' });
    }).catch(() => {
      if (!alive) return;
      linesRef.current = [];
      setResult({ status: 'done', kind: 'error', lines: [], plain: '' });
    });
    return () => { alive = false; };
    // the length is read when the song starts, a change of it later does not ask again
  }, [key, duration]);

  // which line is being sung: looked at ten times a second while the screen is seen (a screen that is hidden has nothing to move)
  useEffect(() => {
    if (result.kind !== 'synced') return undefined;
    linesRef.current = result.lines;
    const watch = () => {
      const audio = audioRef.current;
      if (!audio) return;
      const index = lineIndexAt(linesRef.current, audio.currentTime || 0);
      setActive((now) => (now === index ? now : index));
    };
    return visibleInterval(watch, 100);
  }, [result, audioRef]);

  // the line that is sung moves to a place a little above the middle: the whole column slides, the way the lines move up in Spotify
  const place = useCallback(() => {
    const view = viewRef.current;
    const column = trackRef.current;
    if (!view || !column || result.kind !== 'synced') return;
    const target = column.querySelector(`[data-line="${Math.max(0, active)}"]`);
    if (!target) return;
    setShift(view.clientHeight * 0.4 - (target.offsetTop + target.offsetHeight / 2));
  }, [active, result]);
  useLayoutEffect(() => { place(); }, [place]);
  useEffect(() => {
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [place]);

  // the background: the visualizer, copied from its canvas, over the base. blurred by the style of the canvas
  useEffect(() => {
    const back = backRef.current;
    if (!back) return undefined;
    const ctx = back.getContext('2d');
    if (!ctx) return undefined;
    const paint = () => {
      const source = canvasRef && canvasRef.current;
      const w = Math.max(1, Math.round(window.innerWidth / 2));
      const h = Math.max(1, Math.round(window.innerHeight / 2));
      if (back.width !== w || back.height !== h) { back.width = w; back.height = h; }
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = look.base;
      ctx.fillRect(0, 0, w, h);
      if (source && source.width > 0 && source.height > 0) {
        // on a pale base the colored shapes are darkened into it, on a dark base they add their light
        ctx.globalCompositeOperation = look.dark ? 'lighter' : 'multiply';
        try { ctx.drawImage(source, 0, 0, w, h); } catch { /* nothing to copy this time */ }
        ctx.globalCompositeOperation = 'source-over';
      }
    };
    paint();
    return visibleInterval(paint, 40);
  }, [canvasRef, look.base, look.dark]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const jump = (line) => {
    const audio = audioRef.current;
    if (!audio || result.kind !== 'synced') return;
    try { audio.currentTime = Math.max(0, line.t); } catch { /* not seekable now */ }
    const index = lineIndexAt(result.lines, line.t);
    setActive(index);
  };

  const message = result.status === 'loading' ? 'looking for the words'
    : result.kind === 'instrumental' ? 'instrumental'
      : result.kind === 'error' ? LYRICS_ERROR_MESSAGE
        : result.kind === 'none' ? NO_LYRICS_MESSAGE
          : '';

  return (
    <div
      className="lyrics-overlay"
      data-lyrics
      data-lyrics-ink={look.dark ? 'white' : 'black'}
      role="dialog"
      aria-label="lyrics"
      style={{ '--lyr-ink': look.ink, '--lyr-ink-rgb': look.inkRgb, '--lyr-base': look.base }}
    >
      <canvas ref={backRef} className="lyrics-back" data-lyrics-back />
      <div className="lyrics-top">
        <div className="lyrics-song">
          <span className="lyrics-song-title">{track && track.title}</span>
          {track && track.author ? <span className="lyrics-song-artist">{track.author}</span> : null}
        </div>
        <Button variant="outline-light" size="sm" data-lyrics-close onClick={onClose} style={{ borderRadius: '6px', color: look.ink, borderColor: look.ink }}>close</Button>
      </div>
      {result.kind === "plain" ? (
        <div className="lyrics-note" data-lyrics-note>as of right now there's no time data for this song's lyrics, sorry</div>
      ) : null}
      {message ? <div className="lyrics-message" data-lyrics-message>{message}</div> : null}
      {result.kind === 'synced' ? (
        <div className="lyrics-view" ref={viewRef} data-lyrics-view>
          <div className="lyrics-column" ref={trackRef} style={{ transform: `translateY(${shift}px)` }}>
            {result.lines.map((line, index) => {
              const distance = active < 0 ? index + 1 : index - active;
              const state = distance === 0 ? 'now' : distance < 0 ? (distance === -1 ? 'just' : 'past') : (distance === 1 ? 'next' : 'later');
              return (
                <div
                  key={index}
                  data-line={index}
                  data-state={state}
                  className={'lyrics-line' + (distance === 0 ? ' lyrics-now' : '')}
                  onClick={() => jump(line)}
                >
                  {line.text || '♪'}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {result.kind === 'plain' ? (
        <div className="lyrics-plain" data-lyrics-plain>{result.plain}</div>
      ) : null}
    </div>
  );
}
