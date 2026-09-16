import { DEFAULT_POINTS } from './scoring.js';

export const DEFAULT_SETTINGS = Object.freeze({
  rounds: 6,
  writingSeconds: 90, // 0 = no time limit
  votingSeconds: 45, // 0 = no time limit
  maxDefinitionLength: 150,
  wordlist: 'beispiel',
  categories: [],
  difficulties: [],
  points: { ...DEFAULT_POINTS },
  autoAdvanceOnTimer: true,
  autoModeration: true,
  autoRevealWhenAllVoted: true,
  readAloudMode: true,
  showWordClass: true,
  standardizeAnswers: true,
  allowLateJoin: false,
  maxPlayers: 30,
});

// Settings that may change while a game is running.
const IN_GAME_KEYS = new Set([
  'rounds',
  'writingSeconds',
  'votingSeconds',
  'autoAdvanceOnTimer',
  'autoModeration',
  'autoRevealWhenAllVoted',
  'readAloudMode',
  'showWordClass',
  'allowLateJoin',
  'maxPlayers',
]);

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function seconds(value, fallback) {
  const number = clampInt(value, 0, 900, fallback);
  // 0 means "no limit"; otherwise enforce a sensible minimum.
  return number === 0 ? 0 : Math.max(5, number);
}

function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

/**
 * Merges a partial, untrusted settings object into the current settings.
 * @param {object} current
 * @param {unknown} partial
 * @param {{inGame?: boolean}} options
 */
export function mergeSettings(current, partial, { inGame = false } = {}) {
  const next = structuredClone(current);
  if (!partial || typeof partial !== 'object') return next;
  const allowed = (key) => Object.hasOwn(partial, key) && (!inGame || IN_GAME_KEYS.has(key));
  const bool = (key) => {
    if (allowed(key) && typeof partial[key] === 'boolean') next[key] = partial[key];
  };

  if (allowed('rounds')) next.rounds = clampInt(partial.rounds, 1, 50, next.rounds);
  if (allowed('writingSeconds')) next.writingSeconds = seconds(partial.writingSeconds, next.writingSeconds);
  if (allowed('votingSeconds')) next.votingSeconds = seconds(partial.votingSeconds, next.votingSeconds);
  if (allowed('maxDefinitionLength')) {
    next.maxDefinitionLength = clampInt(partial.maxDefinitionLength, 30, 300, next.maxDefinitionLength);
  }
  if (allowed('maxPlayers')) next.maxPlayers = clampInt(partial.maxPlayers, 2, 100, next.maxPlayers);
  if (allowed('wordlist') && typeof partial.wordlist === 'string') next.wordlist = partial.wordlist.slice(0, 80);
  if (allowed('categories')) next.categories = stringList(partial.categories, 50, 40);
  if (allowed('difficulties') && Array.isArray(partial.difficulties)) {
    next.difficulties = [...new Set(partial.difficulties.map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 5))];
  }
  if (allowed('points') && partial.points && typeof partial.points === 'object') {
    for (const key of Object.keys(DEFAULT_POINTS)) {
      if (Object.hasOwn(partial.points, key)) {
        next.points[key] = clampInt(partial.points[key], 0, 20, next.points[key]);
      }
    }
  }
  for (const key of [
    'autoAdvanceOnTimer',
    'autoModeration',
    'autoRevealWhenAllVoted',
    'readAloudMode',
    'showWordClass',
    'standardizeAnswers',
    'allowLateJoin',
  ]) {
    bool(key);
  }
  return next;
}

export function applyDevTimers(settings) {
  return { ...settings, writingSeconds: 15, votingSeconds: 10 };
}
