// a timer that keeps its pace while the page is hidden. a page that is hidden (the phone's screen is off, the app is in the background) gets
// its ordinary timers slowed to one tick a second, and after a few minutes to one a minute. a timer that runs inside a worker is not slowed,
// so the worker counts and the page only answers its messages. used for the one job that has to stay on time while the screen is off: sending the
// bars of the sound to another device that watches. falls back to an ordinary timer where a worker cannot be made. returns what stops it
export function steadyInterval(tick, ms) {
  let worker = null;
  let address = '';
  let timer = null;
  try {
    if (typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
      const code = `let id = 0; onmessage = (e) => { if (e.data === 'stop') { clearInterval(id); id = 0; } else if (!id) { id = setInterval(() => postMessage(1), ${Math.max(5, Math.round(ms))}); } };`;
      address = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      worker = new Worker(address);
      worker.onmessage = () => { tick(); };
      worker.onerror = () => {
        // the worker could not run: the ordinary timer does the job
        if (worker) { try { worker.terminate(); } catch { /* gone */ } worker = null; }
        if (!timer) timer = setInterval(tick, ms);
      };
      worker.postMessage('start');
    }
  } catch {
    worker = null;
  }
  if (!worker) timer = setInterval(tick, ms);
  return () => {
    if (timer) { clearInterval(timer); timer = null; }
    if (worker) {
      try { worker.postMessage('stop'); worker.terminate(); } catch { /* gone */ }
      worker = null;
    }
    if (address) { try { URL.revokeObjectURL(address); } catch { /* gone */ } address = ''; }
  };
}
