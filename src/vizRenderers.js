// the drawings of the audio reactive background (the visualizer presets). the app's own background canvas (App.js) and the live wallpaper
// window on the computer (Wallpaper.js) both use these, so the wallpaper looks like the background.
//
// every drawing takes one snapshot of the sound, f = { baseHue, isPlaying, fadeProgress, bassLevel, bassPulse, volumeLevel, dataArray, timeData,
// soft, beat, bar, bpm, locked, phase, period, beatCount, barCount, beatInBar, now, dt } (see vizDrive.js for what each one means; the last
// ones are missing from older callers and the drawings cope), and draws it onto the canvas. state is scratch space for the active preset
// (its particles, angles and so on), made fresh whenever the preset changes. ampForBarRange(index, count, dataArray) says how loud the
// index-th of count log spaced bars is, 0 to 1. it is passed in because the app reads it from the analyser's bins and the wallpaper gets
// bars that were already made

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const corridorBarInnerRadius = (level) => 0.52 - Math.max(0, Number(level) || 0) * 1.3;

export function normalizeCorridorLevels(levels, state, dt) {
  if (!levels.length) return levels;
  if (!state.sorted || state.sorted.length !== levels.length) {
    state.sorted = new Float32Array(levels.length);
    state.normalized = new Float32Array(levels.length);
  }
  for (let i = 0; i < levels.length; i += 1) state.sorted[i] = levels[i];
  state.sorted.sort();
  // the range of this song: a quiet floor (the 20th percentile of the bars) and a loud ceiling (the 90th). the floor follows the quiet bars slowly
  // both ways, the ceiling rises at once and falls back slowly. each bar is placed in that range, so a loud song and a chill one both move through
  // the whole wall (neither is always full nor always low), and a bar never sits at zero: the wall is always lit a little
  const n = state.sorted.length;
  const quiet = state.sorted[Math.floor((n - 1) * 0.2)];
  const loud = state.sorted[Math.floor((n - 1) * 0.9)];
  if (!Number.isFinite(state.lo)) { state.lo = quiet; state.hi = Math.max(loud, quiet + 0.1); }
  state.lo += (quiet - state.lo) * (1 - Math.exp(-2 * dt));
  const hiTarget = Math.max(loud, state.lo + 0.1);
  state.hi += (hiTarget - state.hi) * (1 - Math.exp(-(hiTarget > state.hi ? 10 : 0.6) * dt));
  const span = Math.max(0.14, state.hi - state.lo);
  for (let i = 0; i < levels.length; i += 1) {
    state.normalized[i] = 0.12 + 0.88 * clamp((levels[i] - state.lo) / span, 0, 1);
  }
  return state.normalized;
}
// the color of every drawing is the theme color itself: its hue, its saturation and its lightness (the frame carries them, see setTheme). a
// lightness written in a drawing is a step away from the theme's own (54 is "the color itself", a highlight is a few steps up, a deep
// shade a few steps down, at 0.6 of the written distance). without them (an older caller) the numbers are used as they are written
const theme = { s: 100, l: 54, k: 1 };
const setTheme = (f) => {
  // the exact saturation and lightness of the chosen color (not clamped: a pale or a muted color is drawn as it is chosen)
  const has = typeof f.sat === 'number' && typeof f.light === 'number';
  theme.s = has ? clamp(f.sat, 0, 100) : 100;
  theme.l = has ? clamp(f.light, 0, 100) : 54;
  theme.k = has ? 0.6 : 1;
};
const hsla = (h, s, l, a) => `hsla(${Math.round(((h % 360) + 360) % 360)}, ${Math.round(theme.s)}%, ${Math.round(clamp(theme.l + (l - 54) * theme.k, 4, 96))}%, ${Math.round(clamp(a, 0, 1) * 1000) / 1000})`;
// a small seeded random, so a picture made from a number is the same every time
const seeded = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hash01 = (n) => {
  let t = (Math.imul(n | 0, 0x9E3779B1) + 0x6D2B79F5) | 0;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// how many 33 ms frames this picture is worth (the drawings were tuned at 30 pictures a second)
const frames = (f) => clamp((f.dt || 33) / 33, 0.25, 3);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
// how hard a kick is, for the drawings that bump with the bass: anything above a small threshold counts (0.1), full at about 0.8. the fast
// reading (bassPulse), not the slow one: the slow one is what left them sitting still
const kickDrive = (f) => clamp((clamp(num(f.bassPulse, 0), 0, 1) - 0.1) * 1.4, 0, 1);

export function createVisualizerRenderers({ canvas, ctx, state, ampForBarRange }) {
  const makeFloatParticles = (count) => {
    const list = [];
    for (let i = 0; i < count; i++) {
      list.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 1.4,
        vy: (Math.random() - 0.5) * 1.4 - 0.25,
        baseRadius: Math.random() * 5 + 4,
        radius: Math.random() * 5 + 4,
        hueOffset: Math.random() * 60 - 30,
        alpha: 0,
        targetAlpha: Math.random() * 0.8 + 0.5
      });
    }
    return list;
  };

  // bends instead of clipping: untouched up to 0.65, then eases toward 1 so
  // a loud passage keeps rising a little instead of going flat against a
  // hard ceiling (the old Math.min(1, x) is why the tops looked chopped off)
  const softCeiling = (x) => (x <= 0.65 ? x : 0.65 + 0.35 * Math.tanh((x - 0.65) / 0.35));

  // the bars of a spectrum drawing, with a fall of their own: a bar jumps up at once and comes down at a fixed speed (about a third of a
  // second from the top), whatever the analyser's own smoothing does. the analyser was holding them up for over a second, which is why
  // the bars looked slow and soft. peak holds a mark that stays a moment at the highest point and then drops with gravity
  const fallingBars = (key, count, f) => {
    let s = state[key];
    if (!s || s.v.length !== count) s = state[key] = { v: new Float32Array(count), peak: new Float32Array(count), hold: new Float32Array(count), vel: new Float32Array(count) };
    const k = frames(f);
    for (let i = 0; i < count; i++) {
      const raw = f.isPlaying ? ampForBarRange(i, count, f.dataArray) : 0;
      const cur = s.v[i];
      s.v[i] = raw >= cur ? cur + (raw - cur) * Math.min(1, 0.92 * k) : Math.max(raw, cur - 0.09 * k);
      if (s.v[i] >= s.peak[i]) { s.peak[i] = s.v[i]; s.hold[i] = 8; s.vel[i] = 0; } else if (s.hold[i] > 0) s.hold[i] -= k;
      else {
        // the mark falls on a curve: it hangs, then lets go, and the speed grows by a tenth every picture on top of a tiny start (an
        // exponential), so it barely moves for the first half second and is dropping fast by the time it reaches the bars. from the top
        // that is about a second and a half
        s.vel[i] = s.vel[i] * Math.pow(1.1, k) + 0.0005 * k;
        s.peak[i] = Math.max(s.v[i], s.peak[i] - s.vel[i] * k);
      }
    }
    return s;
  };

  // listens for hits in the spectrum itself, for music with no tempo that locks or with no hard peaks (jazz, soft piano, ambient). flux is
  // how much the bars rose since the last picture (the highs count a little less than the lows). a hit is a flux that stands out from its
  // own recent average by a margin that is relative to that average, so quiet music is heard as well as loud music. a steady drone has a flux
  // that hardly moves, and nothing stands out in it. returns 0 for no hit, or how strong it was (0.3 to 1)
  const hitDetector = (key, bars, count, f) => {
    let s = state[key];
    if (!s || s.prev.length !== count) s = state[key] = { prev: new Float32Array(count), mean: 0, spread: 0, last: -9999, seen: 0 };
    let flux = 0;
    for (let i = 0; i < count; i++) {
      const amp = bars.v[i];
      const rise = amp - s.prev[i];
      if (rise > 0) flux += rise * (i < count * 0.35 ? 1 : i < count * 0.7 ? 0.85 : 0.6);
      s.prev[i] = amp;
    }
    if (!f.isPlaying) { s.seen = 0; return 0; }
    s.seen += 1;
    const dev = flux - s.mean;
    s.mean += dev * 0.03;
    s.spread += (dev * dev - s.spread) * 0.03;
    const limit = s.mean + 1.6 * Math.sqrt(s.spread) + 0.3 * s.mean + 0.02;
    const now = num(f.now, performance.now());
    if (s.seen > 12 && flux > limit && now - s.last > 220) {
      s.last = now;
      return clamp(0.3 + (flux - limit) / (s.mean + 0.15), 0.3, 1);
    }
    return 0;
  };

  // --- preset renderers ----------------------------------------------
  // each takes the same per-frame audio snapshot (f) and draws onto the
  // full-screen canvas however it likes. f.baseHue ties every preset's
  // palette back to the user's theme color, so switching color re-tints
  // whichever animation is active.

  const renderParticles = (f) => {
    if (!state.particles) state.particles = makeFloatParticles(60);
    // the orbs breathe with the soft pulse (the tempo clock's beat, slowed down) and not with every jump in the low end. the sharp pulse
    // made them flash at what looked like random moments, and a hit threw them upward and tripled their size
    // the slow pulse is the base of how they react, with a share of the hit itself so a strong bass hit is felt too (not the whole hit: that
    // was the flashing at random moments)
    const soft = num(f.soft, f.bassPulse * 0.3);
    // the kick drives them: a hit above the threshold (kickDrive) speeds them up, makes them glow and knocks them about. the slow pulse adds to it
    const drive = kickDrive(f);
    const react = clamp(soft * 0.8 + drive * 1.1, 0, 1.6);
    const k = frames(f);
    const pulseFactor = f.isPlaying ? (0.85 + f.volumeLevel * 0.7 + react * 1.25) : 1;

    // the whole background lifts a little from the bottom on a beat
    if (f.isPlaying && react > 0.03) {
      const flash = ctx.createRadialGradient(canvas.width / 2, canvas.height, 0, canvas.width / 2, canvas.height, canvas.height * 1.1);
      flash.addColorStop(0, hsla(f.baseHue, 100, 50, react * 0.16));
      flash.addColorStop(1, hsla(f.baseHue, 100, 42, 0));
      ctx.fillStyle = flash;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    state.particles.forEach((particle) => {
      // they float upward at a pace of their own, faster with the loudness and the beat
      const volumeRise = f.isPlaying ? (0.45 + f.volumeLevel * 1.2 + react * 2.8) : 0.25;
      // every kick knocks them about at random (a knock that fades in about a third of a second): the erratic movement of bass heavy songs
      particle.kx = clamp((particle.kx || 0) * Math.pow(0.9, k) + (Math.random() - 0.5) * drive * 2.5 * k, -8, 8);
      particle.ky = clamp((particle.ky || 0) * Math.pow(0.9, k) + (Math.random() - 0.5) * drive * 2.5 * k, -8, 8);
      particle.x += particle.vx * k + particle.kx * k;
      particle.y += (particle.vy - volumeRise) * k + particle.ky * k;

      if (particle.x < -50) particle.x = canvas.width + 50;
      if (particle.x > canvas.width + 50) particle.x = -50;
      if (particle.y < -50) particle.y = canvas.height + 50;
      if (particle.y > canvas.height + 50) particle.y = -50;

      const targetAlpha = f.isPlaying ? Math.min(1, particle.targetAlpha * (1 + react * 0.9)) * f.fadeProgress : 0;
      const fadeSpeed = f.fadeProgress > 0.5 ? 0.16 : 0.22;
      particle.alpha += (targetAlpha - particle.alpha) * fadeSpeed;

      const targetRadius = particle.baseRadius * pulseFactor;
      particle.radius += (targetRadius - particle.radius) * 0.55;

      if (particle.alpha > 0.01) {
        // theme tinted with a small drift per particle. full saturation and a lower lightness than before: the centers were 70% light,
        // which on a dark background reads as pale pink instead of the theme color
        const hue = f.baseHue;
        const gradient = ctx.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, particle.radius * 0.8);
        gradient.addColorStop(0, hsla(hue, 100, 54, particle.alpha));
        gradient.addColorStop(0.6, hsla(hue, 100, 50, particle.alpha * 0.65));
        gradient.addColorStop(1, hsla(hue, 100, 45, 0));
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.radius * 0.8, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();
      }
    });

    if (f.isPlaying) {
      const glowHeight = canvas.height * (0.26 + f.bassLevel * 0.05 + react * 0.14);
      const glowGradient = ctx.createLinearGradient(0, canvas.height - glowHeight, 0, canvas.height);
      const glowIntensity = Math.min(1, f.bassLevel * 0.25 + react * 0.7 + f.volumeLevel * 0.15);
      glowGradient.addColorStop(0, hsla(f.baseHue, 100, 48, 0));
      glowGradient.addColorStop(0.3, hsla(f.baseHue, 100, 48, glowIntensity * 0.3));
      glowGradient.addColorStop(0.6, hsla(f.baseHue, 100, 44, glowIntensity * 0.5));
      glowGradient.addColorStop(1, hsla(f.baseHue, 100, 40, glowIntensity * 0.7));
      ctx.fillStyle = glowGradient;
      ctx.fillRect(0, canvas.height - glowHeight, canvas.width, glowHeight);
    }
  };

  const renderBars = (f) => {
    // 72 slim bars (it was 48 fat ones). each takes a bit more than half of its slot
    const barCount = 72;
    const slot = canvas.width / barCount;
    const barWidth = Math.max(2, slot * 0.58);
    const H = canvas.height;
    // shorter when the wallpaper has song information to show on top
    const barScale = 1 - num(f.inset && f.inset.top, 0) * 1.0 / 0.8;
    const bars = fallingBars('bars', barCount, f);
    const hue = f.baseHue;
    // the background: one glow behind the whole length of the bars, from the bottom edge up to the top of the window. it is always there (a little when
    // quiet) and a bit brighter with the level of the music. one gradient that does not move
    {
      const W = canvas.width;
      let mean = 0;
      for (let i = 0; i < barCount; i++) mean += bars.v[i];
      mean /= barCount;
      const level = f.isPlaying ? clamp(mean, 0, 1) : 0;
      const alpha = clamp(0.06 + 0.08 * level + 0.03 * num(f.bassPulse, 0), 0, 0.3);
      const grad = ctx.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0, hsla(hue, 100, 52, alpha));
      grad.addColorStop(0.55, hsla(hue, 100, 48, alpha * 0.45));
      grad.addColorStop(1, hsla(hue, 100, 45, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
    }
    // one flat color, no gradient
    ctx.fillStyle = hsla(hue, 100, 54, 0.95);
    const heights = [];
    for (let i = 0; i < barCount; i++) {
      // extra boost stacked on top of the bar's own reading, strongest
      // for the low (bass) bars and fading out toward the high end - a
      // real bass hit should visibly slam past where the raw spectrum
      // reading alone would put it, not just be "a bit taller than usual"
      const bassWeight = Math.max(0, 1 - i / (barCount * 0.14));
      const boosted = softCeiling(bars.v[i] * (1 + f.bassPulse * bassWeight * 0.7 + f.bassPulse * 0.12));
      const height = f.isPlaying ? Math.max(3, boosted * H * 0.8 * barScale) : 3;
      heights.push(height);
      ctx.fillRect(i * slot + (slot - barWidth) / 2, H - height, barWidth, height);
    }
    if (f.isPlaying) {
      ctx.fillStyle = hsla(hue, 100, 68, 0.95);
      for (let i = 0; i < barCount; i++) {
        const capY = H - Math.max(heights[i], softCeiling(bars.peak[i]) * H * 0.8 * barScale) - 4;
        ctx.fillRect(i * slot + (slot - barWidth) / 2, capY, barWidth, 2.5);
      }
    }
  };

  const renderWave = (f) => {
    if (!f.timeData) return;
    // bass swells both the line's glow and how tall its swings read, so
    // a heavy low end visibly punches the waveform outward instead of
    // just being "in there somewhere" along with everything else
    const bassBoost = f.isPlaying ? 1 + f.bassPulse * 0.9 : 0.05;
    ctx.beginPath();
    const midY = canvas.height / 2;
    // every other sample is plenty, there are far more samples than pixels
    const stride = 2;
    const sliceWidth = (canvas.width / f.timeData.length) * stride;
    let x = 0;
    for (let i = 0; i < f.timeData.length; i += stride) {
      const v = (f.timeData[i] - 128) / 128;
      const y = midY + v * midY * 0.8 * bassBoost;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    // the glow is a wide faint stroke under the sharp one. shadowBlur gave
    // the same look but blurs the whole path on the cpu every frame
    ctx.lineJoin = 'round';
    ctx.lineWidth = 11 + f.bassPulse * 9;
    ctx.strokeStyle = hsla(f.baseHue, 100, 52, 0.2);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = hsla(f.baseHue, 100, 60, 0.95);
    ctx.stroke();
  };

  // a wire planet: longitude lines that turn, latitude lines, one color. the synthwave sphere
  const drawGlobe = (cx, cy, r, hue, spin, alpha, lineWidth) => {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = hsla(hue, 100, 58, alpha);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    for (let j = 0; j < 6; j++) {
      const rx = Math.abs(Math.cos((j / 6) * Math.PI + spin)) * r;
      ctx.moveTo(cx + rx, cy);
      ctx.ellipse(cx, cy, Math.max(0.5, rx), r, 0, 0, Math.PI * 2);
    }
    for (let l = -2; l <= 2; l++) {
      const yy = Math.sin((l / 3) * (Math.PI / 2)) * r;
      const half = Math.sqrt(Math.max(0, r * r - yy * yy));
      ctx.moveTo(cx + half, cy + yy);
      ctx.ellipse(cx, cy + yy, half, half * 0.16, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
  };

  // one smooth closed line round a wire planet, one turn long: the lows start at the top and the highs come round to meet them. the
  // very lowest and highest bars are nearly empty in music, so they are left out and the two ends are blended into one another where
  // they meet, no seam. the shape follows the spectrum, the waveform rides on it, and every hit sends an echo of the line outward
  // (a bar sends a bigger one). the planet, the little ring of the waveform and the line sit close together. one color
  const renderRadial = (f) => {
    // nothing playing -> nothing drawn
    if (!f.isPlaying) return;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H * num(f.inset && f.inset.center, 0.5);
    const unit = Math.min(W, H);
    const base = unit * 0.2;
    const hue = f.baseHue;
    const k = frames(f);
    const soft = num(f.soft, f.bassPulse * 0.3);
    const punch = clamp(f.bassPulse, 0, 1);
    const COUNT = 96;
    const bars = fallingBars('radial', COUNT, f);
    // a turn that is slow and gets a push on the bar lines
    state.radialAngle = (state.radialAngle || 0) + (0.0016 + soft * 0.004 + num(f.bar, 0) * 0.012) * k;
    state.globeSpin = (state.globeSpin || 0) + (0.006 + soft * 0.02) * k;

    // the bars that carry music: leave out the lowest 3 and the highest 14 of the 96
    const first = 3;
    const used = COUNT - first - 14;
    const radii = new Float32Array(used);
    for (let i = 0; i < used; i++) {
      const bassWeight = Math.max(0, 1 - i / (used * 0.12));
      radii[i] = softCeiling(bars.v[first + i] * (1 + punch * bassWeight * 0.9 + punch * 0.2));
    }
    // the two ends blended into one value where they meet
    const join = 10;
    const meet = (radii[0] + radii[used - 1]) / 2;
    for (let j = 0; j < join; j++) {
      const t = j / join;
      const w = t * t * (3 - 2 * t);
      radii[j] = meet * (1 - w) + radii[j] * w;
      radii[used - 1 - j] = meet * (1 - w) + radii[used - 1 - j] * w;
    }
    // a little smoothing round the circle, one light pass so it keeps its jumps
    {
      const copy = radii.slice();
      for (let i = 0; i < used; i++) radii[i] = copy[(i + used - 1) % used] * 0.2 + copy[i] * 0.6 + copy[(i + 1) % used] * 0.2;
    }

    const total = used * 2;
    const shape = new Float32Array(total);
    const wave = f.timeData;
    const span = wave ? Math.max(2, Math.floor(wave.length / 4)) : 0;
    const swell = 1 + soft * 0.1 + punch * 0.12;
    let sum = 0;
    for (let i = 0; i < total; i++) {
      const lo = radii[i >> 1];
      const v = i & 1 ? (lo + radii[((i >> 1) + 1) % used]) / 2 : lo;
      const u = i / total;
      const tri = u < 0.5 ? u * 2 : 2 - u * 2;
      const w = wave ? (wave[Math.floor(tri * (span - 1))] - 128) / 128 : 0;
      shape[i] = base * swell * (0.74 + v * 0.98) + w * base * 0.16 * (1 + punch * 0.8);
      sum += shape[i];
    }
    const meanRadius = sum / total;

    // echoes: on a hit the line is copied and the copy drifts outward and fades. with a tempo that is every beat (a bar: a bigger one),
    // without one the hits are heard in the spectrum itself (hitDetector), which also catches soft music with no hard peaks
    if (!state.echoes) state.echoes = [];
    const beatNo = num(f.beatCount, 0);
    const barNo = num(f.barCount, 0);
    if (state.lastBeatNo === undefined) { state.lastBeatNo = beatNo; state.lastBarNo = barNo; }
    const hit = hitDetector('radialHits', bars, COUNT, f);
    // a copy of the line as it is now, kept as it was drawn: it does not turn with the line afterwards
    const echo = (strength) => ({ life: 0, strength, shape: shape.slice(), angle: state.radialAngle, mean: meanRadius });
    if (f.locked) {
      if (barNo !== state.lastBarNo) state.echoes.push(echo(1));
      else if (beatNo !== state.lastBeatNo) state.echoes.push(echo(0.5));
      else if (hit > 0.6) state.echoes.push(echo(0.35));
    } else if (hit > 0) {
      state.echoes.push(echo(hit));
    }
    state.lastBeatNo = beatNo;
    state.lastBarNo = barNo;
    if (state.echoes.length > 5) state.echoes.splice(0, state.echoes.length - 5);
    state.echoes = state.echoes.filter((e) => e.life < 1);

    const trace = (radiusAt, scale, turn) => {
      const px = new Float32Array(total);
      const py = new Float32Array(total);
      for (let i = 0; i < total; i++) {
        // the first point is the lowest bar, straight up, and the line goes clockwise
        const angle = -Math.PI / 2 + (i / total) * Math.PI * 2 + turn;
        const r = radiusAt(i) * scale;
        px[i] = cx + Math.cos(angle) * r;
        py[i] = cy + Math.sin(angle) * r;
      }
      ctx.beginPath();
      ctx.moveTo((px[total - 1] + px[0]) / 2, (py[total - 1] + py[0]) / 2);
      for (let i = 0; i < total; i++) {
        const j = (i + 1) % total;
        ctx.quadraticCurveTo(px[i], py[i], (px[i] + px[j]) / 2, (py[i] + py[j]) / 2);
      }
      ctx.closePath();
    };

    ctx.lineJoin = 'round';
    // the echoes: a ripple. it spreads outward, its bumps flatten as it goes (it relaxes toward a round ring) and it stays where it was
    state.echoes.forEach((e) => {
      e.life += (0.018 + (1 - e.strength) * 0.01) * k;
      const grow = 1 + e.life * (0.35 + e.strength * 0.45);
      const relax = Math.min(1, e.life * 0.8);
      trace((i) => e.shape[i] * (1 - relax) + e.mean * relax, grow, e.angle);
      ctx.lineWidth = 1.4 + e.strength;
      ctx.strokeStyle = hsla(hue, 100, 58, (1 - e.life) * (0.15 + e.strength * 0.35));
      ctx.stroke();
    });

    // the planet, with the waveform as a thin ring of its own just outside it
    drawGlobe(cx, cy, base * (0.4 + soft * 0.05 + punch * 0.03 + num(f.bar, 0) * 0.04), hue, state.globeSpin, 0.78, 1.5);
    if (wave) {
      ctx.beginPath();
      const pts = 120;
      for (let i = 0; i <= pts; i++) {
        const u = i / pts;
        const tri = u < 0.5 ? u * 2 : 2 - u * 2;
        const w = (wave[Math.floor(tri * (span - 1))] - 128) / 128;
        const angle = u * Math.PI * 2 - state.radialAngle * 2;
        const r = base * 0.58 + w * base * 0.09;
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = hsla(hue, 100, 62, 0.4);
      ctx.stroke();
    }

    // the line itself
    trace((i) => shape[i], 1, state.radialAngle);
    ctx.fillStyle = hsla(hue, 100, 50, 0.06);
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.strokeStyle = hsla(hue, 100, 52, 0.2);
    ctx.stroke();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = hsla(hue, 100, 58, 0.97);
    ctx.stroke();

    // marks outside the line that hang at the peaks and fall with gravity, like the caps of the bars
    ctx.fillStyle = hsla(hue, 100, 68, 0.9);
    const marks = Math.floor(used / 2);
    for (let m = 0; m < marks; m++) {
      const i = Math.round((m * used) / marks);
      const pk = softCeiling(bars.peak[first + i]);
      const r = base * swell * (0.74 + Math.max(radii[i], pk) * 0.98) + 10;
      const angle = -Math.PI / 2 + (i / used) * Math.PI * 2 + state.radialAngle;
      ctx.fillRect(cx + Math.cos(angle) * r - 1.5, cy + Math.sin(angle) * r - 1.5, 3, 3);
    }
  };

  // stars flying at the camera. they are spread over a wide field, wide enough that the whole screen is full of them (not a crowd round
  // the middle), and the nearer to the edge of the screen one is, the bigger it is drawn, like something passing close by
  const STAR_COUNT = 460;
  const STAR_FOCAL = 150;
  const renderStarfield = (f) => {
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const reach = (W * 0.5 * W * 0.55) / STAR_FOCAL; // the field is as wide as the screen from half way back
    const fresh = (star, far) => {
      star.x = (Math.random() - 0.5) * 2 * reach;
      star.y = (Math.random() - 0.5) * 2 * reach * (H / W);
      star.z = far ? W : Math.random() * W;
      return star;
    };
    if (!state.stars || state.starsFor !== W) {
      state.stars = Array.from({ length: STAR_COUNT }, () => fresh({}, false));
      state.starsFor = W;
    }
    const k = frames(f);
    const corner = Math.hypot(cx, cy);
    // bass drives most of the warp-speed feeling now instead of overall
    // volume - a bassy hit should visibly throw stars past the camera
    const drive = kickDrive(f);
    const speed = (f.isPlaying ? 2 + f.volumeLevel * 4 + drive * 22 : 1) * k;
    state.stars.forEach((star) => {
      star.z -= speed;
      if (star.z <= 1) fresh(star, true);
      const scale = STAR_FOCAL / star.z;
      const sx = star.x * scale + cx;
      const sy = star.y * scale + cy;
      if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) {
        // flew off the side of the screen: it comes back from far away
        if (star.z < W * 0.9) fresh(star, true);
        return;
      }
      const near = 1 - star.z / W;
      const edge = Math.min(1, Math.hypot(sx - cx, sy - cy) / corner);
      const size = Math.max(0.5, (0.5 + near * 1.6) * (1 + edge * 2.6) * (1 + drive * 0.5));
      ctx.fillStyle = hsla(f.baseHue, 100, 54, Math.min(1, near * 1.5 + 0.05 + drive * 0.2));
      ctx.beginPath();
      ctx.arc(sx, sy, size, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  const renderPulseGrid = (f) => {
    const cols = 20;
    const rows = 12;
    const cellW = canvas.width / cols;
    const cellH = canvas.height / rows;
    const colAmps = Array.from({ length: cols }, (_, col) => ampForBarRange(col, cols, f.dataArray));
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        // bass columns (low index) get boosted same as bars/radial, so
        // the left side of the grid visibly floods on a bass hit
        const bassWeight = Math.max(0, 1 - col / (cols * 0.15));
        const raw = Math.min(1, colAmps[col] * (1 + f.bassPulse * bassWeight * 0.8));
        const rowFalloff = 1 - Math.abs(row - rows / 2) / (rows / 2);
        const intensity = f.isPlaying ? raw * rowFalloff : rowFalloff * 0.05;
        if (intensity < 0.03) continue;
        ctx.fillStyle = hsla(f.baseHue, 100, 54, intensity * 0.9);
        const pad = 2;
        ctx.fillRect(col * cellW + pad, row * cellH + pad, cellW - pad * 2, cellH - pad * 2);
      }
    }
  };

  const renderNetwork = (f) => {
    if (!state.nodes) state.nodes = makeFloatParticles(80);
    // like the particles it follows the soft pulse: the web swells a little on the beat and settles, it does not light up on every
    // bump in the bass (that was the flashing)
    const soft = num(f.soft, f.bassPulse * 0.3);
    // the kick drives the web like the particles (see them): a hit makes it swell and the nodes jump
    const drive = kickDrive(f);
    const react = clamp(soft * 0.8 + drive * 1.1, 0, 1.6);
    const k = frames(f);
    const pulseFactor = f.isPlaying ? (0.75 + react * 1.1) : 0.5;
    const speedMul = f.isPlaying ? 1.3 + react * 3 + f.volumeLevel * 1.8 : 0.8;
    state.nodes.forEach((node) => {
      node.kx = clamp((node.kx || 0) * Math.pow(0.9, k) + (Math.random() - 0.5) * drive * 2.5 * k, -8, 8);
      node.ky = clamp((node.ky || 0) * Math.pow(0.9, k) + (Math.random() - 0.5) * drive * 2.5 * k, -8, 8);
      node.x += node.vx * speedMul * k + node.kx * k;
      node.y += node.vy * speedMul * k + node.ky * k;
      if (node.x < 0) node.x = canvas.width;
      if (node.x > canvas.width) node.x = 0;
      if (node.y < 0) node.y = canvas.height;
      if (node.y > canvas.height) node.y = 0;
    });
    // connection range swells with the beat, the whole web expands a little
    const maxDist = 120 + react * 70;
    const limit2 = maxDist * maxDist;
    ctx.lineWidth = 1 + react * 0.8;
    for (let i = 0; i < state.nodes.length; i++) {
      for (let j = i + 1; j < state.nodes.length; j++) {
        const a = state.nodes[i];
        const b = state.nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < limit2) {
          const alpha = Math.min(0.85, (1 - Math.sqrt(d2) / maxDist) * 0.9 * pulseFactor);
          ctx.strokeStyle = hsla(f.baseHue, 100, 54, alpha);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    ctx.fillStyle = hsla(f.baseHue, 100, 64, 0.92);
    state.nodes.forEach((node) => {
      ctx.beginPath();
      ctx.arc(node.x, node.y, 1.8 * pulseFactor + 1 + react * 1.2, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  // the spectrum standing on the surface of water. above the line the bars, sharp. below it their reflection, cut into thin slices that
  // are pushed sideways by waves (the further down, the more), faded with depth, with a body of darker water, and rings that
  // spread from the surface on the beat
  const renderMirrorSpectrum = (f) => {
    const W = canvas.width;
    const H = canvas.height;
    const midY = Math.round(H * 0.5);
    const hue = f.baseHue;
    const barCount = 80;
    const slot = W / barCount;
    const barW = Math.max(2, slot * 0.58);
    const k = frames(f);
    const soft = num(f.soft, f.bassPulse * 0.3);
    state.waterT = (state.waterT || 0) + ((f.dt || 33) / 1000) * (1 + soft * 0.9);
    const t = state.waterT;
    const bars = fallingBars('mirror', barCount, f);
    const skyH = H * (0.36 - num(f.inset && f.inset.top, 0) * 0.6);

    const heights = state.mirrorHeights && state.mirrorHeights.length === barCount ? state.mirrorHeights : (state.mirrorHeights = new Float32Array(barCount));
    let maxH = 2;
    for (let i = 0; i < barCount; i++) {
      const bassWeight = Math.max(0, 1 - i / (barCount * 0.14));
      const boosted = softCeiling(bars.v[i] * (1 + f.bassPulse * bassWeight * 0.7 + f.bassPulse * 0.12));
      heights[i] = f.isPlaying ? Math.max(2, boosted * skyH) : 2;
      if (heights[i] > maxH) maxH = heights[i];
    }

    // the water itself: darker at the surface, gone at the bottom of the screen
    const body = ctx.createLinearGradient(0, midY, 0, H);
    body.addColorStop(0, hsla(hue, 100, 30, 0.38));
    body.addColorStop(0.5, hsla(hue, 100, 22, 0.16));
    body.addColorStop(1, hsla(hue, 100, 18, 0));
    ctx.fillStyle = body;
    ctx.fillRect(0, midY, W, H - midY);

    // the bars, one flat color
    ctx.fillStyle = hsla(hue, 100, 54, 0.95);
    for (let i = 0; i < barCount; i++) ctx.fillRect(i * slot + (slot - barW) / 2, midY - heights[i], barW, heights[i]);
    if (f.isPlaying) {
      ctx.fillStyle = hsla(hue, 100, 80, 0.95);
      for (let i = 0; i < barCount; i++) {
        const peak = Math.max(heights[i], softCeiling(bars.peak[i]) * skyH);
        ctx.fillRect(i * slot + (slot - barW) / 2, midY - peak - 4, barW, 2.5);
      }
    }

    // the reflection source: the same bars on a small canvas, standing on its bottom edge. half size, which softens them like a blur
    const sc = 0.5;
    const rw = Math.max(1, Math.ceil(W * sc));
    const rh = Math.max(1, Math.ceil(midY * sc));
    if (!state.reflect) {
      state.reflect = document.createElement('canvas');
      state.reflectCtx = state.reflect.getContext('2d');
    }
    if (state.reflect.width !== rw || state.reflect.height !== rh) {
      state.reflect.width = rw;
      state.reflect.height = rh;
    }
    const rctx = state.reflectCtx;
    rctx.clearRect(0, 0, rw, rh);
    rctx.fillStyle = hsla(hue, 100, 54, 1);
    for (let i = 0; i < barCount; i++) rctx.fillRect((i * slot + (slot - barW) / 2) * sc, rh - heights[i] * sc, barW * sc, heights[i] * sc);

    // the slices. d is how far below the surface a slice is, in pixels of the screen
    const slice = 3;
    const depth = maxH + slice * 2;
    const surge = 1 + soft * 0.9;
    for (let d = 0; d < depth; d += slice) {
      const srcY = rh - (d + slice) * sc;
      if (srcY < 0) break;
      const dx = (1.2 + d * 0.045) * (Math.sin(d * 0.07 + t * 2.0) + 0.6 * Math.sin(d * 0.19 - t * 2.9)) * surge;
      const fade = Math.pow(1 - d / depth, 1.3);
      ctx.globalAlpha = clamp(0.85 * fade * (0.9 + 0.1 * Math.sin(d * 0.05 + t * 3)), 0, 1);
      ctx.drawImage(state.reflect, 0, srcY, rw, slice * sc, dx, midY + d, W, slice);
    }
    ctx.globalAlpha = 1;

    // the surface: a bright line and a short glow under it
    const glow = ctx.createLinearGradient(0, midY, 0, midY + 22);
    glow.addColorStop(0, hsla(hue, 100, 62, 0.34));
    glow.addColorStop(1, hsla(hue, 100, 62, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, midY, W, 22);
    ctx.fillStyle = hsla(hue, 100, 70, 0.9);
    ctx.fillRect(0, midY - 1, W, 2.5);

    // rings from the surface. with a tempo: a small one on every beat and a big one on the first beat of a bar. without one: when the
    // sound itself hits (hitDetector), which also hears soft music
    if (!state.ripples) state.ripples = [];
    const beatNo = num(f.beatCount, 0);
    const barNo = num(f.barCount, 0);
    if (state.lastBeatNo === undefined) { state.lastBeatNo = beatNo; state.lastBarNo = barNo; }
    if (f.isPlaying && f.locked) {
      if (barNo !== state.lastBarNo) state.ripples.push({ life: 0, strength: 1, x: W * (0.3 + 0.4 * hash01(barNo)) });
      else if (beatNo !== state.lastBeatNo) state.ripples.push({ life: 0, strength: 0.4, x: W * (0.15 + 0.7 * hash01(beatNo + 500)) });
    } else {
      const hit = hitDetector('mirrorHits', bars, barCount, f);
      if (hit > 0) state.ripples.push({ life: 0, strength: hit, x: W / 2 });
    }
    state.lastBeatNo = beatNo;
    state.lastBarNo = barNo;
    if (state.ripples.length > 7) state.ripples.splice(0, state.ripples.length - 7);
    state.ripples = state.ripples.filter((ripple) => ripple.life < 1);
    if (state.ripples.length) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, midY, W, H - midY);
      ctx.clip();
      state.ripples.forEach((ripple) => {
        ripple.life += (0.012 + ripple.strength * 0.014) * k;
        const radius = ripple.life * W * (0.22 + ripple.strength * 0.3);
        const alpha = (1 - ripple.life) * (0.4 + ripple.strength * 0.5);
        ctx.strokeStyle = hsla(hue, 100, 70, alpha);
        ctx.lineWidth = 2 + ripple.strength * 1.5;
        ctx.beginPath();
        ctx.ellipse(ripple.x, midY + 2, radius, radius * 0.13, 0, 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.restore();
    }
  };

  const renderMinimalPulse = (f) => {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const baseRadius = Math.min(canvas.width, canvas.height) * 0.08;
    const pulse = f.isPlaying ? baseRadius * (1 + f.bassPulse * 1.8) : baseRadius;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, pulse * 2);
    gradient.addColorStop(0, hsla(f.baseHue, 100, 54, 0.6));
    gradient.addColorStop(1, hsla(f.baseHue, 100, 54, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, pulse * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hsla(f.baseHue, 100, 60, 0.95);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, pulse, 0, Math.PI * 2);
    ctx.stroke();
  };

  // ---------------------------------------------------------------------------------------------------------------------------------
  // the corridor (preset key runner): a ten sided tube of wire that drifts slowly away from you, lit by the walls. the light is a soft
  // radial glow with a lot of blur, in patches along the walls (the bass at the bottom, the highs on top, the same on both sides), so it
  // looks as if it comes from the walls and not from the far end. every ring is born next to you with the sound of that moment and keeps it
  // while it recedes. the lines get thinner and blurrier with distance (the fog) and there are fewer of them: only every second ring is
  // kept beyond a few rings, every fourth further out, and the long lines fade out early, so the middle never turns into a knot. with a
  // tempo the pace is the tempo: a ring is born on every beat (or every second one when that would be fast) and the rings are held on the
  // beat clock. nothing moves with the beat except the light
  // ---------------------------------------------------------------------------------------------------------------------------------
  const TUN_SIDES = 10;
  const TUN_BANDS = 8;
  // the bars that shape the light of the walls, and the points the wall's edge is drawn through
  const TUN_WALL = 72;
  const TUN_WALL_POINTS = 72;
  const TUN_SPACING = 0.45;
  const TUN_AHEAD = 11;
  const TUN_NEAR = 0.3;
  const TUN_FARTHEST = Math.ceil(TUN_AHEAD / TUN_SPACING) + 2;
  const TUN_RINGS = TUN_FARTHEST + 4;

  const makeTunnel = (W, H) => ({
    W,
    H,
    t: TUN_AHEAD + 2,
    newest: Math.floor((TUN_AHEAD + 2) / TUN_SPACING) - 1,
    speed: 0.5,
    loud: 0,
    glow: 0,
    glowShown: 0,
    lastBeatNo: undefined,
    lastBarNo: undefined,
    lockOff: undefined,
    lockStride: 0,
    err: 0,
    lockedAt: -1e9,
    lastPeriod: 0,
    light: new Float32Array(TUN_BANDS),
    wall: new Float32Array(TUN_WALL)
  });

  // how much of a ring is kept at a distance: all of them near, every second one from 3 to 5, every fourth from 6 to 8 (a fade, so none pops)
  const tunnelKeep = (k, z) => {
    if (z < 3) return 1;
    let a = 1;
    if (k & 1) a *= 1 - clamp((z - 3) / 2, 0, 1);
    else if (k & 2) a *= 1 - clamp((z - 6) / 2, 0, 1);
    return a;
  };

  const renderRunner = (f) => {
    const W = canvas.width;
    const H = canvas.height;
    const hue = f.baseHue;
    const dt = clamp((f.dt || 33) / 1000, 0.004, 0.1);
    const playing = f.isPlaying;
    let R = state.tun;
    if (!R || R.W !== W || R.H !== H) R = state.tun = makeTunnel(W, H);
    const soft = num(f.soft, f.bassPulse * 0.3);
    const period = num(f.period, 0) / 1000;
    const locked = Boolean(f.locked) && period > 0.25 && period < 1.6 && playing;
    const fade = num(f.fadeProgress, 1);
    const unit = Math.min(W, H);
    const sc = clamp(unit / 600, 0.8, 2);

    // --- the pace. with a tempo: one ring a beat (a ring every second beat when that would be fast). the speed is the tempo's and the beat clock only
    // nudges it, a few percent either way and smoothed, so the pace never stops, however the clock jumps (the first version pulled the position to
    // the clock, which cancelled the forward speed whenever the clock moved by a quarter of a ring). without a tempo: slow, following how loud the
    // music has been over the last seconds. a tempo that is lost for a moment is kept for three seconds
    R.loud += ((playing ? clamp(num(f.volumeLevel, 0), 0, 1) : 0) - R.loud) * Math.min(1, dt * 0.7);
    const nowMs = num(f.now, 0);
    if (locked) { R.lockedAt = nowMs; R.lastPeriod = period; }
    const holding = !locked && playing && R.lastPeriod > 0 && nowMs - R.lockedAt < 3000 && R.lockStride > 0;
    if (locked || holding) {
      const per = locked ? period : R.lastPeriod;
      // the stride: how many beats between two rings. it only changes when the pace would be clearly too fast or clearly slower than needed
      let stride = R.lockStride || 0;
      if (!stride) {
        stride = 1;
        while (TUN_SPACING / (stride * per) > 1.1 && stride < 4) stride += 1;
      } else if (TUN_SPACING / (stride * per) > 1.3 && stride < 4) stride += 1;
      else if (stride > 1 && TUN_SPACING / ((stride - 1) * per) < 0.95) stride -= 1;
      const base = clamp(TUN_SPACING / (stride * per), 0.22, 1.4);
      let nudge = 0;
      if (locked) {
        const beats = num(f.beatCount, 0) + clamp(num(f.phase, 0), 0, 0.999);
        const target = (beats / stride) * TUN_SPACING;
        // the first picture of a lock (and a change of stride) takes an offset that is a whole number of rings, so nothing jumps
        if (R.lockOff === undefined || R.lockStride !== stride) {
          R.lockOff = Math.round((R.t - target) / TUN_SPACING) * TUN_SPACING;
          R.lockStride = stride;
          R.err = 0;
        }
        let err = target + R.lockOff - R.t;
        err -= Math.round(err / TUN_SPACING) * TUN_SPACING;
        R.err += (err - R.err) * Math.min(1, dt * 1.2);
        nudge = clamp(R.err / (TUN_SPACING * 0.5), -1, 1) * 0.18;
      } else {
        R.lockStride = stride;
      }
      R.speed += (base * (1 + nudge) - R.speed) * Math.min(1, dt * 2.5);
      R.t += Math.max(0.2, R.speed) * dt;
    } else {
      R.lockOff = undefined;
      R.lockStride = 0;
      R.err = 0;
      const wantSpeed = playing ? 0.45 + R.loud * 0.6 : 0.25;
      R.speed += (wantSpeed - R.speed) * Math.min(1, dt * 0.9);
      R.t += Math.max(0.2, R.speed) * dt;
    }

    // --- the sound of this moment: eight bands from the bass up. they go round the tube once, the bass at the bottom
    const bars = fallingBars('tunnel', 24, f);
    const levels24 = normalizeCorridorLevels(bars.v, R.levelScale24 || (R.levelScale24 = {}), dt);
    const band = (a, b) => { let m = 0; for (let i = a; i < b; i++) if (levels24[i] > m) m = levels24[i]; return m; };
    const BAND_FROM = [0, 1, 3, 5, 8, 11, 15, 19];
    const BAND_TO = [2, 4, 6, 9, 12, 16, 20, 24];
    const cur = BAND_FROM.map((from, b) => (playing ? band(from, BAND_TO[b]) : 0));

    // --- the glow: a beat (a bar: more) with a tempo, else a hit of the sound itself. it rises within a few pictures and fades slowly
    const beatNo = num(f.beatCount, 0);
    const barNo = num(f.barCount, 0);
    if (R.lastBeatNo === undefined) { R.lastBeatNo = beatNo; R.lastBarNo = barNo; }
    const hit = hitDetector('tunnelHits', bars, 24, f);
    let strength = 0;
    if (locked) {
      if (barNo !== R.lastBarNo) strength = 1;
      else if (beatNo !== R.lastBeatNo) strength = 0.6;
    } else if (hit > 0) strength = 0.3 + hit * 0.5;
    R.lastBeatNo = beatNo;
    R.lastBarNo = barNo;
    if (strength > 0) R.glow = Math.max(R.glow, strength);
    R.glow = Math.max(0, R.glow - dt * 1.6);
    R.glowShown += (R.glow - R.glowShown) * Math.min(1, dt * 10);
    // the wall lights follow the bands: quick up, slow down
    for (let b = 0; b < TUN_BANDS; b++) R.light[b] += (cur[b] - R.light[b]) * Math.min(1, dt * (cur[b] > R.light[b] ? 14 : 3));
    // the bars of the wall: 96 of them, their own reading of the sound
    const wallBars = fallingBars('wall', TUN_WALL, f);
    const wallLevels = normalizeCorridorLevels(wallBars.v, R.levelScaleWall || (R.levelScaleWall = {}), dt);
    for (let i = 0; i < TUN_WALL; i++) {
      const want = playing ? wallLevels[i] : 0;
      R.wall[i] += (want - R.wall[i]) * Math.min(1, dt * (want > R.wall[i] ? 14 : 3));
    }

    // --- the rings that were born since the last picture (a ring is a plain ring, it carries nothing of the sound)
    const newest = Math.floor(R.t / TUN_SPACING);
    if (R.newest < newest) R.newest = newest;

    // --- drawing. one color: the theme color, and only the opacity moves
    ctx.save();
    ctx.globalAlpha = 0.3 + 0.7 * fade;
    const CX = W / 2;
    const CY = H * 0.5;
    // the rings are circles (polygons of ten sides), the same in a wide window as in a tall one. the strips of the bars radiate from the middle in a bigger circle,
    // big enough to reach the corners of the window
    const FR = unit * 0.5;
    const FS = Math.hypot(W, H) * 0.5;
    const fogAt = (z) => Math.pow(clamp(1 - (z - TUN_NEAR) / TUN_AHEAD, 0, 1), 1.6);
    const bloom = R.glowShown;
    // the general intensity of the music, 0 to 1: how loud the bars are on the whole, with the beat on top. everything lights up with it at once
    let mean = 0;
    for (let i = 0; i < TUN_WALL; i++) mean += R.wall[i];
    mean /= TUN_WALL;
    const inten = clamp(mean * 1.4 + bloom * 0.5 + soft * 0.3, 0, 1);
    const COLOR_L = 54;

    // the bars on the walls: 24 tapered strips from the edge of the window toward the middle (bass at the bottom, clockwise, the last one next to the first).
    // a strip is as long as its bar is loud and as bright as its bar and the general intensity are. locked in place, blurred: a wide faint copy under a
    // narrow one
    const polar = (angle, r) => [CX + Math.sin(angle) * FS * r, CY + Math.cos(angle) * FS * r];
    // the wall of light: 96 bars packed side by side round the circle (the bass at the bottom, clockwise), each as long as it is loud and fading out toward the middle (no tip,
    // nothing at the end of a bar that rises and falls). they are drawn small and sharp on a layer of their own, which is then stretched up to the window: the stretching
    // blurs them into one solid force, the way the background of the bars visualizer is soft. drawn before the rings so the rings are in front
    {
      // drawn small, then halved three times and stretched to the window for a broad, soft low-pass glow
      const REDUCE = 9;
      const lw = Math.max(16, Math.ceil(W / REDUCE));
      const lh = Math.max(16, Math.ceil(H / REDUCE));
      if (!R.layers || R.layers[0].width !== lw || R.layers[0].height !== lh) {
        R.layers = [lw, lw >> 1, lw >> 2, lw >> 3].map((w, k) => {
          const c = document.createElement('canvas');
          c.width = Math.max(4, w);
          c.height = Math.max(4, lh >> k);
          return c;
        });
        R.layerCtx = R.layers[0].getContext('2d');
      }
      const lctx = R.layerCtx;
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, lw, lh);
      lctx.setTransform(lw / W, 0, 0, lh / H, 0, 0);
      // every bar is a narrow core and a much wider, fainter aura: the auras of neighbours overlap, so there are no gaps between the bars
      const sector = Math.PI * 2 / TUN_WALL;
      const CUTS = 6;
      const quad = (angle, halfWidth, r0, r1, alpha) => {
        lctx.beginPath();
        lctx.moveTo(CX + Math.sin(angle - halfWidth) * FS * r0, CY + Math.cos(angle - halfWidth) * FS * r0);
        lctx.lineTo(CX + Math.sin(angle + halfWidth) * FS * r0, CY + Math.cos(angle + halfWidth) * FS * r0);
        lctx.lineTo(CX + Math.sin(angle + halfWidth) * FS * r1, CY + Math.cos(angle + halfWidth) * FS * r1);
        lctx.lineTo(CX + Math.sin(angle - halfWidth) * FS * r1, CY + Math.cos(angle - halfWidth) * FS * r1);
        lctx.closePath();
        lctx.fillStyle = hsla(hue, 100, COLOR_L, alpha);
        lctx.fill();
      };
      for (let i = 0; i < TUN_WALL; i++) {
        const level = R.wall[i];
        const angle = ((i + 0.5) / TUN_WALL) * Math.PI * 2;
        const rOut = 1.15;
        // no cap: a bar reaches as far down the corridor as it is loud, all the way to the middle when it is loud enough
        const rIn = corridorBarInnerRadius(level);
        const strength = clamp((0.16 + 0.9 * level) * (0.8 + 0.4 * inten), 0, 1);
        for (let c = 0; c < CUTS; c++) {
          const r0 = rOut + (rIn - rOut) * (c / CUTS);
          const r1 = rOut + (rIn - rOut) * ((c + 1) / CUTS);
          // the bar fades out toward the middle, so it has no end and nothing that rises and falls there
          const fadeOut = 1 - (c + 0.5) / CUTS;
          const aura = strength * 0.16 * fadeOut;
          const core = strength * 0.25 * fadeOut;
          if (aura >= 0.005) quad(angle, sector * 1.7, r0, r1, aura);
          if (core >= 0.005) quad(angle, sector * 0.62, r0, r1, core);
        }
      }
      for (let k = 1; k < R.layers.length; k++) {
        const c = R.layers[k].getContext('2d');
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, R.layers[k].width, R.layers[k].height);
        c.imageSmoothingEnabled = true;
        c.imageSmoothingQuality = 'high';
        c.drawImage(R.layers[k - 1], 0, 0, R.layers[k].width, R.layers[k].height);
      }
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(R.layers[R.layers.length - 1], 0, 0, W, H);
      ctx.restore();
    }

    // the rings, from far to near. thin and faint far away (the fog), only some of them far out, a soft glow only on the near ones
    const ringAlpha = 0.5 + 0.4 * inten;
    for (let j = TUN_FARTHEST; j >= 1; j--) {
      const k = R.newest - j + 1;
      const z = TUN_NEAR + (R.t - k * TUN_SPACING);
      if (z - TUN_NEAR > TUN_AHEAD) continue;
      const fog = fogAt(z);
      if (fog < 0.004) continue;
      const keep = tunnelKeep(k, z);
      if (keep < 0.01) continue;
      const depth = clamp((z - TUN_NEAR) / TUN_AHEAD, 0, 1);
      const w = clamp(3.2 / (1 + z * 0.7), 0.35, 3.2) * sc;
      const halo = 3.2 * sc * clamp(1 - depth / 0.4, 0, 1);
      const ringPath = () => {
        ctx.beginPath();
        for (let v = 0; v < TUN_SIDES; v++) {
          const a = (v / TUN_SIDES) * Math.PI * 2;
          const x = CX + Math.sin(a) * FR / z;
          const y = CY + Math.cos(a) * FR / z;
          if (v === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
      };
      const alpha = ringAlpha * fog * keep * (1 - 0.6 * depth);
      if (halo > 0.2) {
        ringPath();
        ctx.lineWidth = w + halo;
        ctx.strokeStyle = hsla(hue, 100, COLOR_L, alpha * 0.14 * clamp(1 - depth / 0.4, 0, 1));
        ctx.stroke();
      }
      ringPath();
      ctx.lineWidth = w;
      ctx.strokeStyle = hsla(hue, 100, COLOR_L, alpha);
      ctx.stroke();
    }
    // the fog at the far end, on top of everything: dark, so the rings that have already passed vanish into it
    const fogR = unit * 0.26;
    const fogCore = ctx.createRadialGradient(CX, CY, 0, CX, CY, fogR);
    // the middle is always the same dark: solid black to 0.4 of the fog's radius, then fading out. the light of the walls can not show through it,
    // so the middle does not get lighter with the beat (the walls light up and fade, the middle stays)
    fogCore.addColorStop(0, 'rgba(0, 0, 0, 1)');
    fogCore.addColorStop(0.4, 'rgba(0, 0, 0, 1)');
    fogCore.addColorStop(0.6, 'rgba(0, 0, 0, 0.45)');
    fogCore.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = fogCore;
    ctx.fillRect(CX - fogR, CY - fogR, fogR * 2, fogR * 2);
    ctx.restore();
  };

  const themed = (draw) => (f) => { setTheme(f); draw(f); };
  const RENDERERS = {
    none: () => {},
    particles: themed(renderParticles),
    bars: themed(renderBars),
    wave: themed(renderWave),
    radial: themed(renderRadial),
    starfield: themed(renderStarfield),
    pulseGrid: themed(renderPulseGrid),
    network: themed(renderNetwork),
    mirrorSpectrum: themed(renderMirrorSpectrum),
    minimalPulse: themed(renderMinimalPulse),
    runner: themed(renderRunner)
  };

  return RENDERERS;
}
