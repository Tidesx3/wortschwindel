import QRCode from 'qrcode';
import { Game } from '../game/Game.js';
import { generateRoomCode } from '../game/random.js';
import { applyDevTimers } from '../game/settings.js';

const TICK_MS = 1000;

/**
 * Owns all rooms and their real timers. Calls `onChange(game)` whenever a
 * timer or periodic check changed a game, and `onClose(game)` when a room is removed.
 */
export class RoomManager {
  constructor({ config, getWordlists, blockedWords, onChange, onClose, log = console }) {
    this.config = config;
    this.getWordlists = getWordlists;
    this.blockedWords = blockedWords;
    this.onChange = onChange;
    this.onClose = onClose;
    this.log = log;
    /** @type {Map<string, Game>} */
    this.rooms = new Map();
    /** @type {Map<string, NodeJS.Timeout>} */
    this.timeouts = new Map();
    /** @type {Map<string, {url: string, qr: string}>} */
    this.joinInfo = new Map();
    this.interval = null;
  }

  start() {
    this.interval = setInterval(() => this.maintenance(Date.now()), TICK_MS);
    this.interval.unref?.();
  }

  stop() {
    clearInterval(this.interval);
    for (const timeout of this.timeouts.values()) clearTimeout(timeout);
    this.timeouts.clear();
  }

  get(code) {
    if (typeof code !== 'string') return null;
    return this.rooms.get(code.trim().toUpperCase()) ?? null;
  }

  async create({ hostToken, settings, baseUrl }, now = Date.now()) {
    const code = generateRoomCode((candidate) => this.rooms.has(candidate));
    const game = new Game({
      code,
      hostToken,
      settings: this.config.devShortTimers ? applyDevTimers(settings ?? {}) : settings,
      getWordlists: this.getWordlists,
      blockedWords: this.blockedWords,
      now,
    });
    const lists = this.getWordlists();
    if (!lists[game.settings.wordlist]) game.settings.wordlist = Object.keys(lists)[0] ?? '';
    this.rooms.set(code, game);
    await this.ensureJoinInfo(game, baseUrl);
    this.log.info(`[room ${code}] erstellt`);
    return game;
  }

  restore(game) {
    this.rooms.set(game.code, game);
    this.schedule(game);
  }

  async ensureJoinInfo(game, baseUrl) {
    const base = this.config.publicUrl || baseUrl;
    const existing = this.joinInfo.get(game.code);
    if (existing && (existing.base === base || !baseUrl)) return existing;
    const url = `${base}/join/${game.code}`;
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 480, errorCorrectionLevel: 'M' });
    const info = { base, url, qr };
    this.joinInfo.set(game.code, info);
    return info;
  }

  getJoinInfo(code) {
    const info = this.joinInfo.get(code);
    return info ? { url: info.url, qr: info.qr } : null;
  }

  close(code, reason = 'closed') {
    const game = this.rooms.get(code);
    if (!game) return;
    clearTimeout(this.timeouts.get(code));
    this.timeouts.delete(code);
    this.rooms.delete(code);
    this.joinInfo.delete(code);
    this.log.info(`[room ${code}] geschlossen (${reason})`);
    this.onClose(game, reason);
  }

  /** (Re)plans the real timeout for the game's timer. Call after every change. */
  schedule(game) {
    clearTimeout(this.timeouts.get(game.code));
    this.timeouts.delete(game.code);
    const timer = game.timer;
    if (!timer || timer.paused || timer.expired) return;
    const delay = Math.max(0, timer.endsAt - Date.now()) + 15;
    const timeout = setTimeout(() => {
      this.timeouts.delete(game.code);
      this.runSafely(game, () => game.onTimerExpired(Date.now()));
    }, delay);
    timeout.unref?.();
    this.timeouts.set(game.code, timeout);
  }

  runSafely(game, fn) {
    try {
      if (fn()) {
        this.schedule(game);
        this.onChange(game);
      }
    } catch (error) {
      this.log.error(`[room ${game.code}] Fehler im Timer: ${error.stack ?? error}`);
    }
  }

  maintenance(now) {
    for (const game of this.rooms.values()) {
      if (now - game.lastActivity > this.config.roomTtlMs) {
        this.close(game.code, 'inaktiv');
        continue;
      }
      this.runSafely(game, () => game.tick(now));
    }
  }

  snapshot() {
    return [...this.rooms.values()].map((game) => game.toJSON());
  }
}
