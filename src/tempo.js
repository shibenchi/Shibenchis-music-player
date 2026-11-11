// follows the tempo and the beat of the music while it plays, a little more sure of itself every second, for the visualizers.
//
// the kick detector (beat.js) says "a drum just hit". this says "the music runs at 124 beats a minute and the next beat is in 180 ms",
// which is what lets the pictures hit on the beat instead of after it, skip the hits that are only noise, and give every fourth beat
// (the bar) a bigger one.
//
// how: every frame the spectrum of the analyser that does not smooth is turned into one number, how much new sound just started
// (the rise of four bands, kick, snare, voices, hats, each against the loudest of the two frames before). the last eight seconds of
// those numbers are kept. about four times a second the tempo is looked up in them (which gap between hits comes back most, the usual
// autocorrelation with its double and quadruple counted in, leaning a little toward 120 so 60 and 240 do not win), and then the phase
// (where the beats of that tempo fall best on the hits). the phase is moved gently, never jumped, unless the music clearly moved: the
// output is a clock that keeps ticking between the hits, so a missed or weak hit does not make the picture miss a beat
//
// a bar is taken as four beats. which of the four is the first is learned from where the hardest hits fall
// nothing here knows about audio nodes or the screen, it takes the bytes of a spectrum and the time in milliseconds

