
;(function () {
  const base = window.__REGISTRY_PROXY_BASE__ || '';
  const apiKey = window.__REGISTRY_PROXY_KEY__ || '';

  async function callBackend(path, body) {
    const res = await fetch(`${base}/api/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
    return res.json().catch(() => ({}));
  }

  function makeRunner(ok, fail) {
    const handler = {
      get(_t, prop) {
        if (prop === 'withSuccessHandler') return (fn) => makeRunner(fn, fail);
        if (prop === 'withFailureHandler') return (fn) => makeRunner(ok, fn);
        return (arg) =>
          callBackend(String(prop), arg)
            .then((data) => { if (typeof ok === 'function') ok(data); return data; })
            .catch((err) => { if (typeof fail === 'function') fail(err); else console.error(err); throw err; });
      },
    };
    return new Proxy({}, handler);
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);
})();
