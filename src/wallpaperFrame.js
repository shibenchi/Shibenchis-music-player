// the picture of the sound that goes from the app window to the live wallpaper window (computer app): one frame about 30 times a
// second while a song plays. the wallpaper window has no audio of its own, this is all it knows about the music.
//
// a frame holds 96 bars of the spectrum (log spaced like the bars of the background, 0 to 255) and 512 points of the waveform,
// packed as base64 text. as json numbers the same frame would be five times bigger, and it goes through the app's message
// channel 30 times a second
export const SPEC_BARS = 96;
export const WAVE_POINTS = 512;

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x2000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
  return btoa(text);
}

function fromBase64(text, length) {
  const out = new Uint8Array(length);
  try {
    const raw = atob(text || '');
    const count = Math.min(length, raw.length);
    for (let i = 0; i < count; i += 1) out[i] = raw.charCodeAt(i);
  } catch {
    // a broken frame is a silent one
  }
  return out;
}

// the 96 bars from the analyser's frequency bins. ampForBarRange is the app's own log spaced peak reading (0 to 1)
export function buildSpectrum(dataArray, ampForBarRange) {
  const spec = new Uint8Array(SPEC_BARS);
  if (!dataArray) return spec;
  for (let i = 0; i < SPEC_BARS; i += 1) spec[i] = Math.round(ampForBarRange(i, SPEC_BARS, dataArray) * 255);
  return spec;
}

// the whole time domain buffer (about 46 ms of sound) shrunk to 512 points. silence (128) when there is none
export function buildWave(timeData) {
  const wave = new Uint8Array(WAVE_POINTS).fill(128);
  if (!timeData || !timeData.length) return wave;
  const step = timeData.length / WAVE_POINTS;
  for (let i = 0; i < WAVE_POINTS; i += 1) wave[i] = timeData[Math.floor(i * step)];
  return wave;
}

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

export function packFrame({ baseHue, sat, light, isPlaying, preset, bassPulse, bassLevel, volumeLevel, soft, beat, bar, bpm, locked, phase, period, beatCount, barCount, beatInBar, spec, wave, song }) {
  return {
    // the song (title, artist, seconds into it, length, playing) is only in the frames where it changed or a second went by
    ...(song ? { n: { t: String(song.title || ''), a: String(song.artist || ''), p: round3(song.position), d: round3(song.duration), y: song.playing ? 1 : 0 } } : {}),
    // the tempo follower's numbers (see vizDrive.js): the slow pulse, the beat and bar envelopes, the tempo and where in the bar it is
    o: round3(soft),
    e: round3(beat),
    r: round3(bar),
    t: Math.round(Number(bpm) || 0),
    l: locked ? 1 : 0,
    q: round3(phase),
    d: Math.round(Number(period) || 0),
    c: Math.round(Number(beatCount) || 0),
    a: Math.round(Number(barCount) || 0),
    i: Math.round(Number(beatInBar) || 0),
    h: Math.round((Number(baseHue) || 0) * 10) / 10,
    // the theme color's saturation and lightness (0 to 100), when the sender knows them
    ...(Number.isFinite(sat) && Number.isFinite(light) ? { sa: Math.round(sat), li: Math.round(light) } : {}),
    p: isPlaying ? 1 : 0,
    preset: preset || 'bars',
    k: round3(bassPulse),
    b: round3(bassLevel),
    v: round3(volumeLevel),
    s: toBase64(spec || new Uint8Array(SPEC_BARS)),
    w: toBase64(wave || new Uint8Array(WAVE_POINTS).fill(128))
  };
}

export function unpackFrame(payload) {
  const frame = payload || {};
  return {
    baseHue: Number(frame.h) || 0,
    ...(Number.isFinite(frame.sa) && Number.isFinite(frame.li) ? { sat: Number(frame.sa), light: Number(frame.li) } : {}),
    isPlaying: frame.p === 1 || frame.p === true,
    preset: typeof frame.preset === 'string' ? frame.preset : 'bars',
    bassPulse: Number(frame.k) || 0,
    bassLevel: Number(frame.b) || 0,
    volumeLevel: Number(frame.v) || 0,
    soft: Number(frame.o) || 0,
    beat: Number(frame.e) || 0,
    bar: Number(frame.r) || 0,
    bpm: Number(frame.t) || 0,
    locked: frame.l === 1 || frame.l === true,
    phase: Number(frame.q) || 0,
    period: Number(frame.d) || 0,
    beatCount: Number(frame.c) || 0,
    barCount: Number(frame.a) || 0,
    beatInBar: Number(frame.i) || 0,
    song: frame.n && typeof frame.n === 'object' ? { title: String(frame.n.t || ''), artist: String(frame.n.a || ''), position: Number(frame.n.p) || 0, duration: Number(frame.n.d) || 0, playing: frame.n.y === 1 } : undefined,
    spec: fromBase64(frame.s, SPEC_BARS),
    wave: fromBase64(frame.w, WAVE_POINTS)
  };
}

// the drawings ask for bars the way the app's analyser gives them: how loud the index-th of count log spaced bars is, 0 to 1.
// here the 64 bars are already made, so a drawing that wants 48 or 20 bars gets the loudest of the 64 under each of its own
export function ampFromSpectrum(index, count, spec) {
  if (!spec || !spec.length) return 0;
  const first = Math.min(spec.length - 1, Math.floor((index / count) * spec.length));
  const last = Math.min(spec.length - 1, Math.max(first, Math.ceil(((index + 1) / count) * spec.length) - 1));
  let peak = 0;
  for (let i = first; i <= last; i += 1) if (spec[i] > peak) peak = spec[i];
  return peak / 255;
}
