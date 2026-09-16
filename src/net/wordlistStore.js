import fs from 'node:fs';
import path from 'node:path';
import { validateWordlist } from '../game/wordlists.js';

/**
 * Loads every data/wordlists/*.json at startup. Broken files or entries are
 * reported and skipped; the server never crashes because of a word list.
 * @returns {Record<string, {title: string, words: object[]}>}
 */
export function loadWordlists(dir, log = console) {
  const lists = {};
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((file) => file.toLowerCase().endsWith('.json')).sort();
  } catch (error) {
    log.warn(`[wordlists] Ordner ${dir} nicht lesbar: ${error.message}`);
    return lists;
  }
  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8').replace(/^﻿/, ''));
    } catch (error) {
      log.warn(`[wordlists] ${file} übersprungen: kein gültiges JSON (${error.message})`);
      continue;
    }
    const result = validateWordlist(data, name);
    for (const message of result.errors) log.warn(`[wordlists] ${file}: ${message} – übersprungen`);
    if (!result.words.length) {
      log.warn(`[wordlists] ${file} enthält keine gültigen Wörter und wird ignoriert`);
      continue;
    }
    lists[name] = { title: result.title, words: result.words };
    log.info(`[wordlists] ${file}: ${result.words.length} Wörter geladen („${result.title}“)`);
  }
  return lists;
}

export function loadBlockedWords(file, log = console) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const words = Array.isArray(data) ? data : data.words;
    if (!Array.isArray(words)) throw new Error('Feld „words“ fehlt');
    return words.filter((w) => typeof w === 'string' && w.trim());
  } catch (error) {
    log.warn(`[names] Blockliste ${file} nicht geladen: ${error.message}`);
    return [];
  }
}

export function summarizeWordlists(lists) {
  return Object.entries(lists).map(([name, list]) => ({
    name,
    title: list.title,
    count: list.words.length,
    categories: [...new Set(list.words.map((w) => w.category).filter(Boolean))].sort(),
    difficulties: [...new Set(list.words.map((w) => w.difficulty).filter(Boolean))].sort(),
  }));
}
