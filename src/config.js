import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

export function loadConfig(env = process.env) {
  const hostPin = env.HOST_PIN ?? '';
  const production = env.NODE_ENV === 'production';
  if (!hostPin && production) {
    throw new Error('HOST_PIN must be set in production');
  }
  return {
    rootDir,
    dataDir: path.resolve(env.DATA_DIR ?? path.join(rootDir, 'data')),
    publicDir: path.join(rootDir, 'public'),
    port: Number(env.PORT) || 3000,
    // Local development falls back to a well-known PIN and warns about it.
    hostPin: hostPin || '1234',
    hostPinIsDefault: !hostPin,
    publicUrl: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
    persist: bool(env.PERSIST),
    devShortTimers: bool(env.DEV_SHORT_TIMERS),
    roomTtlMs: (Number(env.ROOM_TTL_HOURS) || 3) * 60 * 60 * 1000,
    production,
  };
}
