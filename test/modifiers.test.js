import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRound } from '../src/game/scoring.js';
import { pointFactor, sanitizeModifiers, spinWheel, MODIFIERS } from '../src/game/modifiers.js';
import { getStateFor } from '../src/game/views.js';
import { Game } from '../src/game/Game.js';
import { createGame, toModeration, ownEntry, realEntry, WORDS } from './helpers.js';

const players = ['a', 'b', 'c', 'd'];
const definitions = [
  { id: 'real', isReal: true, authorIds: [] },
  { id: 'fa', isReal: false, authorIds: ['a'] },
  { id: 'fb', isReal: false, authorIds: ['b'] },
];
const votes = { a: 'real', b: 'fa', c: 'fa', d: 'real' };

function assertGameError(fn, code) {
  assert.throws(fn, (error) => error.code === code, `expected error ${code}`);
}

test('sanitizeModifiers keeps only known ids once', () => {
  assert.deepEqual(sanitizeModifiers(['double', 'x', 'double', 'blitz']), ['double', 'blitz']);
  assert.deepEqual(sanitizeModifiers('double'), []);
  assert.ok(MODIFIERS.includes(spinWheel(() => 0.99)));
});

test('point factors stack', () => {
  assert.equal(pointFactor([], [], 'a', 'correct'), 1);
  assert.equal(pointFactor(['double', 'truth'], [], 'a', 'correct'), 4);
  assert.equal(pointFactor(['double', 'truth'], [], 'a', 'fooled'), 2);
  assert.equal(pointFactor(['bluffer', 'catchup'], ['a'], 'a', 'fooled'), 4);
  assert.equal(pointFactor(['bluffer', 'catchup'], ['a'], 'b', 'fooled'), 2);
});

test('double points double everything', () => {
  const { players: r } = scoreRound({ definitions, votes, playerIds: players, modifiers: ['double'] });
  assert.equal(r.a.total, 8);
  assert.equal(r.d.total, 4);
});

test('truth bonus doubles only the real-definition points', () => {
  const { players: r } = scoreRound({ definitions, votes, playerIds: players, modifiers: ['truth'] });
  assert.equal(r.a.correctPoints, 4);
  assert.equal(r.a.fooledPoints, 2);
  assert.equal(r.a.total, 6);
});

test('master bluffer doubles only fooled votes', () => {
  const { players: r, entryPoints } = scoreRound({ definitions, votes, playerIds: players, modifiers: ['bluffer'] });
  assert.equal(r.a.total, 2 + 4);
  assert.equal(entryPoints.fa.a, 4);
});

test('catch-up doubles only the given players', () => {
  const { players: r } = scoreRound({ definitions, votes, playerIds: players, modifiers: ['catchup'], catchupIds: ['d'] });
  assert.equal(r.a.total, 4);
  assert.equal(r.d.total, 4);
});

test('favorite: most favourite votes on an invented entry win, ties share, real and own ignored', () => {
  const favorites = { a: 'fb', b: 'fa', c: 'fb', d: 'real' };
  const { players: r, favorite } = scoreRound({ definitions, votes, playerIds: players, modifiers: ['favorite'], favorites });
  assert.deepEqual(favorite.winnerIds, ['fb']);
  assert.equal(favorite.count, 2);
  assert.equal(r.b.favoritePoints, 2);
  assert.equal(r.b.total, 2);

  const tie = scoreRound({ definitions, votes, playerIds: players, modifiers: ['favorite', 'double'], favorites: { c: 'fa', d: 'fb', a: 'fa' } });
  assert.deepEqual(tie.favorite.winnerIds.sort(), ['fa', 'fb']);
  assert.equal(tie.players.a.favoritePoints, 4);
  assert.equal(tie.players.b.favoritePoints, 4);

  const own = scoreRound({ definitions, votes, playerIds: players, modifiers: ['favorite'], favorites: { a: 'fa' } });
  assert.deepEqual(own.favorite.winnerIds, []);
});

test('favorites are ignored without the modifier', () => {
  const { players: r, favorite } = scoreRound({ definitions, votes, playerIds: players, favorites: { c: 'fb' } });
  assert.equal(favorite, null);
  assert.equal(r.b.total, 0);
});

