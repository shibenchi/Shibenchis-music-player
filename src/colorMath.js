// color conversions for the theme color picker. every color is { r, g, b } from 0 to 255 at the edges and the picker works in hue (0 to 360),
// saturation and value (0 to 1, the square), or hue, saturation and lightness (0 to 1, the lightness slider). a gray has no hue: the picker keeps
// the hue it had, so dragging to gray and back does not jump

const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function rgbToHsv({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }) {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}

// lightness of a color (0 to 1) with its hsl saturation: the lightness slider moves this and keeps the rest
export function rgbToHsl({ r, g, b }) {
  const hsv = rgbToHsv({ r, g, b });
  const l = hsv.v * (1 - hsv.s / 2);
  const denom = Math.min(l, 1 - l);
  const s = denom === 0 ? 0 : (hsv.v - l) / denom;
  return { h: hsv.h, s: clamp01(s), l: clamp01(l) };
}

export function hslToRgb({ h, s, l }) {
  // hsl to hsv, then the same conversion as above
  const v = l + s * Math.min(l, 1 - l);
  const sv = v === 0 ? 0 : 2 * (1 - l / v);
  return hsvToRgb({ h, s: sv, v });
}

export function sameRgb(a, b) {
  return Math.round(a.r) === Math.round(b.r) && Math.round(a.g) === Math.round(b.g) && Math.round(a.b) === Math.round(b.b);
}

export function toHex({ r, g, b }) {
  return [r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, '0')).join('');
}
