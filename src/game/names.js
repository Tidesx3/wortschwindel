import { cleanText } from './normalize.js';

export const NAME_MIN = 2;
export const NAME_MAX = 20;
export const MEMBERS_MAX = 60;

// Lowercase, strip accents and common leetspeak so the blocklist catches simple variants.
function simplify(text) {
  return text
    .toLocaleLowerCase('de-DE')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/[@]/g, 'a')
    .replace(/[^a-z]/g, '');
}

export function nameKey(name) {
  return cleanText(name).toLocaleLowerCase('de-DE');
}

/**
 * @returns {{ok: true, name: string} | {ok: false, error: string}}
 */
export function validateName(rawName, { existingNames = [], blockedWords = [] } = {}) {
  if (typeof rawName !== 'string') return { ok: false, error: 'nameInvalid' };
  const name = cleanText(rawName);
  if (name.length < NAME_MIN) return { ok: false, error: 'nameTooShort' };
  if (name.length > NAME_MAX) return { ok: false, error: 'nameTooLong' };
  const simplified = simplify(name);
  for (const word of blockedWords) {
    const blocked = simplify(String(word));
    if (blocked && simplified.includes(blocked)) return { ok: false, error: 'nameBlocked' };
  }
  const key = nameKey(name);
  if (existingNames.some((existing) => nameKey(existing) === key)) {
    return { ok: false, error: 'nameTaken' };
  }
  return { ok: true, name };
}

export function validateMembers(rawMembers) {
  if (rawMembers == null || rawMembers === '') return { ok: true, members: '' };
  if (typeof rawMembers !== 'string') return { ok: false, error: 'membersInvalid' };
  const members = cleanText(rawMembers);
  if (members.length > MEMBERS_MAX) return { ok: false, error: 'membersTooLong' };
  return { ok: true, members };
}
