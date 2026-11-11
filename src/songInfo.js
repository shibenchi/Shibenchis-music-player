// the song on the live wallpaper (computer and phone): the title, the artist and how far into the song it is. only the wallpaper shows it,
// the background of the app does not. where it goes depends on the visual: the stars have it on top and the progress bar at the bottom,
// the bars are made shorter to leave room for it on top, the radial one has the progress as a line round the whole ring, and so on.
//
// a layout says where the text goes (x, y as a share of the width and height, and which side it is aligned to), where the progress goes
// (a bar, a bar that is the line of the water, or an arc round the ring) and what room the drawing has to leave (inset: share of the
// height that bars and the water keep free on top, center: where the ring is)

// what sits on top of a wallpaper on a computer: the desktop icons down both sides (a tenth of the width is kept clear on each side), and
// the taskbar along the bottom (nothing below 90% of the height, the last line of text included). the middle of the screen is free
const SIDE = 0.1;
const LAYOUTS = {
  bars: { text: { x: SIDE, y: 0.06, align: 'left' }, bar: { x: SIDE, y: 0.19, w: 1 - SIDE * 2 }, inset: { top: 0.26 } },
  mirrorSpectrum: { text: { x: SIDE, y: 0.06, align: 'left' }, bar: { kind: 'surface' }, inset: { top: 0.12 } },
  radial: { text: { x: 0.5, y: 0.79, align: 'center' }, bar: { kind: 'arc', radius: 0.36 }, inset: { center: 0.4 } },
  particles: { text: { x: SIDE, y: 0.72, align: 'left' }, bar: { x: SIDE, y: 0.855, w: 1 - SIDE * 2 } },
  network: { text: { x: 1 - SIDE, y: 0.07, align: 'right' }, bar: { x: 0.58, y: 0.185, w: 1 - SIDE - 0.58 } },
  starfield: { text: { x: 0.5, y: 0.07, align: 'center' }, bar: { x: 0.2, y: 0.87, w: 0.6 } },
  pulseGrid: { text: { x: 0.5, y: 0.8, align: 'center', plate: true }, bar: { x: 0.3, y: 0.885, w: 0.4 } },
  wave: { text: { x: SIDE, y: 0.72, align: 'left' }, bar: { x: SIDE, y: 0.855, w: 1 - SIDE * 2 } },
  minimalPulse: { text: { x: 0.5, y: 0.68, align: 'center' }, bar: { x: 0.35, y: 0.79, w: 0.3 } },
  runner: { text: { x: 0.5, y: 0.74, align: 'center' }, bar: { x: 0.3, y: 0.855, w: 0.4 } }
};
export const INFO_SIDE = SIDE;
const DEFAULT_LAYOUT = LAYOUTS.particles;

export function infoLayout(preset) {
  return LAYOUTS[preset] || DEFAULT_LAYOUT;
}

