// Round modifiers the host can pick before a round (or let the wheel decide).
export const MODIFIERS = Object.freeze(['double', 'truth', 'bluffer', 'favorite', 'catchup', 'blitz']);

export const BLITZ_SECONDS = 30;

export function sanitizeModifiers(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((id) => MODIFIERS.includes(id)))];
}

export function spinWheel(rand = Math.random) {
  return MODIFIERS[Math.floor(rand() * MODIFIERS.length)];
}

/**
 * Point multiplier for one player and one kind of points.
 * @param {string[]} modifiers
 * @param {Set<string>|string[]} catchupIds players in the lower half (Aufholjagd)
 * @param {string} playerId
 * @param {'correct'|'fooled'|'marked'|'favorite'} kind
 */
export function pointFactor(modifiers, catchupIds, playerId, kind) {
  let factor = 1;
  if (modifiers.includes('double')) factor *= 2;
  if (modifiers.includes('catchup') && [...catchupIds].includes(playerId)) factor *= 2;
  if (kind === 'correct' && modifiers.includes('truth')) factor *= 2;
  if (kind === 'fooled' && modifiers.includes('bluffer')) factor *= 2;
  return factor;
}
