import { prefersReducedMotion } from './dom.js';

const COLORS = ['#ff6b35', '#ffd23f', '#3bceac', '#0ead69', '#5e60ce', '#ee4266'];

/** Short burst of canvas confetti; no-op with reduced motion. */
export function confetti({ duration = 4000, count = 180 } = {}) {
  if (prefersReducedMotion()) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  document.body.append(canvas);
  const context = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
  };
  resize();
  window.addEventListener('resize', resize);

  const launch = (p, spread) =>
    Object.assign(p, {
      x: Math.random() * canvas.width,
      y: -p.h - Math.random() * canvas.height * spread,
      vx: (Math.random() - 0.5) * 3 * dpr,
      vy: (2 + Math.random() * 4) * dpr,
    });
  const pieces = Array.from({ length: count }, () =>
    launch(
      {
        w: (6 + Math.random() * 8) * dpr,
        h: (8 + Math.random() * 10) * dpr,
        rotation: Math.random() * Math.PI,
        spin: (Math.random() - 0.5) * 0.3,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      },
      0.5,
    ),
  );

  const start = performance.now();
  let last = start;
  function frame(now) {
    const elapsed = now - start;
    // Motion is scaled to a 60 Hz frame so high-refresh screens don't empty the sky early.
    const dt = Math.min(Math.max(now - last, 0), 50) / (1000 / 60);
    last = now;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const fade = Math.max(0, 1 - Math.max(0, elapsed - duration + 800) / 800);
    context.globalAlpha = fade;
    for (const p of pieces) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.05 * dpr * dt;
      p.rotation += p.spin * dt;
      // Long bursts keep raining until shortly before the fade-out.
      if (p.y > canvas.height + p.h && elapsed < duration - 2500) launch(p, 0.2);
      context.save();
      context.translate(p.x, p.y);
      context.rotate(p.rotation);
      context.fillStyle = p.color;
      context.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      context.restore();
    }
    if (elapsed < duration) {
      requestAnimationFrame(frame);
    } else {
      window.removeEventListener('resize', resize);
      canvas.remove();
    }
  }
  requestAnimationFrame(frame);
}
