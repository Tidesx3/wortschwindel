// Keeps the phone display on during the game (Screen Wake Lock API).
// Fallback for older browsers: a tiny looping muted video keeps iOS < 16.4 awake.

let sentinel = null;
let wanted = false;
let fallbackVideo = null;

async function request() {
  if (!wanted || document.visibilityState !== 'visible') return;
  if ('wakeLock' in navigator) {
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
      });
      return;
    } catch {
      // Fall through to the fallback (e.g. permission denied, low battery).
    }
  }
  startFallback();
}

function startFallback() {
  if (fallbackVideo) {
    fallbackVideo.play().catch(() => {});
    return;
  }
  // Minimal silent webm/mp4 would be ideal; an empty looping canvas stream works in many browsers.
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  if (!canvas.captureStream) return;
  fallbackVideo = document.createElement('video');
  fallbackVideo.muted = true;
  fallbackVideo.playsInline = true;
  fallbackVideo.setAttribute('playsinline', '');
  fallbackVideo.loop = true;
  fallbackVideo.className = 'wakelock-video';
  fallbackVideo.srcObject = canvas.captureStream(1);
  document.body.append(fallbackVideo);
  fallbackVideo.play().catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wanted && !sentinel) request();
});

// Needs a user gesture on some browsers.
['pointerdown', 'keydown'].forEach((event) =>
  window.addEventListener(event, () => {
    if (wanted && !sentinel) request();
  }),
);

export function keepAwake(enable) {
  wanted = enable;
  if (enable) {
    if (!sentinel) request();
  } else {
    sentinel?.release().catch(() => {});
    sentinel = null;
    fallbackVideo?.pause();
  }
}
