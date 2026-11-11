// a timer that only runs while the page can be seen. every tick of the ones in App.js re-renders the whole app, and with the phone's
// screen off (or the window minimized) there is nothing to show it on. it ticks once at once when the page comes back so what is shown is
// current. returns what stops it
export function visibleInterval(tick, ms) {
  let timer = null;
  const sync = () => {
    if (document.visibilityState === 'hidden') {
      if (timer) { clearInterval(timer); timer = null; }
      return;
    }
    if (!timer) { tick(); timer = setInterval(tick, ms); }
  };
  document.addEventListener('visibilitychange', sync);
  sync();
  return () => {
    document.removeEventListener('visibilitychange', sync);
    if (timer) clearInterval(timer);
  };
}
