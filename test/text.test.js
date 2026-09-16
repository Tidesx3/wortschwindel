import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDefinition, comparisonKey } from '../src/game/normalize.js';
import { validateName, validateMembers } from '../src/game/names.js';
import { generateRoomCode, ROOM_CODE_ALPHABET } from '../src/game/random.js';
import { exportGameCsv } from '../src/game/exportCsv.js';
import { createGame, toModeration, realEntry } from './helpers.js';

test('normalisation: spaces, capitalisation, final period', () => {
  assert.equal(normalizeDefinition('  ein   kleines    Tier '), 'Ein kleines Tier.');
  assert.equal(normalizeDefinition('Tier!!'), 'Tier.');
  assert.equal(normalizeDefinition('Tier...'), 'Tier.');
  assert.equal(normalizeDefinition('„Ein Tier“'), 'Ein Tier.');
  assert.equal(normalizeDefinition('Tier,'), 'Tier.');
  assert.equal(normalizeDefinition('   '), '');
  assert.equal(normalizeDefinition('übler Geruch'), 'Übler Geruch.');
  assert.equal(normalizeDefinition('Tier , das bellt'), 'Tier, das bellt.');
});

test('normalisation strips spoken lead-ins', () => {
  assert.equal(normalizeDefinition('Das ist ein Werkzeug zum Schneiden'), 'Ein Werkzeug zum Schneiden.');
  assert.equal(normalizeDefinition('es bedeutet eine Art Tanz'), 'Eine Art Tanz.');
  assert.equal(normalizeDefinition('Damit meint man einen alten Brauch'), 'Einen alten Brauch.');
  assert.equal(normalizeDefinition('Bedeutet: kleiner Vogel'), 'Kleiner Vogel.');
  assert.equal(normalizeDefinition('Eine Fiale ist ein kleiner Turm'), 'Ein kleiner Turm.');
  // No stripping when nothing meaningful would remain.
  assert.equal(normalizeDefinition('Das ist es'), 'Das ist es.');
});

test('normalisation can be limited to the basics', () => {
  assert.equal(normalizeDefinition('das ist ein Tier!', { standardize: false }), 'Das ist ein Tier!');
  assert.equal(normalizeDefinition('ein Tier', { standardize: false }), 'Ein Tier.');
});

test('real and player definitions look alike after normalisation', () => {
  const { game, ids } = createGame();
  toModeration(game, ids, ['wegfall von silben', 'Zwei', 'Drei']);
  // Test word list has a lower-case real definition without a period.
  for (const d of game.round.definitions) {
    assert.match(d.text, /^\p{Lu}.*\.$/u);
  }
  game.startVoting(0);
  assert.ok(realEntry(game).text.endsWith('.'));
});

test('comparison key ignores case and punctuation', () => {
  assert.equal(comparisonKey('Ein  Tier!'), comparisonKey('ein tier'));
});

test('name validation', () => {
  assert.deepEqual(validateName('  Team   Blau '), { ok: true, name: 'Team Blau' });
  assert.equal(validateName('A').error, 'nameTooShort');
  assert.equal(validateName('x'.repeat(21)).error, 'nameTooLong');
  assert.equal(validateName(42).error, 'nameInvalid');
  assert.equal(validateName('ANNA', { existingNames: ['anna'] }).error, 'nameTaken');
  assert.equal(validateName('Sch1mpf', { blockedWords: ['schimpf'] }).error, 'nameBlocked');
  assert.equal(validateName('Bär', { blockedWords: ['bar'] }).error, 'nameBlocked');
  assert.equal(validateMembers('Anna, Ben').members, 'Anna, Ben');
  assert.equal(validateMembers('x'.repeat(61)).error, 'membersTooLong');
  assert.equal(validateMembers(undefined).members, '');
});

test('room codes use only readable letters', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode();
    assert.match(code, /^[A-Z]{4}$/);
    assert.ok(![...code].some((c) => 'OIL'.includes(c)));
    assert.ok([...code].every((c) => ROOM_CODE_ALPHABET.includes(c)));
  }
  const taken = new Set();
  const unique = generateRoomCode((code) => code.startsWith('A'));
  assert.ok(!unique.startsWith('A'));
  assert.ok(taken.size === 0);
});

test('csv export contains ranking and rounds and neutralises formulas', () => {
  const { game, ids } = createGame({ settings: { rounds: 1 } });
  toModeration(game, ids, ['=HYPERLINK("x")', 'Zwei; mit Semikolon', 'Drei']);
  game.startVoting(0);
  for (const id of ids) game.vote(id, realEntry(game).id, 0);
  game.revealAll(0);
  game.next(0);
  const csv = exportGameCsv(game, 0);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('Rangliste'));
  assert.ok(csv.includes('Runde 1'));
  assert.ok(csv.includes('"Zwei; mit Semikolon."'));
  assert.ok(!csv.includes(';=HYPERLINK'));
});