test('next round preparation: modifiers, word preview and reset after the round starts', () => {
  const { game } = createGame({ settings: { rounds: 3 } });
  game.setNextRound({ modifiers: ['double', 'blitz', 'nope'] }, 0);
  assert.deepEqual(game.nextRound.modifiers, ['double', 'blitz']);
  game.chooseNextWord('Pedell', 0);
  assertGameError(() => game.chooseNextWord('Unbekannt', 0), 'wordNotAvailable');
  game.startGame(1_000);
  assert.equal(game.round.word.term, 'Pedell');
  assert.deepEqual(game.round.modifiers, ['double', 'blitz']);
  assert.equal(game.timer.endsAt, 31_000, 'blitz round: 30 s');
  assert.deepEqual(game.nextRound, { modifiers: [], wheel: false, term: null });
  assertGameError(() => game.setNextRound({ modifiers: ['double'] }, 0), 'wrongPhase');
});

test('skipping a word keeps the round modifiers', () => {
  const { game } = createGame();
  game.setNextRound({ modifiers: ['bluffer'] }, 0);
  game.startGame(0);
  game.skipWord(0);
  assert.deepEqual(game.round.modifiers, ['bluffer']);
});

test('drawing a preview word gives a different unused word', () => {
  const { game } = createGame();
  game.drawNextWord(0);
  const first = game.nextRound.term;
  for (let i = 0; i < 10; i++) {
    game.drawNextWord(0);
    assert.notEqual(game.nextRound.term, first);
    game.chooseNextWord(first, 0);
  }
  game.chooseNextWord(null, 0);
  assert.equal(game.nextRound.term, null);
});

test('an invalid planned word falls back to a random one', () => {
  const { game } = createGame();
  game.chooseNextWord('Pedell', 0);
  game.updateSettings({ categories: ['Architektur'] }, 0);
  game.startGame(0);
  assert.equal(game.round.word.term, 'Fiale');
});

test('wheel picks exactly one modifier', () => {
  const { game } = createGame();
  game.random = () => 0; // first modifier
  game.setNextRound({ wheel: true, modifiers: ['favorite'] }, 0);
  game.startGame(0);
  assert.equal(game.round.wheel, true);
  assert.deepEqual(game.round.modifiers, [MODIFIERS[0]]);
});

test('catch-up picks the lower half of the ranking at round start', () => {
  const { game, ids } = createGame({ players: ['Anna', 'Ben', 'Chris', 'Dora'], settings: { rounds: 3 } });
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei', 'Vier']);
  game.startVoting(0);
  const real = realEntry(game).id;
  game.vote(ids[0], real, 0);
  game.vote(ids[1], real, 0);
  game.vote(ids[2], ownEntry(game, ids[3]).id, 0);
  game.vote(ids[3], ownEntry(game, ids[2]).id, 0);
  game.revealAll(0);
  game.goToScoreboard(0);
  // Scores: Anna 2, Ben 2, Chris 1, Dora 1
  game.setNextRound({ modifiers: ['catchup'] }, 0);
  game.next(0);
  assert.deepEqual([...game.round.catchupIds].sort(), [ids[2], ids[3]].sort());
  const view = getStateFor(game, 'player', ids[2], 0);
  assert.equal(view.you.catchup, true);
  assert.equal(getStateFor(game, 'player', ids[0], 0).you.catchup, false);
  assert.deepEqual(view.modifiers.list, ['catchup']);
});

