import { h, svg } from './dom.js';
import { t } from '../i18n.js';

/**
 * Countdown display (ring or bar). Keeps its own animation loop and
 * only needs `update(timer)` whenever new state arrives.
 */
export function createTimer({ variant = 'ring', serverNow, onTick } = {}) {
  let timer = null;
  let frame = null;
  let lastSecond = null;

  const label = h('span', { class: 'timer-label' });
  let el;
  let progressEl;
  const RADIUS = 54;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  if (variant === 'ring') {
    progressEl = svg('circle', {
      class: 'timer-ring-progress',
      cx: 60,
      cy: 60,
      r: RADIUS,
      'stroke-dasharray': CIRCUMFERENCE.toFixed(2),
      'stroke-dashoffset': 0,
    });
    el = h(
      'div',
      { class: 'timer timer-ring', role: 'timer' },
      svg('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true' }, svg('circle', { class: 'timer-ring-track', cx: 60, cy: 60, r: RADIUS }), progressEl),
      label,
    );
  } else {
    progressEl = h('div', { class: 'timer-bar-fill' });
    el = h('div', { class: 'timer timer-bar', role: 'timer' }, h('div', { class: 'timer-bar-track' }, progressEl), label);
  }

  function remaining() {
    if (!timer) return null;
    if (timer.paused || timer.expired) return timer.expired ? 0 : timer.remainingMs;
    return Math.max(0, timer.endsAt - serverNow());
  }

  function render() {
    frame = null;
    if (!timer) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const ms = remaining();
    const seconds = Math.ceil(ms / 1000);
    const fraction = timer.durationMs ? Math.max(0, Math.min(1, ms / timer.durationMs)) : 0;
    if (variant === 'ring') {
      progressEl.setAttribute('stroke-dashoffset', (CIRCUMFERENCE * (1 - fraction)).toFixed(2));
    } else {
      progressEl.style.transform = `scaleX(${fraction})`;
    }
    const minutes = Math.floor(seconds / 60);
    label.textContent = timer.paused
      ? `${t.common.paused} · ${formatTime(seconds, minutes)}`
      : timer.expired
        ? t.common.timeUp
        : formatTime(seconds, minutes);
    el.classList.toggle('urgent', !timer.paused && !timer.expired && seconds <= 10);
    el.classList.toggle('paused', Boolean(timer.paused));
    el.classList.toggle('expired', Boolean(timer.expired) || seconds === 0);
    if (seconds !== lastSecond) {
      lastSecond = seconds;
      if (!timer.paused && !timer.expired) onTick?.(seconds);
    }
    if (!timer.paused && !timer.expired && ms > 0) frame = requestAnimationFrame(render);
  }

  function formatTime(seconds, minutes) {
    return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, '0')}` : String(seconds);
  }

  return {
    el,
    update(nextTimer) {
      timer = nextTimer;
      if (frame) cancelAnimationFrame(frame);
      render();
    },
    remaining,
  };
}
