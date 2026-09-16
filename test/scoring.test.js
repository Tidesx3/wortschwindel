import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRound, DEFAULT_POINTS } from '../src/game/scoring.js';
import { createGame, toModeration, ownEntry, realEntry, moderationDefinitionOf } from './helpers.js';

const players = ['a', 'b', 'c', 'd'];

test('real vote gives +2, each fooled vote gives +1 to the author', () => {
  const definitions = [
    { id: 'real', isReal: true, authorIds: [] },
    { id: 'fa', isReal: false, authorIds: ['a'] },
    { id: 'fb', isReal: false, authorIds: ['b'] },
  ];
  const votes = { a: 'real', b: 'fa', c: 'fa', d: 'real' };
  const { players: result, votesByDefinition } = scoreRound({ definitions, votes, playerIds: players });
  assert.equal(result.a.total, 2 + 2);
  assert.equal(result.a.fooledCount, 2);
  assert.equal(result.b.total, 0);
  assert.equal(result.c.total, 0);
  assert.equal(result.d.total, 2);
  assert.deepEqual(votesByDefinition.fa, ['b', 'c']);
});

test('nobody votes: everyone gets zero', () => {
  const definitions = [
    { id: 'real', isReal: true, authorIds: [] },
    { id: 'fa', isReal: false, authorIds: ['a'] },
  ];
  const { players: result } = scoreRound({ definitions, votes: {}, playerIds: players });
  for (const id of players) assert.equal(result[id].total, 0);
});

test('votes for own definition are ignored', () => {
  const definitions = [
    { id: 'real', isReal: true, authorIds: [] },
    { id: 'fa', isReal: false, authorIds: ['a'] },
  ];
  const { players: result } = scoreRound({ definitions, votes: { a: 'fa' }, playerIds: players });
  assert.equal(result.a.total, 0);
  assert.equal(result.a.fooledCount, 0);
});

test('merged duplicate: every author gets full points per vote', () => {
  const definitions = [
    { id: 'real', isReal: true, authorIds: [] },
    { id: 'fab', isReal: false, authorIds: ['a', 'b'] },
  ];
  const votes = { c: 'fab', d: 'fab', a: 'real', b: 'real' };
  const { players: result } = scoreRound({ definitions, votes, playerIds: players });
  assert.equal(result.a.total, 2 + 2);
  assert.equal(result.b.total, 2 + 2);
  assert.equal(result.c.total, 0);
});

test('marked-correct answers give the bonus and cannot receive votes', () => {
  const definitions = [
    { id: 'real', isReal: true, authorIds: [] },
    { id: 'fa', isReal: false, authorIds: ['a'], markedCorrect: true },
    { id: 'fb', isReal: false, authorIds: ['b'], deleted: true },
  ];
  const votes = { c: 'fa', d: 'fb', a: 'real' };
  const { players: result, votesByDefinition } = scoreRound({ definitions, votes, playerIds: players });
  assert.equal(result.a.total, DEFAULT_POINTS.markedCorrect + DEFAULT_POINTS.correctVote);
  assert.equal(result.a.markedCorrect, true);
  assert.equal(result.b.total, 0);
  assert.equal(result.c.total, 0);
  assert.equal(result.d.total, 0);
  assert.equal(votesByDefinition.fa, undefined);
  assert.equal(votesByDefinition.fb, undefined);
});

test('custom point values are used', () => {
  const definitions = [
    { id: 'real', isReal: true, authorIds: [] },
    { id: 'fa', isReal: false, authorIds: ['a'] },
  ];
  const points = { correctVote: 5, perFooled: 3, markedCorrect: 0 };
  const { players: result } = scoreRound({ definitions, votes: { b: 'real', c: 'fa' }, playerIds: players, points });
  assert.equal(result.b.total, 5);
  assert.equal(result.a.total, 3);
});

test('full game round: deleted answer author still votes, merged authors share votes', () => {
  const { game, ids } = createGame({ players: ['Anna', 'Ben', 'Chris', 'Dora'] });
  const [anna, ben, chris, dora] = ids;
  toModeration(game, ids, ['Ein Musikinstrument', 'ein musikinstrument!', 'Quatsch', 'Eine Pflanze']);
  const annaDef = moderationDefinitionOf(game, anna);
  const benDef = moderationDefinitionOf(game, ben);
  game.mergeDefinitions([annaDef.id, benDef.id], 3_000);
  game.setDefinitionDeleted(moderationDefinitionOf(game, chris).id, true, 3_000);
  game.startVoting(3_000);

  const merged = ownEntry(game, anna);
  assert.deepEqual(merged.authorIds.sort(), [anna, ben].sort());
  assert.equal(ownEntry(game, chris), undefined, 'deleted answer is not on the ballot');
  assert.equal(game.round.ballot.length, 3);

  game.vote(chris, merged.id, 4_000);
  game.vote(dora, merged.id, 4_000);
  game.vote(anna, realEntry(game).id, 4_000);
  game.vote(ben, ownEntry(game, dora).id, 4_000);
  assert.equal(game.phase, 'REVEAL', 'auto reveal when everyone voted');
  game.revealAll(5_000);
  game.goToScoreboard(5_000);

  const score = (id) => game.players.get(id).score;
  assert.equal(score(anna), 2 + 2);
  assert.equal(score(ben), 2);
  assert.equal(score(chris), 0);
  assert.equal(score(dora), 1);
});