const GRID_MS = 10;
const HISTORY_MS = 8000;
const GRID_LEN = HISTORY_MS / GRID_MS;
const MIN_BPM = 70;
const MAX_BPM = 180;
const UPDATE_MS = 250;
const MIN_HISTORY_MS = 3000;
// the four bands the new sound is measured in (hz), and how much each counts
const BANDS = [
  [35, 150, 1.0],
  [150, 600, 0.55],
  [600, 3000, 0.4],
  [3000, 10000, 0.3]
];

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export function createTempoTracker({ sampleRate = 44100, fftSize = 2048 } = {}) {
  const hzPerBin = sampleRate / fftSize;
  const bands = BANDS.map(([lo, hi, weight]) => ({
    low: Math.max(1, Math.round(lo / hzPerBin)),
    high: Math.max(2, Math.round(hi / hzPerBin)),
    weight,
    prev1: null,
    prev2: null
  }));

  // the onsets of the last eight seconds, as (time, strength)
  const CAP = 1024;
  const times = new Float64Array(CAP);
  const vals = new Float32Array(CAP);
  let head = 0;
  let count = 0;
  const grid = new Float32Array(GRID_LEN + 8);
  const smooth = new Float32Array(GRID_LEN + 8);
  const ac = new Float32Array(GRID_LEN);

  let mean = 0.02; // the usual size of the onset number, to tell a hit from the rest
  let energyMean = 0;
  let firstAt = null;
  let lastStepAt = null;
  let lastUpdateAt = -Infinity;
  let lastOnsetAt = -Infinity;
  let peakRef = 0.15; // a hard hit, as an onset number

  let bpm = 0;
  let confidence = 0;
  let challenger = 0;
  let challengerCount = 0;
  let anchor = null; // the time of one beat, the others are on a line from it
  let phaseMiss = 0;
  let phaseMissError = 0;
  let lastBeatNumber = null;
  let beatCount = 0; // beats since the clock started (only counts up)
  let beatAt = -Infinity;
  let beatStrength = 0;
  const slotStrength = [0.6, 0.6, 0.6, 0.6]; // how hard the four beats of a bar usually hit, from the first
  const slotAccent = [0.5, 0.5, 0.5, 0.5];
  let downSlot = 0;
  let barAt = -Infinity;
  let barStrength = 0;
  // the hardest onset since the beat before, to rate the beat that just went by
  let peakSince = 0;

  const reset = () => {
    bands.forEach((b) => { b.prev1 = null; b.prev2 = null; });
    head = 0; count = 0;
    mean = 0.02; energyMean = 0; firstAt = null; lastStepAt = null; lastUpdateAt = -Infinity; lastOnsetAt = -Infinity; peakRef = 0.15;
    bpm = 0; confidence = 0; challenger = 0; challengerCount = 0; anchor = null; phaseMiss = 0; phaseMissError = 0;
    lastBeatNumber = null; beatCount = 0; beatAt = -Infinity; beatStrength = 0;
    for (let i = 0; i < 4; i += 1) { slotStrength[i] = 0.6; slotAccent[i] = 0.5; }
    downSlot = 0; barAt = -Infinity; barStrength = 0; peakSince = 0;
  };

  const push = (time, value) => {
    times[head] = time;
    vals[head] = value;
    head = (head + 1) % CAP;
    if (count < CAP) count += 1;
  };

  // the last eight seconds on a 10 ms grid ending at now, each onset shared between the two cells next to it, then blurred a little
  // so hits that are a frame apart (the picture comes at 30 frames a second) still count as the same place
  const fillGrid = (now) => {
    grid.fill(0);
    const start = now - HISTORY_MS;
    for (let n = 0; n < count; n += 1) {
      const idx = (head - 1 - n + CAP) % CAP;
      const t = times[idx];
      if (t < start) break;
      const pos = (t - start) / GRID_MS;
      const i = Math.floor(pos);
      const frac = pos - i;
      if (i >= 0 && i < GRID_LEN) {
        grid[i] += vals[idx] * (1 - frac);
        grid[i + 1] += vals[idx] * frac;
      }
    }
    // triangle, three cells each way
    for (let i = 0; i < GRID_LEN; i += 1) {
      smooth[i] = (grid[i - 3 >= 0 ? i - 3 : 0] * 0.0625 + grid[i - 2 >= 0 ? i - 2 : 0] * 0.125 + grid[i - 1 >= 0 ? i - 1 : 0] * 0.1875 +
        grid[i] * 0.25 + grid[i + 1] * 0.1875 + grid[i + 2] * 0.125 + grid[i + 3] * 0.0625);
    }
  };

  const sampleSmooth = (cell) => {
    if (cell < 0 || cell >= GRID_LEN - 1) return 0;
    const i = Math.floor(cell);
    const f = cell - i;
    return smooth[i] * (1 - f) + smooth[i + 1] * f;
  };

  const estimate = (now) => {
    fillGrid(now);
    // the autocorrelation of the blurred onsets, a gap between hits scored by how often two hits are that far apart. each lag is
    // divided by how many pairs there were, a long lag has fewer
    const maxLag = Math.min(GRID_LEN - 40, Math.round(60000 / MIN_BPM / GRID_MS) * 4 + 4);
    let total = 0;
    for (let i = 0; i < GRID_LEN; i += 1) total += smooth[i];
    if (total < 0.25) {
      confidence *= 0.8;
      return;
    }
    for (let lag = 8; lag <= maxLag; lag += 1) {
      let sum = 0;
      const n = GRID_LEN - lag;
      for (let i = 0; i < n; i += 1) sum += smooth[i] * smooth[i + lag];
      ac[lag] = sum / n;
    }
    const minLag = Math.round(60000 / MAX_BPM / GRID_MS);
    const maxBeatLag = Math.round(60000 / MIN_BPM / GRID_MS);
    let best = -1;
    let bestScore = 0;
    let scoreSum = 0;
    let scoreCount = 0;
    const scores = [];
    for (let lag = minLag - 1; lag <= maxBeatLag + 1; lag += 1) {
      let score = ac[lag];
      if (lag * 2 <= maxLag) score += 0.5 * ac[lag * 2];
      if (lag * 4 <= maxLag) score += 0.25 * ac[lag * 4];
      const lagBpm = 60000 / (lag * GRID_MS);
      // a leaning toward 120, mild
      const octaves = Math.log2(lagBpm / 120);
      score *= Math.exp(-0.5 * (octaves / 0.75) * (octaves / 0.75));
      scores[lag] = score;
      if (lag >= minLag && lag <= maxBeatLag) {
        scoreSum += score;
        scoreCount += 1;
        if (score > bestScore) { bestScore = score; best = lag; }
      }
    }
    if (best < 0 || scoreCount === 0) return;
    const meanScore = scoreSum / scoreCount;
    // parabola through the peak and its two neighbours, a lag between the cells
    const a = scores[best - 1] || 0;
    const b = scores[best];
    const c = scores[best + 1] || 0;
    const denom = a - 2 * b + c;
    const offset = denom < 0 ? clamp(0.5 * (a - c) / denom, -0.5, 0.5) : 0;
    const candidate = 60000 / ((best + offset) * GRID_MS);
    const sureness = clamp((bestScore / Math.max(1e-9, meanScore) - 1.35) / 1.6, 0, 1);
    confidence += (sureness - confidence) * 0.35;

    if (!bpm) {
      if (sureness > 0.25) {
        bpm = candidate;
        challenger = 0;
        challengerCount = 0;
      }
      return;
    }
    if (Math.abs(candidate - bpm) / bpm < 0.035) {
      bpm += (candidate - bpm) * 0.25;
      challengerCount = 0;
    } else if (sureness > 0.3) {
      // a different tempo has to win a few times in a row before the clock changes to it
      if (challenger && Math.abs(candidate - challenger) / challenger < 0.04) challengerCount += 1;
      else { challenger = candidate; challengerCount = 1; }
      if (challengerCount >= 3) {
        bpm = challenger;
        challengerCount = 0;
        anchor = null; // the old phase belongs to the old tempo
      }
    }
  };

  // where the beats of the current tempo fall best on the last seconds of hits
  const findPhase = (now) => {
    const period = 60000 / bpm;
    const cells = period / GRID_MS;
    const tries = Math.max(8, Math.round(cells));
    const end = GRID_LEN - 1;
    let best = 0;
    let bestScore = -1;
    const scores = new Float32Array(tries + 2);
    for (let p = 0; p < tries; p += 1) {
      const phaseCells = (p / tries) * cells;
      let sum = 0;
      let weight = 1;
      for (let k = 0; ; k += 1) {
        const cell = end - phaseCells - k * cells;
        if (cell < 3) break;
        sum += sampleSmooth(cell) * weight;
        weight *= 0.9;
        if (k > 24) break;
      }
      scores[p] = sum;
      if (sum > bestScore) { bestScore = sum; best = p; }
    }
    const prev = scores[(best - 1 + tries) % tries];
    const next = scores[(best + 1) % tries];
    const denom = prev - 2 * bestScore + next;
    const frac = denom < 0 ? clamp(0.5 * (prev - next) / denom, -0.5, 0.5) : 0;
    const phaseMs = ((best + frac) / tries) * period;
    // the last cell of the grid is the ten milliseconds before now
    return now - GRID_MS - phaseMs; // the time of the latest beat
  };

  const placeClock = (now) => {
    if (!bpm || now - firstAt < MIN_HISTORY_MS) return;
    const period = 60000 / bpm;
    const latest = findPhase(now);
    if (anchor === null) {
      anchor = latest;
      phaseMiss = 0;
      return;
    }
    let error = (latest - anchor) % period;
    if (error > period / 2) error -= period;
    if (error < -period / 2) error += period;
    if (Math.abs(error) < 0.12 * period) {
      anchor += error * 0.3;
      phaseMiss = 0;
    } else {
      // the hits moved off the clock. believe it only when it keeps saying the same thing
      if (phaseMiss > 0 && Math.abs(error - phaseMissError) < 0.1 * period) phaseMiss += 1;
      else { phaseMiss = 1; phaseMissError = error; }
      if (phaseMiss >= 3) {
        anchor += error;
        phaseMiss = 0;
      }
    }
  };

  return {
    // freqBytes: the bytes of an analyser that does not smooth. now: milliseconds
    // -> { bpm, confidence, locked, phase, period, beat, onBeat, bar, onBar, beatCount, beatInBar, onset }
    step(freqBytes, now) {
      if (firstAt === null) firstAt = now;
      const frameMs = lastStepAt === null ? 33 : clamp(now - lastStepAt, 4, 100);
      // a long gap (the window was hidden, the song was paused) starts over, the history would be a lie
      if (lastStepAt !== null && now - lastStepAt > 1500) reset();
      if (firstAt === null) firstAt = now;
      lastStepAt = now;

      let onset = 0;
      let energy = 0;
      for (let k = 0; k < bands.length; k += 1) {
        const band = bands[k];
        const last = Math.min(band.high, freqBytes.length - 1);
        let sum = 0;
        for (let i = band.low; i <= last; i += 1) sum += freqBytes[i];
        const level = last >= band.low ? sum / (last - band.low + 1) / 255 : 0;
        energy += level;
        if (band.prev1 !== null) {
          const reference = Math.max(band.prev1, band.prev2 === null ? band.prev1 : band.prev2);
          const rise = level - reference;
          if (rise > 0) onset += rise * band.weight;
        }
        band.prev2 = band.prev1;
        band.prev1 = level;
      }
      energyMean += (energy - energyMean) * 0.02;
      // what counts is a rise well above the usual size of the number
      const g = Math.max(0, onset - mean * 1.3);
      mean += (onset - mean) * 0.03;
      if (g > 0) { push(now, g); lastOnsetAt = now; }
      if (g > peakSince) peakSince = g;
      peakRef = Math.max(peakRef * Math.pow(0.5, (lastStepAt === null ? 33 : 33) / 6000), Math.min(g, 1));
      if (peakRef < 0.06) peakRef = 0.06;

      // (nothing to look at while it has been silent for three seconds, the old hits in the history would keep the tempo alive)
      if (now - lastUpdateAt >= UPDATE_MS && now - firstAt >= 1200 && now - lastOnsetAt <= 3000) {
        lastUpdateAt = now;
        estimate(now);
        placeClock(now);
      }
      // no music for a while: let go of the tempo
      if (now - lastOnsetAt > 3000) {
        confidence *= 0.9;
        if (confidence < 0.05 && bpm) { bpm = 0; anchor = null; }
      }

      let onBeat = false;
      let onBar = false;
      let phase = 0;
      let beatInBar = 0;
      const period = bpm ? 60000 / bpm : 0;
      const locked = Boolean(bpm && anchor !== null && confidence > 0.3);
      if (locked) {
        // half a picture ahead, so the beat goes off in the picture that is closest to it and not the one after it
        const since = now - anchor + clamp(frameMs * 0.5, 4, 25);
        const number = Math.floor(since / period);
        phase = since / period - number;
        if (lastBeatNumber === null) lastBeatNumber = number;
        if (number > lastBeatNumber) {
          // a beat of the clock. the hardest onset since the last one says how hard the last beat was
          const slotNow = ((beatCount % 4) + 4) % 4;
          const measured = clamp(peakSince / Math.max(0.06, peakRef), 0, 1.2);
          slotStrength[slotNow] = slotStrength[slotNow] * 0.6 + measured * 0.4;
          slotAccent[slotNow] = slotAccent[slotNow] * 0.88 + measured * 0.12;
          peakSince = 0;
          lastBeatNumber = number;
          beatCount += 1;
          const slot = ((beatCount % 4) + 4) % 4;
          // which of the four beats is hit hardest, with some stubbornness
          let top = 0;
          for (let i = 1; i < 4; i += 1) if (slotAccent[i] > slotAccent[top]) top = i;
          if (top !== downSlot && slotAccent[top] > slotAccent[downSlot] * 1.5) downSlot = top;
          onBeat = true;
          beatAt = now;
          // the beat is rated by how hard that place in the bar usually is hit, so it can go off before the hit itself arrives
          beatStrength = clamp(0.35 + slotStrength[slot] * 0.65, 0.35, 1);
          beatInBar = (slot - downSlot + 4) % 4;
          if (beatInBar === 0) {
            onBar = true;
            barAt = now;
            let others = 0;
            for (let i = 0; i < 4; i += 1) if (i !== downSlot) others += slotAccent[i];
            others /= 3;
            const contrast = clamp((slotAccent[downSlot] / Math.max(0.05, others) - 1) * 1.5, 0, 1);
            barStrength = clamp(0.5 + contrast * 0.5, 0.5, 1) * beatStrength;
          }
        }
        beatInBar = ((beatCount % 4) - downSlot + 8) % 4;
      } else {
        lastBeatNumber = null;
      }

      const sinceBeat = locked ? now - beatAt : Infinity;
      const sinceBar = locked ? now - barAt : Infinity;
      const decay = period ? clamp(period * 0.3, 70, 170) : 120;
      const beat = locked ? beatStrength * Math.exp(-sinceBeat / decay) * clamp(0.5 + confidence, 0, 1) : 0;
      const bar = locked ? barStrength * Math.exp(-sinceBar / (decay * 2.4)) * clamp(0.5 + confidence, 0, 1) : 0;
      return {
        bpm: bpm || 0,
        confidence,
        locked,
        phase,
        period,
        beat: beat < 0.01 ? 0 : beat,
        onBeat,
        bar: bar < 0.01 ? 0 : bar,
        onBar,
        beatCount,
        beatInBar,
        onset: g
      };
    },
    reset
  };
}
