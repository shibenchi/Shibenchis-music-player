import React, { useEffect, useRef } from 'react';
import { visibleInterval } from './visibleInterval';

// the small drawing of the song another device of the account is playing. it is drawn from the bars of the sound that device really hears:
// it reads them from its audio analyser, sends a short list of numbers about ten times a second while this device asks for them, and
// barsRef.current ({ bars: [0..255 x 32], at: ms }) holds the last list. nothing here is made up: when no list has come for a moment (the
// other device is paused, closed or an older version) the bars lie down. plain bars, one color, no marks on top
const WIDTH = 120;
const HEIGHT = 34;
const COUNT = 32;
const STALE_MS = 1500;

export default function RemoteBars({ playing, barsRef, color, width = WIDTH, height = HEIGHT }) {
  const canvasRef = useRef(null);
  const rgb = color ? `${color.r}, ${color.g}, ${color.b}` : '255, 255, 255';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const level = new Float32Array(COUNT);
    const slot = width / COUNT;
    const barW = Math.max(1.5, slot * 0.62);

    const draw = () => {
      const held = barsRef && barsRef.current;
      const fresh = playing && held && held.bars && performance.now() - held.at < STALE_MS;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = `rgb(${rgb})`;
      for (let i = 0; i < COUNT; i += 1) {
        const target = fresh ? Math.min(1, (held.bars[i] || 0) / 255) : 0;
        // up quickly, down a little slower, so the ten lists a second do not look like steps
        level[i] += (target - level[i]) * (target > level[i] ? 0.55 : 0.28);
        const h = Math.max(1.5, level[i] * (height - 3));
        const x = i * slot + (slot - barW) / 2;
        ctx.fillRect(x, height - h, barW, h);
      }
    };

    draw();
    let onScreen = true;
    let observer = null;
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => { entries.forEach((entry) => { onScreen = entry.isIntersecting; }); });
      observer.observe(canvas);
    }
    const stop = visibleInterval(() => { if (onScreen) draw(); }, 33);
    return () => {
      stop();
      if (observer) observer.disconnect();
    };
  }, [playing, rgb, barsRef, width, height]);

  return <canvas ref={canvasRef} data-remote-bars={playing ? 'playing' : 'paused'} aria-hidden="true" style={{ width: width + 'px', height: height + 'px', flex: 'none', display: 'block' }} />;
}
