import { storage } from './storage.js';

// Synthesised sound effects (WebAudio), no audio files needed.
let context = null;
let muted = storage.get('muted', false);
const listeners = new Set();

function ctx() {
  if (!context) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    context = new AudioContext();
  }
  if (context.state === 'suspended') context.resume().catch(() => {});
  return context;
}

// Browsers only allow audio after a user gesture.
function unlock() {
  ctx();
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
}
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

function tone({ freq = 440, duration = 0.12, type = 'sine', gain = 0.15, delay = 0, slideTo = null }) {
  const audio = ctx();
  if (!audio || muted) return;
  const start = audio.currentTime + delay;
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(amp).connect(audio.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

export const sound = {
  tick(last = false) {
    tone({ freq: last ? 880 : 660, duration: 0.08, type: 'square', gain: 0.06 });
  },
  gong() {
    tone({ freq: 196, duration: 0.9, type: 'triangle', gain: 0.2 });
    tone({ freq: 294, duration: 0.7, type: 'sine', gain: 0.1, delay: 0.02 });
  },
  pop() {
    tone({ freq: 520, duration: 0.09, type: 'sine', gain: 0.12, slideTo: 880 });
  },
  whoosh() {
    tone({ freq: 300, duration: 0.25, type: 'sawtooth', gain: 0.04, slideTo: 1200 });
  },
  fooled() {
    tone({ freq: 392, duration: 0.15, type: 'triangle', gain: 0.12 });
    tone({ freq: 330, duration: 0.25, type: 'triangle', gain: 0.12, delay: 0.14 });
  },
  reveal() {
    [523, 659, 784, 1047].forEach((freq, i) => tone({ freq, duration: 0.3, type: 'triangle', gain: 0.14, delay: i * 0.11 }));
  },
  fanfare() {
    const notes = [523, 523, 523, 659, 784, 659, 784, 1047];
    notes.forEach((freq, i) => tone({ freq, duration: 0.22, type: 'square', gain: 0.07, delay: i * 0.14 }));
  },
  isMuted: () => muted,
  setMuted(value) {
    muted = Boolean(value);
    storage.set('muted', muted);
    for (const fn of listeners) fn(muted);
  },
  toggle() {
    this.setMuted(!muted);
  },
  onChange: (fn) => listeners.add(fn),
};
