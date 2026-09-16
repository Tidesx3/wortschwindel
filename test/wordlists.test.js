import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateWordlist,
  parseJsonWordlist,
  parseCsvWordlist,
  filterWords,
  pickWord,
} from '../src/game/wordlists.js';

test('valid list passes, invalid entries are skipped with messages', () => {
  const result = validateWordlist({
    title: 'Test',
    words: [
      { term: 'Apokope', definition: 'Wegfall.' },
      { term: '', definition: 'Ohne Begriff' },
      { term: 'Ohne Definition' },
      { term: 'Fiale', article: 'dem', definition: 'Turm.' },
      { term: 'Pedell', definition: 'Hausmeister.', difficulty: 9 },
      { term: 'apokope', definition: 'Doppelt.' },
      'kein Objekt',
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.words.length, 1);
  assert.equal(result.invalid, 6);
  assert.equal(result.errors.length, 6);
  assert.match(result.errors[0], /Eintrag 2/);
});

test('missing words array is reported, not thrown', () => {
  assert.equal(validateWordlist(null).ok, false);
  assert.equal(validateWordlist({ title: 'x' }).ok, false);
  assert.equal(parseJsonWordlist('{kaputt').ok, false);
});

test('bare JSON arrays are accepted', () => {
  const result = parseJsonWordlist('[{"term":"Apokope","definition":"Wegfall."}]', 'Import');
  assert.equal(result.words.length, 1);
  assert.equal(result.title, 'Import');
});

test('optional fields are kept and normalised', () => {
  const { words } = validateWordlist({
    words: [{ term: ' Apokope ', article: 'Die', wordClass: 'Substantiv', definition: 'Wegfall.', category: 'Sprache', difficulty: '2' }],
  });
  assert.deepEqual(words[0], {
    term: 'Apokope',
    article: 'die',
    wordClass: 'Substantiv',
    definition: 'Wegfall.',
    category: 'Sprache',
    difficulty: 2,
  });
});

test('CSV import with header, quotes and invalid lines', () => {
  const csv = [
    'Begriff;Artikel;Definition;Kategorie',
    'Apokope;die;Wegfall eines Lauts am Wortende.;Sprache',
    'Fiale;;"Türmchen; gotisch";Architektur',
    '',
    'Kaputt;der',
    '# Kommentar',
    'Pedell;das;Hausmeister.',
  ].join('\r\n');
  const result = parseCsvWordlist(csv);
  assert.equal(result.words.length, 3);
  assert.equal(result.invalid, 1);
  assert.match(result.errors[0], /Zeile 5/);
  assert.equal(result.words[1].definition, 'Türmchen; gotisch');
  assert.equal(result.words[1].article, undefined);
  assert.equal(result.words[2].category, undefined);
});

test('CSV with invalid article reports the CSV line number', () => {
  const result = parseCsvWordlist('Apokope;dem;Wegfall.\nFiale;die;Turm.');
  assert.equal(result.words.length, 1);
  assert.match(result.errors[0], /Zeile 1/);
});

test('filter by category and difficulty', () => {
  const words = [
    { term: 'a', category: 'X', difficulty: 1 },
    { term: 'b', category: 'Y', difficulty: 2 },
    { term: 'c', category: 'X', difficulty: 3 },
  ];
  assert.deepEqual(filterWords(words, { categories: ['X'] }).map((w) => w.term), ['a', 'c']);
  assert.deepEqual(filterWords(words, { difficulties: [2, 3] }).map((w) => w.term), ['b', 'c']);
  assert.equal(filterWords(words).length, 3);
});

test('pickWord never repeats and prefers unplayed words', () => {
  const words = [{ term: 'a' }, { term: 'b' }, { term: 'c' }];
  const used = new Set(['a']);
  const played = new Set(['a', 'b']);
  for (let i = 0; i < 20; i++) assert.equal(pickWord(words, used, played).term, 'c');
  assert.equal(pickWord(words, new Set(['a', 'b', 'c'])), null);
  assert.equal(pickWord(words, new Set(['a', 'c']), played).term, 'b');
});

test('bundled sample list is valid and has 15 entries', () => {
  const data = JSON.parse(readFileSync(new URL('../data/wordlists/beispiel.json', import.meta.url), 'utf8'));
  const result = validateWordlist(data);
  assert.equal(result.invalid, 0, result.errors.join('\n'));
  assert.equal(result.words.length, 15);
});
