import React, { useEffect, useRef, useState } from 'react';
import { rgbToHsv, hsvToRgb, rgbToHsl, hslToRgb, sameRgb } from './colorMath';

// the theme color picker, in two forms that the settings toggle between.
// simple: the hue bar it always was (a rainbow strip). moving it sets the pure hue of the color at full saturation and half lightness, as before,
// and nothing else can be changed.
// complex: a saturation and value square, a hue bar, a lightness bar, and an rgb mode, in one module with the same outlines and type as the rest of
// the settings. every marker sits on the value it shows (the bars and the square use the same inner box as their markers).
// both report every change at once and take a color set from outside (reset, another device)
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const MODE_KEY = 'music_color_mode';
const RAINBOW = 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)';

// a color as the picker's hsv, keeping the hue it had when the color is a gray (a gray has no hue of its own)
function fromRgb(rgb, hueBefore) {
  const next = rgbToHsv(rgb);
  return next.s === 0 ? { ...next, h: hueBefore } : next;
}

// a bar that is set by dragging or tapping anywhere on it. the marker is centered on the value; the pointer is read inside the 1px border
function Track({ value, min, max, onChange, background, height = 20, accent }) {
  const ref = useRef(null);
  const drag = useRef(false);
  const toValue = (e) => {
    const rect = ref.current.getBoundingClientRect();
    const p = clamp((e.clientX - rect.left - 1) / Math.max(1, rect.width - 2), 0, 1);
    onChange(Math.round(min + p * (max - min)));
  };
  const pct = clamp((value - min) / (max - min), 0, 1) * 100;
  return (
    <div
      ref={ref}
      onPointerDown={(e) => {
        drag.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        toValue(e);
      }}
      onPointerMove={(e) => { if (drag.current) toValue(e); }}
      onPointerUp={() => { drag.current = false; }}
      onPointerCancel={() => { drag.current = false; }}
      style={{
        position: 'relative',
        width: '100%',
        height: `${height}px`,
        boxSizing: 'border-box',
        border: `1px solid ${accent}`,
        borderRadius: '6px',
        background,
        cursor: 'pointer',
        touchAction: 'none',
        userSelect: 'none'
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${pct}%`,
          width: '8px',
          transform: 'translateX(-50%)',
          boxSizing: 'border-box',
          background: '#fff',
          border: '1px solid #000',
          pointerEvents: 'none'
        }}
      />
    </div>
  );
}

export default function ColorPicker({ color, onChange }) {
  const [hsv, setHsv] = useState(() => rgbToHsv(color));
  const [mode, setMode] = useState('hsv');
  const [form, setForm] = useState(() => {
    try { return window.localStorage.getItem(MODE_KEY) === 'simple' ? 'simple' : 'complex'; } catch { return 'complex'; }
  });
  const squareRef = useRef(null);
  const dragging = useRef(false);
  const accent = `rgb(${color.r}, ${color.g}, ${color.b})`;

  const chooseForm = (next) => {
    setForm(next);
    try { window.localStorage.setItem(MODE_KEY, next); } catch { /* kept for this visit */ }
  };

  // a color that came from outside (reset, a color synced from another device) is taken; our own changes already match and are kept as they are
  useEffect(() => {
    setHsv((prev) => (sameRgb(hsvToRgb(prev), color) ? prev : fromRgb(color, prev.h)));
  }, [color.r, color.g, color.b]);

  const apply = (rgb, nextHsv) => {
    setHsv(nextHsv);
    onChange(rgb);
  };

  // simple: the old hue bar, the pure color of the hue (saturation full, lightness half), nothing else
  const setSimpleHue = (h) => {
    const rgb = hslToRgb({ h, s: 1, l: 0.5 });
    apply(rgb, fromRgb(rgb, h));
  };

  const moveInSquare = (e) => {
    const rect = squareRef.current.getBoundingClientRect();
    const s = clamp((e.clientX - rect.left - 1) / Math.max(1, rect.width - 2), 0, 1);
    const v = clamp(1 - (e.clientY - rect.top - 1) / Math.max(1, rect.height - 2), 0, 1);
    const next = { h: hsv.h, s, v };
    apply(hsvToRgb(next), next);
  };

  const hsl = rgbToHsl(color);
  const lightnessPct = Math.round(hsl.l * 100);

  const setLightness = (percent) => {
    const rgb = hslToRgb({ h: hsv.h, s: hsl.s, l: percent / 100 });
    apply(rgb, fromRgb(rgb, hsv.h));
  };

  const setChannel = (key, value) => {
    const rgb = { ...color, [key]: value };
    apply(rgb, fromRgb(rgb, hsv.h));
  };

  const setHue = (h) => apply(hsvToRgb({ ...hsv, h }), { ...hsv, h });

  const pill = (active, onClick, text) => (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: '1 1 0',
        padding: '6px 8px',
        background: active ? accent : 'transparent',
        color: active ? '#000' : accent,
        border: `1px solid ${accent}`,
        borderRadius: '6px',
        fontSize: '12px',
        lineHeight: 1.2,
        cursor: 'pointer'
      }}
    >
      {text}
    </button>
  );

  const label = (text, value) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: accent, marginBottom: '2px' }}>
      <span>{text}</span>
      <span>{value}</span>
    </div>
  );

  const selector = (
    <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
      {pill(form === 'simple', () => chooseForm('simple'), 'simple')}
      {pill(form === 'complex', () => chooseForm('complex'), 'complex')}
    </div>
  );

  if (form === 'simple') {
    return (
      <div style={{ marginTop: '15px' }}>
        {selector}
        <Track value={Math.round(hsv.h)} min={0} max={360} onChange={setSimpleHue} background={RAINBOW} height={24} accent={accent} />
      </div>
    );
  }

  return (
    <div style={{ marginTop: '15px' }}>
      {selector}

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
        {pill(mode === 'hsv', () => setMode('hsv'), 'hsv')}
        {pill(mode === 'rgb', () => setMode('rgb'), 'rgb')}
      </div>

      {mode === 'hsv' ? (
        <>
          <div
            ref={squareRef}
            onPointerDown={(e) => {
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              moveInSquare(e);
            }}
            onPointerMove={(e) => { if (dragging.current) moveInSquare(e); }}
            onPointerUp={() => { dragging.current = false; }}
            onPointerCancel={() => { dragging.current = false; }}
            style={{
              position: 'relative',
              boxSizing: 'border-box',
              width: '100%',
              height: '150px',
              border: `1px solid ${accent}`,
              borderRadius: '6px',
              cursor: 'crosshair',
              touchAction: 'none',
              userSelect: 'none',
              background: `linear-gradient(to top, #000, rgba(0, 0, 0, 0)), linear-gradient(to right, #fff, hsl(${hsv.h}, 100%, 50%))`
            }}
          >
            {/* the marker: black inside, the selected color as its ring, centered exactly on the point it shows */}
            <div
              style={{
                position: 'absolute',
                left: `${hsv.s * 100}%`,
                top: `${(1 - hsv.v) * 100}%`,
                width: '12px',
                height: '12px',
                boxSizing: 'border-box',
                transform: 'translate(-50%, -50%)',
                border: `2px solid ${accent}`,
                borderRadius: '50%',
                background: '#000',
                pointerEvents: 'none'
              }}
            />
          </div>

          <div style={{ marginTop: '12px' }}>
            {label('hue', Math.round(hsv.h))}
            <Track value={Math.round(hsv.h)} min={0} max={360} onChange={setHue} background={RAINBOW} accent={accent} />
          </div>
        </>
      ) : (
        <>
          <div style={{ marginBottom: '10px' }}>
            {label('red', color.r)}
            <Track value={color.r} min={0} max={255} onChange={(v) => setChannel('r', v)} background={`linear-gradient(to right, #000, rgb(255, ${color.g}, ${color.b}))`} accent={accent} />
          </div>
          <div style={{ marginBottom: '10px' }}>
            {label('green', color.g)}
            <Track value={color.g} min={0} max={255} onChange={(v) => setChannel('g', v)} background={`linear-gradient(to right, #000, rgb(${color.r}, 255, ${color.b}))`} accent={accent} />
          </div>
          <div>
            {label('blue', color.b)}
            <Track value={color.b} min={0} max={255} onChange={(v) => setChannel('b', v)} background={`linear-gradient(to right, #000, rgb(${color.r}, ${color.g}, 255))`} accent={accent} />
          </div>
        </>
      )}

      <div style={{ marginTop: '12px' }}>
        {label('lightness', `${lightnessPct}%`)}
        <Track value={lightnessPct} min={0} max={100} onChange={setLightness} background="linear-gradient(to right, #000, #808080, #fff)" accent={accent} />
      </div>
    </div>
  );
}
