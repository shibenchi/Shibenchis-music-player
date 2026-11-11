// everything the visualizers want to know about the sound, worked out once per picture in one place. it used to be written out twice in
// App.js (the drawing loop and the timer that feeds the mini player and the phone), with the kick detector read from both.
//
// read() takes the two analysers (the smoothed one for the pictures, the one that does not smooth for hits) and the time, and gives back
// one object that stays the same object from picture to picture (nothing is made per frame):
//   freq, time           the bytes of the main analyser (frequency, waveform)
//   bassLevel            the low tenth of the spectrum, 0 to 1
//   volumeLevel          the whole spectrum, 0 to 1
//   bassPulse            how hard the music is hitting right now, 0 to 1: a bass jump, a kick, or the beat of the tempo clock. the drawings
//                        that swell and punch use this one (it was called bassPulse before the tempo tracker, the name stayed)
//   soft                 the same thing slowed down and capped, for the drawings that flash too much with the sharp one (particles, network)
//   beat, bar            the envelope of the tempo clock: 1 on a beat (or the first beat of a bar), falling away. 0 while it has no tempo
//   bpm, locked, phase   the tempo, whether the clock is sure of it, where in the beat we are (0 to 1)
//   beatCount, barCount, beatInBar   counters that only go up (the drawing that wants "every beat" compares them with the last picture)
//   now, dt              the time of this picture and the time since the last, milliseconds
//
// calling read() twice within a few milliseconds (the drawing loop and the timer that feeds the mini player can do that) returns the
// first answer again, so nothing is counted twice

import { createBeatDetector } from './beat';
import { createTempoTracker } from './tempo';

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const SAME_PICTURE_MS = 8;

export function createVizDrive() {
  let freqBuffer = null;
  let timeBuffer = null;
  let beatBuffer = null;
  let beatDetector = null;
  let tempo = null;
  let sampleRate = 0;
  let beatBins = 0;
  let baseline;
  let onsetPulse = 0;
  let soft = 0;
  let barCount = 0;
  let lastAt = null;

  const out = {
    freq: null,
    time: null,
    bassLevel: 0,
    volumeLevel: 0,
    bassPulse: 0,
    soft: 0,
    kick: 0,
    beat: 0,
    bar: 0,
    bpm: 0,
    confidence: 0,
    locked: false,
    phase: 0,
    period: 0,
    beatCount: 0,
    barCount: 0,
    beatInBar: 0,
    now: 0,
    dt: 33
  };

  const reset = () => {
    baseline = undefined;
    onsetPulse = 0;
    soft = 0;
    barCount = 0;
    lastAt = null;
    if (beatDetector) beatDetector.reset();
    if (tempo) tempo.reset();
  };

  return {
    read({ analyser, beatAnalyser, rate, now }) {
      if (!analyser) return null;
      if (lastAt !== null && now - lastAt < SAME_PICTURE_MS && out.freq) return out;
      const dt = lastAt === null ? 33 : clamp(now - lastAt, 4, 100);
      lastAt = now;
      const k = dt / 33;

      if (!freqBuffer || freqBuffer.length !== analyser.frequencyBinCount) freqBuffer = new Uint8Array(analyser.frequencyBinCount);
      if (!timeBuffer || timeBuffer.length !== analyser.fftSize) timeBuffer = new Uint8Array(analyser.fftSize);
      analyser.getByteFrequencyData(freqBuffer);
      analyser.getByteTimeDomainData(timeBuffer);

      const bassLength = Math.max(1, Math.floor(freqBuffer.length * 0.1));
      let bassSum = 0;
      for (let i = 0; i < bassLength; i += 1) bassSum += freqBuffer[i];
      const bassLevel = bassSum / bassLength / 255;
      let volumeSum = 0;
      for (let i = 0; i < freqBuffer.length; i += 1) volumeSum += freqBuffer[i];
      const volumeLevel = volumeSum / freqBuffer.length / 255;

      // the older pulse: bassLevel on its own sits high all the time in mixed music, so a slow floor under it is kept and only what
      // rises above the floor counts (fast attack, slow decay). 4.2 because the analyser range was widened
      if (baseline === undefined) baseline = bassLevel;
      baseline += (bassLevel - baseline) * (1 - Math.pow(1 - 0.06, k));
      const onset = Math.max(0, bassLevel - baseline) * 4.2;
      onsetPulse = Math.max(onset, onsetPulse * Math.pow(0.85, k));

      // the kick and the tempo come from the analyser that does not smooth
      let kick = 0;
      let t = null;
      if (beatAnalyser) {
        const sr = rate || 44100;
        if (!beatDetector || sampleRate !== sr || beatBins !== beatAnalyser.frequencyBinCount) {
          sampleRate = sr;
          beatBins = beatAnalyser.frequencyBinCount;
          beatDetector = createBeatDetector({ sampleRate: sr, fftSize: beatAnalyser.fftSize });
          tempo = createTempoTracker({ sampleRate: sr, fftSize: beatAnalyser.fftSize });
          beatBuffer = new Uint8Array(beatBins);
        }
        beatAnalyser.getByteFrequencyData(beatBuffer);
        kick = beatDetector.step(beatBuffer, now).kick;
        t = tempo.step(beatBuffer, now);
      }

      const locked = Boolean(t && t.locked);
      const beat = locked ? t.beat : 0;
      const bar = locked ? t.bar : 0;
      if (t && t.onBar) barCount += 1;
      // the clock's beat counts as a hit even when the kick detector missed it, and the first beat of a bar as a harder one
      const clock = locked ? Math.max(beat * 0.7, bar * 0.95) : 0;
      const punch = Math.min(1, Math.max(onsetPulse, kick, clock));

      // the slow one: it rises over a few frames and falls over several, and with a tempo it breathes with the beat and not with every
      // bump in the low end. without a tempo it only follows the loudest hits and stays low
      const target = locked ? Math.min(1, beat * 0.7 + bar * 0.45) : Math.min(0.35, Math.max(kick, onsetPulse) * 0.4);
      if (target > soft) soft += (target - soft) * (1 - Math.pow(0.55, k));
      else soft += (target - soft) * (1 - Math.pow(0.86, k));
      if (soft < 0.004) soft = 0;

      out.freq = freqBuffer;
      out.time = timeBuffer;
      out.bassLevel = bassLevel;
      out.volumeLevel = volumeLevel;
      out.bassPulse = punch;
      out.soft = soft;
      out.kick = kick;
      out.beat = beat;
      out.bar = bar;
      out.bpm = t ? t.bpm : 0;
      out.confidence = t ? t.confidence : 0;
      out.locked = locked;
      out.phase = t ? t.phase : 0;
      out.period = t ? t.period : 0;
      out.beatCount = t ? t.beatCount : 0;
      out.barCount = barCount;
      out.beatInBar = t ? t.beatInBar : 0;
      out.now = now;
      out.dt = dt;
      return out;
    },
    // a new song or a stop: forget the tempo and the floors
    reset
  };
}
