// where the bars of a spectrum drawing sit on the frequency axis, and how loud each one reads. the app's ampForBarRange (App.js) and the
// tests use this one function.
//
// what was there before spaced the bars evenly on a log scale from 20 Hz to 20 kHz and read the loudest bin under each. the analyser's bins
// are evenly spaced (10.8 Hz apart at 4096 samples), so down in the bass many bars were narrower than one bin and several bars read the
// very same bin: runs of 3 or 4 bars of exactly the same height, which is the grouping that showed in the bass. the ends of the range
// (under 30 Hz, over 16 kHz) are nearly empty in music, and the bass was far taller than everything else because music is loud there
// and quiet up high.
//
// now: the bars start at 32 Hz and end at 16 kHz. the width of a bar is a log step but never less than one bin, so no two bars share a
// bin (linear at the bottom, log above, like the mel scale does), and a bar narrower than two bins is read between its two bins instead
// of rounded to one. a tilt lifts the highs and lowers the bass by 3.5 dB for every octave away from 500 Hz (music falls off about that
// fast, a spectrum analyser does the same), and it is only applied to what is really there, so silence stays at zero

export const MIN_HZ = 32;
export const MAX_HZ = 16000;
const TILT_DB_PER_OCTAVE = 3.5;
const TILT_REFERENCE_HZ = 500;
// the analyser maps its decibel range onto 0..255: 85 dB for the main one, so about 3 bytes for a decibel
const BYTES_PER_DB = 3;

const edgeCache = new Map();

// count + 1 edges in Hz: each bar is a step of ratio r, or one bin if that is wider, r chosen so that count steps end at MAX_HZ
export function barEdges(count, binHz) {
  const key = `${count}:${binHz.toFixed(3)}`;
  let edges = edgeCache.get(key);
  if (edges) return edges;
  const steps = (r) => {
    let e = MIN_HZ;
    let k = 0;
    while (e < MAX_HZ && k < count * 4) { e = Math.max(e * r, e + binHz); k += 1; }
    return k;
  };
  let lo = 1.0001;
  let hi = 2;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (steps(mid) > count) lo = mid; else hi = mid;
  }
  edges = new Float64Array(count + 1);
  edges[0] = MIN_HZ;
  for (let i = 1; i <= count; i += 1) edges[i] = Math.max(edges[i - 1] * hi, edges[i - 1] + binHz);
  edgeCache.set(key, edges);
  return edges;
}

// how loud the index-th of count bars is, 0 to 1. data: the bytes of getByteFrequencyData, rate: the sample rate of the audio context
export function barAmp(index, count, data, rate = 44100) {
  if (!data || !data.length) return 0;
  const binHz = rate / 2 / data.length;
  const edges = barEdges(count, binHz);
  const lo = edges[index] / binHz;
  const hi = edges[index + 1] / binHz;
  const center = Math.sqrt(edges[index] * edges[index + 1]) / binHz;
  const last = data.length - 1;
  // between the two bins around the middle of the bar
  const c0 = Math.min(last, Math.floor(center));
  const c1 = Math.min(last, c0 + 1);
  const frac = center - c0;
  let value = data[c0] * (1 - frac) + data[c1] * frac;
  // and the loudest bin that starts inside the bar (a bin belongs to one bar only, so neighbours do not share it)
  const first = Math.max(0, Math.ceil(lo));
  const end = Math.min(last, Math.ceil(hi) - 1);
  for (let b = first; b <= end; b += 1) if (data[b] > value) value = data[b];
  if (value <= 0) return 0;
  const hz = Math.sqrt(edges[index] * edges[index + 1]);
  const tilt = TILT_DB_PER_OCTAVE * BYTES_PER_DB * Math.log2(hz / TILT_REFERENCE_HZ);
  // the tilt fades in over the first 64 bytes, so a bar that has nothing in it gets nothing added
  const lifted = value + tilt * Math.min(1, value / 64);
  return Math.max(0, Math.min(1, lifted / 255));
}
