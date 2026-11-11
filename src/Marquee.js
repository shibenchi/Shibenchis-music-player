import React, { useEffect, useRef, useState } from 'react';

// a single line of text. when it fits it just sits there. when it is too long it is cut off with "..." and only moves when it is
// asked to: it holds still for a moment so the start can be read, then scrolls along until it has come all the way round to where it
// began, rests, and repeats. the same text is used in the app, the desktop mini player and the floating window on the phone
//
// what makes it move:
//  - animate={true} or {false}: the caller says (the player cards say "yes" while a song plays)
//  - nothing given (the rows of a list): only while the pointer is over it, or for one lap after it is touched
// a title that scrolls all the time keeps the whole window redrawing every frame (on the phone that was the processor and the
// graphics chip running flat out, with nothing playing, only because a few long titles were on screen), so a list of long titles
// stands still
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
  speed = 42,
  // true: always (while on screen), false: never, left out: only on hover or touch
  animate
}) {
  const boxRef = useRef(null);
  const trackRef = useRef(null);
  const textRef = useRef(null);
  const touchTimer = useRef(null);
  const [textWidth, setTextWidth] = useState(0);
  const [overflowing, setOverflowing] = useState(false);
  // only a title that is on screen is animated
  const [onScreen, setOnScreen] = useState(true);
  // the pointer is over it, or it was touched a moment ago
  const [touched, setTouched] = useState(false);
  const wanted = animate === undefined ? touched : Boolean(animate);
  const running = overflowing && onScreen && wanted;

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
  }, [text, running]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => setOnScreen(entry.isIntersecting));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => clearTimeout(touchTimer.current), []);

  // the lap: hold, then slide one text width plus the gap to the left, then rest and start over. between the laps nothing is
  // animated at all (an animation that holds still is still an animation: the page keeps drawing frames for it)
  useEffect(() => {
    const track = trackRef.current;
    if (!running || !track || typeof track.animate !== 'function') return undefined;
    const distance = textWidth + gap;
    const slide = (distance / speed) * 1000;
    let animation = null;
    let timer = null;
    let stopped = false;
    const lap = () => {
      if (stopped) return;
      animation = track.animate(
        [{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }],
        { duration: slide, easing: 'linear' }
      );
      animation.onfinish = () => {
        animation = null;
        timer = setTimeout(lap, pause);
      };
    };
    timer = setTimeout(lap, pause);
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (animation) animation.cancel();
    };
  }, [running, textWidth, text, gap, pause, speed]);

  const handlers = animate === undefined ? {
    // a mouse only: after a tap on a phone the "pointer" would stay over the row until the next tap somewhere else
    onPointerEnter: (event) => { if (event.pointerType === 'mouse') setTouched(true); },
    onPointerLeave: (event) => { if (event.pointerType === 'mouse') setTouched(false); },
    // a touch shows the whole title once
    onTouchStart: () => {
      setTouched(true);
      clearTimeout(touchTimer.current);
      touchTimer.current = setTimeout(() => setTouched(false), pause + ((textWidth + gap) / speed) * 1000 + 600);
    }
  } : {};

  return (
    <div
      ref={boxRef}
      className={className}
      title={overflowing ? text : undefined}
      style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0, ...style }}
      {...handlers}
    >
      {running ? (
        <span ref={trackRef} style={{ display: 'inline-block', whiteSpace: 'nowrap', willChange: 'transform' }}>
          <span ref={textRef}>{text}</span>
          <span style={{ display: 'inline-block', width: gap }} />
          <span aria-hidden="true">{text}</span>
        </span>
      ) : (
        <span ref={textRef}>{text}</span>
      )}
    </div>
  );
}
