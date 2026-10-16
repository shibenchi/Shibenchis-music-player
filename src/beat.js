// finds the kick drum in the music, many times a second, for the visualizers.
//
// what was there before averaged the lowest tenth of the spectrum, which is everything up to about 2 kHz (voices and snares are in there
// too), and read it through an analyser that smooths over several frames, so a kick arrived late and weak. this looks only at the low band
// where kick drums are (35 to 140 Hz) in an analyser that does not smooth, compares it with how loud that band has been for the last
// second, and calls it a kick when it jumps clearly above that. the result is an envelope: it goes up at once on a kick, to 1 for a hard
// one, and falls away in a couple of tenths of a second, so the pictures can punch on the beat and settle in between.
//
// a bass that just sits there (a long note, a hum) does not count, and neither does noise: the average follows it. it is also kept from
// firing twice for one kick (110 ms apart at the least, that is a tempo of 545 beats a minute)

const LOW_HZ = 35;
const HIGH_HZ = 140;
const WARM_UP_FRAMES = 6;
const MIN_LIFT = 0.075; // how far above the last second the band has to jump, as a share of the full range
const MIN_RISE = 0.02; // and how much it has to have grown since the frame before
const REFRACTORY_MS = 110;
const HALF_LIFE_MS = 90;

export function createBeatDetector({ sampleRate = 44100, fftSize = 2048 } = {}) {
  const hzPerBin = sampleRate / fftSize;
  const low = Math.max(1, Math.round(LOW_HZ / hzPerBin));
  const high = Math.max(low + 1, Math.round(HIGH_HZ / hzPerBin));
  let slow = null; // the band's level over about the last second
  let deviation = 0.02; // how much it usually moves around that
  let previous = 0;
  let kick = 0;
  let lastOnset = -Infinity;
  let lastNow = null;
  let frames = 0;

  return {
    // freqBytes: what getByteFrequencyData gave. now: milliseconds. -> { level, kick, onset }
    step(freqBytes, now) {
      let sum = 0;
      const last = Math.min(high, freqBytes.length - 1);
      for (let i = low; i <= last; i += 1) sum += freqBytes[i];
      const level = last >= low ? sum / (last - low + 1) / 255 : 0;

      const dt = lastNow === null ? 16.7 : Math.min(100, Math.max(4, now - lastNow));
      lastNow = now;
      const follow = 1 - Math.pow(1 - 0.03, dt / 16.7);
      if (slow === null) slow = level;
      const lift = level - slow;
      const rise = level - previous;
      previous = level;
      deviation += (Math.abs(lift) - deviation) * follow;
      slow += (level - slow) * follow;

      frames += 1;
      // what was left of the last kick fades first, so a kick found now is reported at its full strength on this very frame
      kick *= Math.pow(0.5, dt / HALF_LIFE_MS);
      let onset = false;
      const threshold = Math.max(MIN_LIFT, deviation * 1.1);
      if (frames > WARM_UP_FRAMES && lift > threshold && rise > MIN_RISE && now - lastOnset > REFRACTORY_MS) {
        onset = true;
        lastOnset = now;
        // a lift of a quarter of the range is a full strength kick, a small one still counts for about half
        kick = Math.max(kick, Math.min(1, Math.max(0.45, lift / 0.25)));
      }
      if (kick < 0.005) kick = 0;
      return { level, kick, onset };
    },
    reset() {
      slow = null;
      deviation = 0.02;
      previous = 0;
      kick = 0;
      lastOnset = -Infinity;
      lastNow = null;
      frames = 0;
    }
  };
}
