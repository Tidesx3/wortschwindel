import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStateFor } from '../src/game/views.js';
import { createGame, toModeration, ownEntry, realEntry, moderationDefinitionOf } from './helpers.js';

const SECRET_KEYS = ['authorIds', 'authors', 'isReal', 'sourceId', 'voters', 'realDefinition', 'definitions', 'submission'];

function assertNoSecrets(view, game, label, { allowOwnSubmission = false, realTextVisible = false } = {}) {
  const json = JSON.stringify(view);
  for (const key of SECRET_KEYS) {
    if (key === 'submission' && allowOwnSubmission) continue;
    assert.ok(!json.includes(`"${key}"`), `${label}: must not contain "${key}"`);
  }
  if (game.round && !realTextVisible) {
    assert.ok(!json.includes(game.round.word.definition), `${label}: real definition text leaked`);
  }
  assert.ok(!json.includes(game.hostToken), `${label}: host token leaked`);
}

function allClientViews(game, ids, now = 0) {
  return [
    ['screen', getStateFor(game, 'screen', null, now)],
    ...ids.map((id) => [`player ${id}`, getStateFor(game, 'player', id, now)]),
  ];
}

test('no secrets in player/screen views before the reveal', () => {
  const { game, ids } = createGame({ settings: { readAloudMode: true } });
  const check = (phase) => {
    for (const [label, view] of allClientViews(game, ids)) {
      const opts = { allowOwnSubmission: label.startsWith('player'), realTextVisible: phase === 'VOTING open' };
      assertNoSecrets(view, game, `${phase} ${label}`, opts);
    }
  };
  check('LOBBY');
  game.startGame(0);
  game.submitDefinition(ids[0], 'Eine Pflanze', 0);
  check('WRITING');
  game.endWriting(0);
  check('MODERATION');
  const screenModeration = getStateFor(game, 'screen', null, 0);
  assert.equal(screenModeration.ballot, null);
  game.startVoting(0);
  check('VOTING presenting');
  game.present('all', 0);
  check('VOTING open');
  const playerView = getStateFor(game, 'player', ids[1], 0);
  assert.deepEqual(Object.keys(playerView.ballot.entries[0]).sort(), ['id', 'number', 'text']);
});

test('ballot ids are not correlated with moderation ids', () => {
  const { game, ids } = createGame();
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  const moderationIds = game.round.definitions.map((d) => d.id);
  game.startVoting(0);
  for (const entry of game.round.ballot) assert.ok(!moderationIds.includes(entry.id));
});

test('ballot order and numbers are identical for all clients', () => {
  const { game, ids } = createGame();
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  const orders = allClientViews(game, ids).map(([, v]) => v.ballot.entries.map((e) => `${e.number}:${e.id}`).join(','));
  assert.equal(new Set(orders).size, 1);
});

test('player sees only their own entry marked', () => {
  const { game, ids } = createGame();
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  const view = getStateFor(game, 'player', ids[0], 0);
  assert.equal(view.you.ownEntryId, ownEntry(game, ids[0]).id);
  assert.equal(view.you.canVote, true);
});

test('read-aloud mode: unrevealed entries are not sent', () => {
  const { game, ids } = createGame({ settings: { readAloudMode: true } });
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  game.next(0);
  const view = getStateFor(game, 'player', ids[0], 0);
  assert.equal(view.ballot.entries.length, 1);
  assert.equal(view.ballot.total, 4);
  assert.equal(view.ballot.votingOpen, false);
});

test('reveal uncovers information step by step', () => {
  const { game, ids } = createGame();
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  game.vote(ids[0], ownEntry(game, ids[1]).id, 0);
  game.vote(ids[1], realEntry(game).id, 0);
  game.vote(ids[2], realEntry(game).id, 0);
  assert.equal(game.phase, 'REVEAL');

  let view = getStateFor(game, 'screen', null, 0);
  assert.equal(view.reveal.items.length, 0);
  assertNoSecrets(view, game, 'reveal step 0', { realTextVisible: true });

  game.revealNext(0);
  view = getStateFor(game, 'screen', null, 0);
  assert.equal(view.reveal.items.length, 1);
  assert.equal(view.reveal.items[0].isReal, false);
  assert.equal(view.reveal.items[0].voters, undefined);
  assert.equal(view.reveal.items[0].authors, undefined);

  game.revealNext(0);
  view = getStateFor(game, 'screen', null, 0);
  assert.ok(Array.isArray(view.reveal.items[0].voters));
  assert.equal(view.reveal.items[0].authors, undefined);

  game.revealNext(0);
  view = getStateFor(game, 'screen', null, 0);
  assert.equal(view.reveal.items[0].authors.length, 1);

  // Player result only after the reveal is complete.
  assert.equal(getStateFor(game, 'player', ids[1], 0).you.roundResult, undefined);
  game.revealAll(0);
  view = getStateFor(game, 'screen', null, 0);
  const real = view.reveal.items.find((i) => i.isReal);
  assert.equal(real.text, game.round.word.definition);
  assert.equal(real.voters.length, 2);
  const result = getStateFor(game, 'player', ids[1], 0).you.roundResult;
  assert.deepEqual(result, {
    total: 3,
    votedReal: true,
    voted: true,
    fooledCount: 1,
    markedCorrect: false,
    hadEntry: true,
    correctPoints: 2,
    fooledPoints: 1,
    markedPoints: 0,
    favoritePoints: 0,
  });
});

test('host view contains moderation data, screen view does not', () => {
  const { game, ids } = createGame();
  toModeration(game, ids, ['eins', 'Zwei', 'Drei']);
  const host = getStateFor(game, 'host', null, 0);
  assert.equal(host.host.definitions.length, 3);
  assert.equal(host.host.realDefinition, game.round.word.definition);
  assert.ok(host.host.definitions.some((d) => d.text === 'Eins.' && d.authors[0] === 'Anna'));
  assert.equal(getStateFor(game, 'screen', null, 0).host, undefined);
  assert.ok(moderationDefinitionOf(game, ids[0]));
});

test('members are shown only in lobby and at the end (except to the host)', () => {
  const { game } = createGame({ players: [] });
  game.addPlayer({ name: 'Team Blau', members: 'Anna, Ben' }, 0);
  const lobby = getStateFor(game, 'screen', null, 0);
  assert.equal(lobby.players[0].members, 'Anna, Ben');
  game.startGame(0);
  assert.equal(getStateFor(game, 'screen', null, 0).players[0].members, undefined);
  assert.equal(getStateFor(game, 'host', null, 0).players[0].members, 'Anna, Ben');
  game.endGame(0);
  assert.equal(getStateFor(game, 'screen', null, 0).players[0].members, 'Anna, Ben');
});

test('game over view contains stats', () => {
  const { game, ids } = createGame({ settings: { rounds: 1 } });
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  game.vote(ids[0], ownEntry(game, ids[1]).id, 0);
  game.vote(ids[1], realEntry(game).id, 0);
  game.vote(ids[2], ownEntry(game, ids[1]).id, 0);
  game.revealAll(0);
  game.next(0);
  game.next(0);
  const view = getStateFor(game, 'screen', null, 0);
  assert.equal(view.phase, 'GAME_OVER');
  assert.deepEqual(view.stats.bestBluffer, { names: ['Ben'], count: 2 });
  assert.deepEqual(view.stats.dictionaryPro, { names: ['Ben'], count: 1 });
  assert.equal(view.stats.mostConvincing.text, 'Zwei.');
  assert.equal(view.ranking[0].name, 'Ben');
});
