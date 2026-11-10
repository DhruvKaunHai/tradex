/* Runs backtests off the main thread so the page stays smooth. */
importScripts('pine.js');
onmessage = e => {
  const m = e.data;
  try {
    const t0 = performance.now();
    const r = Pine.run(m.code, m.data, Object.assign({}, m.opt, { onProgress: p => postMessage({ id: m.id, progress: p }) }));
    r.ms = performance.now() - t0;
    postMessage({ id: m.id, ok: true, result: r });
  } catch (err) {
    postMessage({ id: m.id, ok: false, error: { message: err.message, line: err.line || 0 } });
  }
};
