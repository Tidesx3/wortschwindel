import { h } from './dom.js';
import { t } from '../i18n.js';

/**
 * Connection wrapper around the global `io` (served by Socket.IO).
 * - estimates the server clock offset from each state message
 * - renders a status dot and a banner on connection loss
 */
export function createConnection({ onState, onConnect, onEvent = {} }) {
  // eslint-disable-next-line no-undef
  const socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });
  let offset = 0;
  let status = 'connecting';
  const listeners = new Set();

  const dot = h('span', { class: 'conn-dot connecting', title: t.connection.connecting, role: 'status' });
  const banner = h('div', { class: 'conn-banner', hidden: true, role: 'alert' }, t.connection.lostBanner);
  document.body.append(banner);

  function setStatus(next) {
    status = next;
    dot.className = `conn-dot ${next}`;
    dot.title = t.connection[next];
    dot.setAttribute('aria-label', t.connection[next]);
    banner.hidden = next === 'online';
    for (const fn of listeners) fn(next);
  }

  socket.on('connect', () => {
    setStatus('online');
    onConnect?.();
  });
  socket.on('disconnect', () => setStatus('offline'));
  socket.io.on('reconnect_attempt', () => setStatus('connecting'));
  socket.on('connect_error', () => setStatus('offline'));

  socket.on('state', (view) => {
    // Received time minus server time; small network delay is acceptable here.
    const sample = Date.now() - view.serverNow;
    offset = Math.abs(sample - offset) > 1000 || !offset ? sample : offset * 0.8 + sample * 0.2;
    onState(view);
  });
  for (const [event, handler] of Object.entries(onEvent)) socket.on(event, handler);

  // Show the banner only after a short grace period on first load.
  banner.hidden = true;

  function emit(event, payload = {}, timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve({ ok: false, error: 'timeout' });
        return;
      }
      socket.timeout(timeoutMs).emit(event, payload, (err, response) => {
        resolve(err ? { ok: false, error: 'timeout' } : response ?? { ok: false, error: 'serverError' });
      });
    });
  }

  return {
    socket,
    emit,
    dot,
    /** Current server time estimate. */
    serverNow: () => Date.now() - offset,
    onStatus: (fn) => listeners.add(fn),
    get status() {
      return status;
    },
  };
}
