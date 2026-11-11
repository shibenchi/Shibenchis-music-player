// the most prevalent color of a picture (a song's thumbnail), for the "thumbnail color" setting: the theme color follows the song.
//
// the picture is shrunk to 48 x 48 and only pixels with a real color count: not grey, not dark, not nearly white, and not washed out (HSV saturation under 0.4 is
// out, that is the threshold). the pixels are sorted by hue into 24 bins of 15 degrees, a bin counts a pixel with a weight that grows with its saturation, and
// the biggest bin (with its two neighbours, so one color that straddles two bins is not split) wins. a picture that has too little color (under 4 percent of its
// pixels) or whose winning color is still pale (mean saturation under 0.45) gives null, and the theme color is left as it is.
// the answer is meant for a black page: it is as close to the color chosen with the slider (base) as it can be while staying close to the thumbnail. the hue goes
// from the thumbnail's toward the base hue by at most 15 degrees, the saturation and the lightness lean 70 percent on the base and are held between 0.75 and 1,
// and 0.46 and 0.6. without a base the thumbnail's own values are used (made strong the same way)
const BINS = 24;
const SIZE = 48;
const HUE_REACH = 15;
const pixelCache = new Map();

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export function rgbToHsl(r, g, b) {
  const rr = r / 255; const gg = g / 255; const bb = b / 255;
  const max = Math.max(rr, gg, bb); const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  let h = 0; let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) / 6;
    else if (max === gg) h = ((bb - rr) / d + 2) / 6;
    else h = ((rr - gg) / d + 4) / 6;
  }
  return { h: h * 360, s, l };
}

export function hslToRgb(h, s, l) {
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: Math.round(channel(hh + 1 / 3) * 255), g: Math.round(channel(hh) * 255), b: Math.round(channel(hh - 1 / 3) * 255) };
}

// pixels: RGBA bytes (a Uint8ClampedArray from getImageData), base: the chosen theme color { r, g, b } (optional). null when there is no strong color to speak of
export function pickDominantColor(pixels, base) {
  const weight = new Float64Array(BINS);
  const sumR = new Float64Array(BINS);
  const sumG = new Float64Array(BINS);
  const sumB = new Float64Array(BINS);
  let counted = 0;
  let total = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    total += 1;
    const r = pixels[i]; const g = pixels[i + 1]; const b = pixels[i + 2];
    const max = Math.max(r, g, b); const min = Math.min(r, g, b);
    const v = max / 255;
    const s = max === 0 ? 0 : (max - min) / max;
    // no strong color in it: grey, washed out (the threshold), nearly black, nearly white
    if (s < 0.4 || v < 0.3 || (v > 0.95 && s < 0.5)) continue;
    const hsl = rgbToHsl(r, g, b);
    const bin = Math.floor((hsl.h / 360) * BINS) % BINS;
    const w = s * s * (0.35 + v);
    weight[bin] += w;
    sumR[bin] += r * w;
    sumG[bin] += g * w;
    sumB[bin] += b * w;
    counted += 1;
  }
  if (!total || counted / total < 0.04) return null;
  let best = -1; let bestWeight = 0;
  for (let b = 0; b < BINS; b++) {
    const w = weight[b] + weight[(b + 1) % BINS] * 0.6 + weight[(b + BINS - 1) % BINS] * 0.6;
    if (w > bestWeight) { bestWeight = w; best = b; }
  }
  if (best < 0 || bestWeight <= 0) return null;
  let r = 0; let g = 0; let b = 0; let w = 0;
  for (const bin of [best, (best + 1) % BINS, (best + BINS - 1) % BINS]) {
    r += sumR[bin]; g += sumG[bin]; b += sumB[bin]; w += weight[bin];
  }
  if (w <= 0) return null;
  const thumb = rgbToHsl(r / w, g / w, b / w);
  // the winning color is still pale: not used
  const mx = Math.max(r / w, g / w, b / w); const mn = Math.min(r / w, g / w, b / w);
  if (mx === 0 || (mx - mn) / mx < 0.45) return null;
  if (!base) return hslToRgb(thumb.h, clamp(thumb.s, 0.75, 1), clamp(thumb.l, 0.46, 0.6));
  const chosen = rgbToHsl(base.r, base.g, base.b);
  // the hue: from the thumbnail's toward the chosen one, at most HUE_REACH degrees
  let delta = ((chosen.h - thumb.h + 540) % 360) - 180;
  delta = clamp(delta, -HUE_REACH, HUE_REACH);
  const lean = 0.7;
  const s = clamp(thumb.s + (chosen.s - thumb.s) * lean, 0.75, 1);
  const l = clamp(thumb.l + (chosen.l - thumb.l) * lean, 0.46, 0.6);
  return hslToRgb(thumb.h + delta, s, l);
}

// the pixels of the picture at this address (shrunk), or null when it can not be read: a server that does not allow it, a broken address. kept in memory
function loadPixels(url) {
  if (pixelCache.has(url)) return Promise.resolve(pixelCache.get(url));
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const done = (pixels) => {
      if (pixelCache.size > 200) pixelCache.clear();
      pixelCache.set(url, pixels);
      resolve(pixels);
    };
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, SIZE, SIZE);
        done(ctx.getImageData(0, 0, SIZE, SIZE).data);
      } catch (error) {
        done(null);
      }
    };
    image.onerror = () => done(null);
    image.src = url;
  });
}

// the color for the picture at this address, made for the chosen color base, or null (no strong color in it, or it can not be read)
export async function loadDominantColor(url, base) {
  if (!url) return null;
  const pixels = await loadPixels(url);
  return pixels ? pickDominantColor(pixels, base) : null;
}