test('catch-up rule handles ties sensibly', () => {
  const { game } = createGame({ players: [] });
  const make = (scores) => scores.map((score, i) => ({ id: `p${i}`, score }));
  assert.deepEqual(game.catchupPlayerIds(make([4, 0, 0, 0, 0])), ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(game.catchupPlayerIds(make([8, 4, 4, 2, 0])), ['p3', 'p4']);
  assert.deepEqual(game.catchupPlayerIds(make([5, 5, 0, 0])), ['p2', 'p3']);
  assert.deepEqual(game.catchupPlayerIds(make([3, 3, 3])), []);
  assert.deepEqual(game.catchupPlayerIds(make([0, 0])), []);
  assert.deepEqual(game.catchupPlayerIds(make([7])), []);
});

test('favorite votes: validation, auto reveal waits for them, reveal step and points', () => {
  const { game, ids } = createGame();
  game.setNextRound({ modifiers: ['favorite'] }, 0);
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  const [a, b, c] = ids;
  assertGameError(() => game.voteFavorite(a, ownEntry(game, a).id, 0), 'ownDefinition');
  const real = realEntry(game).id;
  game.vote(a, real, 0);
  game.vote(b, real, 0);
  game.vote(c, real, 0);
  assert.equal(game.phase, 'VOTING', 'waits for favourite votes');
  game.voteFavorite(a, ownEntry(game, b).id, 0);
  game.voteFavorite(c, ownEntry(game, b).id, 0);
  game.voteFavorite(b, null, 0);
  assert.equal(game.phase, 'VOTING');
  game.voteFavorite(b, ownEntry(game, a).id, 0);
  assert.equal(game.phase, 'REVEAL');
  assert.equal(game.round.revealSteps.at(-1).type, 'favorite');

  let screen = getStateFor(game, 'screen', null, 0);
  assert.equal(screen.reveal.favorite, null);
  game.revealAll(0);
  screen = getStateFor(game, 'screen', null, 0);
  assert.equal(screen.reveal.favorite.winners.length, 1);
  assert.equal(screen.reveal.favorite.winners[0].authors[0].name, 'Ben');
  assert.equal(screen.reveal.favorite.winners[0].authors[0].points, 2);
  const benResult = getStateFor(game, 'player', b, 0).you.roundResult;
  assert.equal(benResult.favoritePoints, 2);
  assert.equal(benResult.total, 2 + 2);
  game.goToScoreboard(0);
  assert.equal(game.history[0].definitions.find((d) => d.authors.includes('Ben')).favoriteVotes, 2);
  assert.deepEqual(game.history[0].modifiers, ['favorite']);
});

test('favorite votes are rejected without the modifier', () => {
  const { game, ids } = createGame();
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  assertGameError(() => game.voteFavorite(ids[0], realEntry(game).id, 0), 'noFavoriteRound');
});

test('reveal shows multiplied points', () => {
  const { game, ids } = createGame();
  game.setNextRound({ modifiers: ['double', 'truth'] }, 0);
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  game.vote(ids[0], realEntry(game).id, 0);
  game.vote(ids[1], ownEntry(game, ids[0]).id, 0);
  game.vote(ids[2], realEntry(game).id, 0);
  game.revealAll(0);
  const reveal = getStateFor(game, 'screen', null, 0).reveal;
  const real = reveal.items.find((i) => i.isReal);
  assert.deepEqual(real.voterPoints, [8, 8]);
  const annaEntry = reveal.items.find((i) => i.authors?.some((a) => a.name === 'Anna'));
  assert.equal(annaEntry.authors[0].points, 2);
});

test('next-round word preview is only sent to the host', () => {
  const { game, ids } = createGame();
  game.chooseNextWord('Drumlin', 0);
  game.setNextRound({ modifiers: ['double'] }, 0);
  for (const view of [getStateFor(game, 'screen', null, 0), getStateFor(game, 'player', ids[0], 0)]) {
    const json = JSON.stringify(view);
    assert.ok(!json.includes('Drumlin'));
    assert.ok(!json.includes('Hügel aus Gletschergeröll'));
    assert.ok(!json.includes('nextRound'));
  }
  const host = getStateFor(game, 'host', null, 0).host.nextRound;
  assert.equal(host.word.term, 'Drumlin');
  assert.deepEqual(host.modifiers, ['double']);
  assert.equal(host.availableTerms.length, WORDS.length);
});

test('preparation state survives serialisation', () => {
  const { game } = createGame();
  game.setNextRound({ modifiers: ['favorite'], wheel: true }, 0);
  game.chooseNextWord('Fiale', 0);
  const restored = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON())), { getWordlists: game.getWordlists });
  assert.deepEqual(restored.nextRound, { modifiers: ['favorite'], wheel: true, term: 'Fiale' });
  assert.equal(restored.settings.points.favorite, 2);
});
