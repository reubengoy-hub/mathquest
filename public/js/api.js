const API = {
  async call(method, url, data) {
    const opts = { method, credentials: 'same-origin' };
    if (data) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(data);
    }
    const res = await fetch(url, opts);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error del servidor');
    return json;
  },
  get:    (url)       => API.call('GET',    url),
  post:   (url, data) => API.call('POST',   url, data),
  delete: (url)       => API.call('DELETE', url),
};

function fmtTime(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtDate(dt) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

async function checkAuth(requireAdmin = false) {
  try {
    const me = await API.get('/api/auth/me');
    if (requireAdmin && !me.isAdmin) { window.location.href = '/dashboard.html'; return null; }
    if (!requireAdmin && me.isAdmin)  { window.location.href = '/admin.html'; return me; }
    return me;
  } catch {
    window.location.href = '/index.html';
    return null;
  }
}

function setupLogout(btnId = 'logout-btn') {
  document.getElementById(btnId)?.addEventListener('click', async () => {
    await API.post('/api/auth/logout');
    window.location.href = '/index.html';
  });
}
