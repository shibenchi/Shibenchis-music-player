import { corridorBarInnerRadius, normalizeCorridorLevels } from './vizRenderers';

describe('corridor bar reach', () => {
  test('lets loud bars extend through the center instead of clamping there', () => {
    expect(corridorBarInnerRadius(0.4)).toBeCloseTo(0);
    expect(corridorBarInnerRadius(0.8)).toBeLessThan(0);
    expect(corridorBarInnerRadius(1)).toBeLessThan(corridorBarInnerRadius(0.8));
  });
});

// the walls take the range of the song they play: a chill song and a loud one both use the whole wall, and no bar sits at zero
describe('corridor dynamic level scaling', () => {
  const spread = (floor, height) => Float32Array.from({ length: 96 }, (_, i) => floor + height * (i / 95));

  test('a chill song (quiet bars) uses the whole wall, not only the bottom of it', () => {
    const state = {};
    let out = [];
    for (let frame = 0; frame < 90; frame += 1) out = normalizeCorridorLevels(spread(0.04, 0.2), state, 1 / 30);
    expect(Math.max(...out)).toBeGreaterThan(0.95);
    expect(Math.min(...out)).toBeLessThan(0.3);
  });

  test('a loud song (bars high all the time) also uses the whole wall, not only the top of it', () => {
    const state = {};
    let out = [];
    for (let frame = 0; frame < 90; frame += 1) out = normalizeCorridorLevels(spread(0.6, 0.35), state, 1 / 30);
    expect(Math.max(...out)).toBeGreaterThan(0.95);
    expect(Math.min(...out)).toBeLessThan(0.3);
  });

  test('a flat, steady level does not pin the wall at full (no range to show)', () => {
    const state = {};
    let out = [];
    for (let frame = 0; frame < 90; frame += 1) out = normalizeCorridorLevels(new Float32Array(96).fill(0.9), state, 1 / 30);
    expect(Math.max(...out)).toBeLessThan(0.5);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0.12 - 1e-6);
  });
});