// what the drawing of this preset has to leave free, or null when it keeps nothing special
export function infoInset(preset) {
  return infoLayout(preset).inset || null;
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const clock = (seconds) => {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// the text cut to fit with ... at the end
function fit(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}...`).width <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return `${text.slice(0, lo)}...`;
}

// song: { title, artist, position (seconds, at the time `at`), duration (seconds), playing, at (ms, performance.now() when position was true) }
export function drawSongInfo(ctx, canvas, preset, song, hue, now, alpha = 1, fontFamily = 'sans-serif') {
  if (!song || !song.title) return;
  const W = canvas.width;
  const H = canvas.height;
  const layout = infoLayout(preset);
  const unit = Math.min(W, H);
  const titleSize = clamp(unit * 0.036, 15, 48);
  const artistSize = titleSize * 0.7;
  const small = titleSize * 0.52;
  const elapsed = clamp((song.position || 0) + (song.playing ? Math.max(0, now - (song.at || now)) / 1000 : 0), 0, song.duration > 0 ? song.duration : 1e9);
  const share = song.duration > 0 ? clamp(elapsed / song.duration, 0, 1) : 0;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
  ctx.shadowBlur = 8;

  // --- the text
  const t = layout.text;
  const x = W * t.x;
  const y = H * t.y + titleSize;
  const maxWidth = t.align === 'center' ? W * (1 - SIDE * 2) : t.align === 'right' ? W * t.x - W * SIDE : Math.min(W * 0.6, W * (1 - SIDE) - W * t.x);
  ctx.font = `700 ${titleSize}px ${fontFamily}`;
  const title = fit(ctx, song.title, maxWidth);
  const titleWidth = ctx.measureText(title).width;
  ctx.font = `500 ${artistSize}px ${fontFamily}`;
  const artist = song.artist ? fit(ctx, song.artist, maxWidth) : '';
  const artistWidth = artist ? ctx.measureText(artist).width : 0;
  if (t.plate) {
    const wide = Math.max(titleWidth, artistWidth) + titleSize * 1.6;
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(4, 6, 10, 0.62)';
    ctx.fillRect(W * t.x - wide / 2, y - titleSize * 1.15, wide, titleSize * (artist ? 2.5 : 1.6));
    ctx.shadowBlur = 8;
  }
  ctx.textAlign = t.align;
  ctx.font = `700 ${titleSize}px ${fontFamily}`;
  ctx.fillStyle = `hsla(${Math.round(hue)}, 35%, 96%, 0.97)`;
  ctx.fillText(title, x, y);
  if (artist) {
    ctx.font = `500 ${artistSize}px ${fontFamily}`;
    ctx.fillStyle = `hsla(${Math.round(hue)}, 90%, 70%, 0.92)`;
    ctx.fillText(artist, x, y + artistSize * 1.35);
  }

  // --- the progress
  const bar = layout.bar;
  const track = `hsla(${Math.round(hue)}, 100%, 50%, 0.28)`;
  const fill = `hsla(${Math.round(hue)}, 100%, 60%, 0.97)`;
  ctx.shadowBlur = 6;
  if (bar.kind === 'arc') {
    // a line round the ring, from the top, clockwise
    const cx = W / 2;
    const cy = H * (layout.inset && layout.inset.center ? layout.inset.center : 0.5);
    const r = unit * bar.radius;
    ctx.lineWidth = Math.max(2, unit * 0.005);
    ctx.lineCap = 'round';
    ctx.strokeStyle = track;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    if (share > 0) {
      ctx.strokeStyle = fill;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + share * Math.PI * 2);
      ctx.stroke();
    }
    const a = -Math.PI / 2 + share * Math.PI * 2;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, ctx.lineWidth * 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `500 ${small}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = `hsla(${Math.round(hue)}, 60%, 80%, 0.85)`;
    ctx.fillText(`${clock(elapsed)} / ${clock(song.duration)}`, W / 2, y + artistSize * 1.35 + small * 1.7);
  } else if (bar.kind === 'surface') {
    // the water line of the mirror drawing is already a bright line across the whole screen, so the progress is a white strip on it, thicker than the
    // line, from the left edge of the screen (the start) to the right edge (the end): a pale track, the played part solid and a small upright mark
    // where it has got to
    const by = H * 0.5;
    const th = Math.max(5, unit * 0.0075);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.fillRect(0, by - th / 2, W, th);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
    ctx.fillRect(0, by - th / 2, W * share, th);
    ctx.fillRect(Math.min(W - th * 0.45, Math.max(0, W * share - th * 0.45)), by - th * 2.1, th * 0.9, th * 4.2);
  } else {
    const bx = W * bar.x;
    const by = H * bar.y;
    const bw = W * bar.w;
    const th = bar.thick ? Math.max(4, unit * 0.008) : Math.max(3, unit * 0.005);
    ctx.lineCap = 'butt';
    ctx.fillStyle = track;
    ctx.fillRect(bx, by - th / 2, bw, th);
    ctx.fillStyle = fill;
    ctx.fillRect(bx, by - th / 2, bw * share, th);
    if (!bar.thick) {
      ctx.beginPath();
      ctx.arc(bx + bw * share, by, th * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = `500 ${small}px ${fontFamily}`;
    ctx.fillStyle = `hsla(${Math.round(hue)}, 60%, 80%, 0.85)`;
    const labelY = by + th * 2 + small * 1.1;
    ctx.textAlign = 'left';
    ctx.fillText(clock(elapsed), bx, labelY);
    ctx.textAlign = 'right';
    ctx.fillText(clock(song.duration), bx + bw, labelY);
  }
  ctx.restore();
}
