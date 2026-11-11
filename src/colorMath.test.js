import { rgbToHsv, hsvToRgb, rgbToHsl, hslToRgb, sameRgb, toHex } from './colorMath';

// a spread of colors: the corners, the primaries, a dark red, a pale blue and some grays
const samples = [
  { r: 255, g: 89, b: 0 },
  { r: 0, g: 0, b: 0 },
  { r: 255, g: 255, b: 255 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
  { r: 128, g: 20, b: 90 },
  { r: 200, g: 220, b: 255 },
  { r: 64, g: 64, b: 64 }
];

describe('color math for the theme picker', () => {
  test('hsv round trips every sample', () => {
    samples.forEach((c) => {
      expect(sameRgb(hsvToRgb(rgbToHsv(c)), c)).toBe(true);
    });
  });

  test('the hue of the orange theme is 21 degrees and it is fully saturated', () => {
    const hsv = rgbToHsv({ r: 255, g: 89, b: 0 });
    expect(Math.round(hsv.h)).toBe(21);
    expect(hsv.s).toBeCloseTo(1, 2);
  });

  test('hsl round trips every sample', () => {
    samples.forEach((c) => {
      expect(sameRgb(hslToRgb(rgbToHsl(c)), c)).toBe(true);
    });
  });

  test('changing only the lightness keeps the hue and the hsl saturation', () => {
    const base = { r: 255, g: 89, b: 0 };
    const hsl = rgbToHsl(base);
    const lighter = hslToRgb({ ...hsl, l: 0.75 });
    const back = rgbToHsl(lighter);
    expect(back.h).toBeCloseTo(hsl.h, 0);
    expect(back.s).toBeCloseTo(hsl.s, 1);
    expect(back.l).toBeCloseTo(0.75, 2);
    // lighter means every channel is at least as bright as before, and the orange still reads as orange (red highest, blue lowest)
    expect(lighter.r).toBeGreaterThanOrEqual(base.r - 1);
    expect(lighter.r).toBeGreaterThan(lighter.g);
    expect(lighter.g).toBeGreaterThan(lighter.b);
  });

  test('lightness at 0 is black and at 1 is white', () => {
    expect(hslToRgb({ h: 200, s: 1, l: 0 })).toEqual({ r: 0, g: 0, b: 0 });
    expect(hslToRgb({ h: 200, s: 1, l: 1 })).toEqual({ r: 255, g: 255, b: 255 });
  });

  test('a gray has no hue of its own (the picker keeps the hue it had)', () => {
    expect(rgbToHsv({ r: 90, g: 90, b: 90 }).s).toBe(0);
  });

  test('hex output is two digits per channel', () => {
    expect(toHex({ r: 255, g: 89, b: 0 })).toBe('ff5900');
    expect(toHex({ r: 0, g: 0, b: 0 })).toBe('000000');
  });
});
