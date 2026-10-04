import React, { useEffect, useRef, useState } from 'react';

// a single line of text. when it fits it just sits there. when it is too long it
// holds still for a moment so the start can be read, then scrolls along until it
// has come all the way round to where it began, and repeats. the same text is
// used in the app, the desktop mini player and the floating window on the phone
//
// the box it sits in has to have a width of its own (a block, or a flex child
// with min-width 0), the text measures itself against that
export default function Marquee({
  text,
  className,
  style,
  // gap between the end of the text and its repeat, in pixels
  gap = 36,
  // how long it holds still before each lap, in milliseconds
  pause = 1500,
  // scroll speed, pixels a second
  speed = 42
}) {
  const boxRef = useRef(null);
  const trackRef = useRef(null);
  const textRef = useRef(null);
  const [textWidth, setTextWidth] = useState(0);
  const [overflowing, setOverflowing] = useState(false);
  // only a title that is on screen is animated: a long list has a hundred of
  // these and a phone should not be scrolling all of them at once
  const [onScreen, setOnScreen] = useState(true);

  // does it fit? measured again whenever the text or the box changes size
  useEffect(() => {
    const box = boxRef.current;
    const measure = textRef.current;
    if (!box || !measure) return undefined;
    const check = () => {
      const width = measure.offsetWidth;
      setTextWidth(width);
      setOverflowing(width > box.clientWidth + 1);
    };
    check();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(box);
    return () => observer.disconnect();
  }, [text]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => setOnScreen(entry.isIntersecting));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // the lap: hold, then slide one text width plus the gap to the left, then start over
  useEffect(() => {
    const track = trackRef.current;
    if (!overflowing || !onScreen || !track || typeof track.animate !== 'function') return undefined;
    const distance = textWidth + gap;
    const slide = (distance / speed) * 1000;
    const total = pause + slide;
    const animation = track.animate(
      [
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(0)', offset: pause / total },
        { transform: `translateX(-${distance}px)`, offset: 1 }
      ],
      { duration: total, iterations: Infinity, easing: 'linear' }
    );
    return () => animation.cancel();
  }, [overflowing, onScreen, textWidth, text, gap, pause, speed]);

  return (
    <div
      ref={boxRef}
      className={className}
      title={overflowing ? text : undefined}
      style={{ overflow: 'hidden', whiteSpace: 'nowrap', minWidth: 0, ...style }}
    >
      <span ref={trackRef} style={{ display: 'inline-block', whiteSpace: 'nowrap', willChange: overflowing ? 'transform' : 'auto' }}>
        <span ref={textRef}>{text}</span>
        {overflowing && (
          <>
            <span style={{ display: 'inline-block', width: gap }} />
            <span aria-hidden="true">{text}</span>
          </>
        )}
      </span>
    </div>
  );
}
