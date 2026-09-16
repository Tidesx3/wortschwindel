import { cleanText } from './normalize.js';

export const ARTICLES = ['der', 'die', 'das'];
export const MAX_TERM_LENGTH = 60;
export const MAX_DEFINITION_LENGTH = 300;
export const MAX_IMPORT_WORDS = 2000;

function optionalString(value, maxLength) {
  if (value == null || value === '') return { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false };
  const cleaned = cleanText(value);
  if (cleaned.length > maxLength) return { ok: false };
  return { ok: true, value: cleaned || undefined };
}

/**
 * Validates a single word entry.
 * @returns {{ok: true, word: object} | {ok: false, error: string}}
 */
export function validateWord(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, error: 'Eintrag ist kein Objekt' };
  }
  const term = typeof entry.term === 'string' ? cleanText(entry.term) : '';
  if (!term) return { ok: false, error: 'Begriff fehlt' };
  if (term.length > MAX_TERM_LENGTH) return { ok: false, error: `Begriff „${term}“ ist zu lang` };

  const definition = typeof entry.definition === 'string' ? cleanText(entry.definition) : '';
  if (!definition) return { ok: false, error: `Definition für „${term}“ fehlt` };
  if (definition.length > MAX_DEFINITION_LENGTH) {
    return { ok: false, error: `Definition für „${term}“ ist zu lang` };
  }

  const word = { term, definition };

  const article = optionalString(entry.article, 10);
  if (!article.ok) return { ok: false, error: `Ungültiger Artikel bei „${term}“` };
  if (article.value) {
    const lower = article.value.toLowerCase();
    if (!ARTICLES.includes(lower)) return { ok: false, error: `Ungültiger Artikel „${article.value}“ bei „${term}“` };
    word.article = lower;
  }

  const wordClass = optionalString(entry.wordClass, 30);
  if (!wordClass.ok) return { ok: false, error: `Ungültige Wortart bei „${term}“` };
  if (wordClass.value) word.wordClass = wordClass.value;

  const category = optionalString(entry.category, 40);
  if (!category.ok) return { ok: false, error: `Ungültige Kategorie bei „${term}“` };
  if (category.value) word.category = category.value;

  if (entry.difficulty != null && entry.difficulty !== '') {
    const difficulty = Number(entry.difficulty);
    if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
      return { ok: false, error: `Schwierigkeit bei „${term}“ muss 1–5 sein` };
    }
    word.difficulty = difficulty;
  }
  return { ok: true, word };
}

/**
 * Validates a whole wordlist object. Invalid entries are skipped, never fatal.
 * @returns {{ok: boolean, title: string, words: object[], errors: string[], invalid: number}}
 */
export function validateWordlist(data, fallbackTitle = 'Wortliste') {
  const errors = [];
  if (!data || typeof data !== 'object' || !Array.isArray(data.words)) {
    return { ok: false, title: fallbackTitle, words: [], errors: ['Feld „words“ (Liste) fehlt'], invalid: 0 };
  }
  const title = typeof data.title === 'string' && cleanText(data.title) ? cleanText(data.title).slice(0, 60) : fallbackTitle;
  const words = [];
  const seen = new Set();
  let invalid = 0;
  data.words.slice(0, MAX_IMPORT_WORDS).forEach((entry, index) => {
    const result = validateWord(entry);
    if (!result.ok) {
      invalid++;
      errors.push(`Eintrag ${index + 1}: ${result.error}`);
      return;
    }
    const key = result.word.term.toLocaleLowerCase('de-DE');
    if (seen.has(key)) {
      invalid++;
      errors.push(`Eintrag ${index + 1}: „${result.word.term}“ ist doppelt`);
      return;
    }
    seen.add(key);
    words.push(result.word);
  });
  if (data.words.length > MAX_IMPORT_WORDS) {
    errors.push(`Nur die ersten ${MAX_IMPORT_WORDS} Einträge wurden gelesen`);
  }
  return { ok: words.length > 0, title, words, errors, invalid };
}

export function parseJsonWordlist(content, fallbackTitle) {
  let data;
  try {
    data = JSON.parse(content);
  } catch (error) {
    return { ok: false, title: fallbackTitle, words: [], errors: [`Kein gültiges JSON: ${error.message}`], invalid: 0 };
  }
  // Accept a bare array of words as well.
  if (Array.isArray(data)) data = { title: fallbackTitle, words: data };
  return validateWordlist(data, fallbackTitle);
}

// Splits one CSV line with the given delimiter, honouring double quotes.
function splitCsvLine(line, delimiter) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"' && current.trim() === '') {
      quoted = true;
      current = '';
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

/**
 * Parses "Begriff;Artikel;Definition;Kategorie" lines. A header line is skipped.
 */
export function parseCsvWordlist(content, fallbackTitle = 'Importierte Liste') {
  const lines = String(content ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const entries = [];
  const errors = [];
  let invalidLines = 0;
  lines.forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const delimiter = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
    const [term = '', article = '', definition = '', category = ''] = splitCsvLine(line, delimiter);
    if (index === 0 && term.toLowerCase() === 'begriff') return;
    if (!term || !definition) {
      invalidLines++;
      errors.push(`Zeile ${index + 1}: Begriff oder Definition fehlt`);
      return;
    }
    entries.push({ term, article: article || undefined, definition, category: category || undefined, line: index + 1 });
  });
  const result = validateWordlist({ title: fallbackTitle, words: entries.map(({ line, ...word }) => word) }, fallbackTitle);
  // Map entry numbers in errors back to CSV line numbers.
  const mappedErrors = result.errors.map((error) =>
    error.replace(/^Eintrag (\d+):/, (_, n) => `Zeile ${entries[Number(n) - 1]?.line ?? n}:`),
  );
  return {
    ...result,
    errors: [...errors, ...mappedErrors],
    invalid: result.invalid + invalidLines,
  };
}

export function filterWords(words, { categories = [], difficulties = [] } = {}) {
  return words.filter(
    (word) =>
      (!categories.length || categories.includes(word.category)) &&
      (!difficulties.length || difficulties.includes(word.difficulty)),
  );
}

/**
 * Picks a word not used in this game; prefers words never played in this room.
 * @param {object[]} words candidate words
 * @param {Set<string>} usedInGame terms already drawn in the current game
 * @param {Set<string>} playedEver terms played in earlier games in this room
 */
export function pickWord(words, usedInGame, playedEver = new Set(), rand = Math.random) {
  const available = words.filter((word) => !usedInGame.has(word.term));
  if (!available.length) return null;
  const fresh = available.filter((word) => !playedEver.has(word.term));
  const pool = fresh.length ? fresh : available;
  return pool[Math.floor(rand() * pool.length)];
}
