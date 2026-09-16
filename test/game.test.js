import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game/Game.js';
import { canTransition, PHASES } from '../src/game/phases.js';
import { createGame, toModeration, ownEntry, realEntry, moderationDefinitionOf } from './helpers.js';

function assertGameError(fn, code) {
  assert.throws(fn, (error) => error.code === code, `expected error ${code}`);
}

test('phase transitions follow the state machine', () => {
  assert.ok(canTransition('LOBBY', 'WRITING'));
  assert.ok(canTransition('SCOREBOARD', 'WRITING'));
  assert.ok(canTransition('SCOREBOARD', 'GAME_OVER'));
  assert.ok(!canTransition('LOBBY', 'VOTING'));
  assert.ok(!canTransition('WRITING', 'VOTING'));
  assert.ok(!canTransition('VOTING', 'SCOREBOARD'));
  assert.ok(!canTransition('REVEAL', 'WRITING'));
});

test('complete game runs through all phases and ends', () => {
  const { game, ids } = createGame({ settings: { rounds: 2 } });
  game.startGame(0);
  for (let round = 1; round <= 2; round++) {
    assert.equal(game.phase, PHASES.WRITING);
    assert.equal(game.roundNumber, round);
    ids.forEach((id, i) => game.submitDefinition(id, `Antwort ${i} in Runde ${round}`, 10));
    assert.equal(game.phase, PHASES.MODERATION, 'auto moderation after all submitted');
    game.next(20);
    assert.equal(game.phase, PHASES.VOTING);
    for (const id of ids) game.vote(id, realEntry(game).id, 30);
    assert.equal(game.phase, PHASES.REVEAL);
    while (!game.revealDone()) game.next(40);
    game.next(50);
    assert.equal(game.phase, PHASES.SCOREBOARD);
    game.next(60);
  }
  assert.equal(game.phase, PHASES.GAME_OVER);
  for (const id of ids) assert.equal(game.players.get(id).score, 4);
  assert.equal(game.history.length, 2);
  assert.notEqual(game.history[0].term, game.history[1].term, 'no word twice');
});

test('own definition cannot be voted for', () => {
  const { game, ids } = createGame();
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  assertGameError(() => game.vote(ids[0], ownEntry(game, ids[0]).id, 0), 'ownDefinition');
});

test('vote can be changed until voting ends', () => {
  const { game, ids } = createGame({ settings: { autoRevealWhenAllVoted: false } });
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  game.vote(ids[0], ownEntry(game, ids[1]).id, 0);
  game.vote(ids[0], realEntry(game).id, 0);
  assert.equal(game.round.votes[ids[0]], realEntry(game).id);
});

test('writing timer: expiry auto-submits drafts and moves to moderation', () => {
  const { game, ids } = createGame({ settings: { writingSeconds: 30 } });
  game.startGame(0);
  game.saveDraft(ids[0], 'Halb fertige Idee', 5_000);
  game.saveDraft(ids[1], '  ', 5_000);
  assert.equal(game.onTimerExpired(29_000), false);
  assert.equal(game.onTimerExpired(30_000), true);
  assert.equal(game.phase, PHASES.MODERATION);
  const def = moderationDefinitionOf(game, ids[0]);
  assert.equal(def.text, 'Halb fertige Idee.');
  assert.equal(def.auto, true);
  assert.equal(moderationDefinitionOf(game, ids[1]), undefined);
});

test('manual timer mode: expiry only marks the timer and blocks input', () => {
  const { game, ids } = createGame({ settings: { writingSeconds: 10, autoAdvanceOnTimer: false } });
  game.startGame(0);
  game.onTimerExpired(10_000);
  assert.equal(game.phase, PHASES.WRITING);
  assert.equal(game.timer.expired, true);
  assertGameError(() => game.submitDefinition(ids[0], 'Zu spät', 11_000), 'timeUp');
});

test('pause, resume and +30 s keep the remaining time', () => {
  const { game } = createGame({ settings: { writingSeconds: 60 } });
  game.startGame(0);
  game.pauseTimer('host', 10_000);
  assert.equal(game.timerRemaining(99_000), 50_000);
  game.addTime(30, 99_000);
  game.resumeTimer(100_000);
  assert.equal(game.timer.endsAt, 180_000);
  assert.equal(game.onTimerExpired(120_000), false);
});

test('timer can be set, replaced and removed during a running phase', () => {
  const { game, ids } = createGame({ settings: { writingSeconds: 0, autoAdvanceOnTimer: false } });
  game.startGame(0);
  assert.equal(game.timer, null, 'started without limit');
  game.addTime(30, 1_000);
  assert.equal(game.timer.endsAt, 31_000, '+30 s starts a timer when none runs');
  game.setTimer(60, 5_000);
  assert.equal(game.timer.endsAt, 65_000);
  game.onTimerExpired(65_000);
  assert.equal(game.timer.expired, true);
  game.setTimer(20, 70_000);
  assert.equal(game.timer.expired, false, 'setting a timer reopens input');
  game.submitDefinition(ids[0], 'Nachgereicht', 71_000);
  game.pauseTimer('host', 72_000);
  game.setTimer(45, 73_000);
  assert.equal(game.timer.paused, true, 'manual pause is kept');
  assert.equal(game.timer.remainingMs, 45_000);
  game.setTimer(0, 74_000);
  assert.equal(game.timer, null, '0 removes the limit');
  game.endWriting(75_000);
  assert.throws(() => game.setTimer(30, 76_000), (e) => e.code === 'wrongPhase');
  game.startVoting(76_000);
  game.setTimer(30, 77_000);
  assert.equal(game.timer.endsAt, 107_000, 'works while voting is open');
});

test('timer cannot be set while entries are still being read aloud', () => {
  const { game, ids } = createGame({ settings: { readAloudMode: true } });
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  assert.throws(() => game.setTimer(30, 0), (e) => e.code === 'wrongPhase');
});

test('host disconnect pauses the timer, reconnect resumes it', () => {
  const { game } = createGame({ settings: { writingSeconds: 60 } });
  game.startGame(0);
  game.setHostConnected(false, 20_000);
  assert.equal(game.timer.paused, true);
  assert.equal(game.timer.pauseReason, 'hostDisconnected');
  game.setHostConnected(true, 50_000);
  assert.equal(game.timer.paused, false);
  assert.equal(game.timer.endsAt, 90_000);
});

test('manual pause is not lifted by host reconnect', () => {
  const { game } = createGame({ settings: { writingSeconds: 60 } });
  game.startGame(0);
  game.pauseTimer('host', 1_000);
  game.setHostConnected(false, 2_000);
  game.setHostConnected(true, 3_000);
  assert.equal(game.timer.paused, true);
});

test('players disconnected for over 30 s are not waited for', () => {
  const { game, ids } = createGame();
  game.startGame(0);
  game.setPlayerConnected(ids[2], false, 1_000);
  game.submitDefinition(ids[0], 'Eins', 2_000);
  game.submitDefinition(ids[1], 'Zwei', 2_000);
  assert.equal(game.phase, PHASES.WRITING, 'still waiting within grace period');
  assert.equal(game.tick(20_000), false);
  assert.equal(game.tick(31_001), true);
  assert.equal(game.phase, PHASES.MODERATION);
});

test('skipping a word draws a new one and discards answers', () => {
  const { game, ids } = createGame();
  game.startGame(0);
  const firstTerm = game.round.word.term;
  game.submitDefinition(ids[0], 'Eins', 1_000);
  game.skipWord(2_000);
  assert.equal(game.phase, PHASES.WRITING);
  assert.equal(game.roundNumber, 1);
  assert.notEqual(game.round.word.term, firstTerm);
  assert.equal(game.round.submissions.size, 0);
});

test('running out of words is reported', () => {
  const { game, ids } = createGame({ settings: { rounds: 10 } });
  game.startGame(0);
  for (let i = 0; i < 3; i++) game.skipWord(0);
  assertGameError(() => game.skipWord(0), 'noWordsLeft');
  assert.equal(game.wordlistInfo().unused, 0);
  assert.ok(ids.length);
});

test('read-aloud mode presents entries one by one before voting opens', () => {
  const { game, ids } = createGame({ settings: { readAloudMode: true, votingSeconds: 20 } });
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  assert.equal(game.round.presentedCount, 0);
  assert.equal(game.timer, null);
  assertGameError(() => game.vote(ids[0], realEntry(game).id, 0), 'votingNotOpen');
  game.next(0);
  game.next(0);
  assert.equal(game.round.presentedCount, 2);
  assert.equal(game.round.highlight, 2);
  game.present('prev', 0);
  assert.equal(game.round.presentedCount, 1);
  for (let i = 0; i < 3; i++) game.next(0);
  assert.equal(game.round.votingOpen, false);
  game.next(1_000);
  assert.equal(game.round.votingOpen, true);
  assert.equal(game.timer.endsAt, 21_000);
});

test('marked-correct answers leave the ballot and give a bonus', () => {
  const { game, ids } = createGame();
  toModeration(game, ids, ['Wegfall am Wortende', 'Zwei', 'Drei']);
  game.markCorrect(moderationDefinitionOf(game, ids[0]).id, true, 0);
  game.startVoting(0);
  assert.equal(ownEntry(game, ids[0]), undefined);
  assert.equal(game.round.ballot.length, 3);
  game.vote(ids[0], realEntry(game).id, 0);
  game.vote(ids[1], realEntry(game).id, 0);
  game.vote(ids[2], ownEntry(game, ids[1]).id, 0);
  game.revealAll(0);
  assert.equal(game.round.revealSteps.at(-1).type, 'bonus');
  game.goToScoreboard(0);
  assert.equal(game.players.get(ids[0]).score, 3 + 2);
  assert.equal(game.players.get(ids[1]).score, 2 + 1);
});

test('reveal order: fakes by ascending votes, real last', () => {
  const { game, ids } = createGame({ players: ['A1', 'B1', 'C1', 'D1'] });
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei', null]);
  game.startVoting(0);
  const [a, b, c, d] = ids;
  game.vote(a, ownEntry(game, b).id, 0);
  game.vote(c, ownEntry(game, b).id, 0);
  game.vote(b, ownEntry(game, a).id, 0);
  game.vote(d, realEntry(game).id, 0);
  const order = game.round.revealSteps.filter((s) => s.type === 'text').map((s) => s.ballotId);
  assert.deepEqual(order, [ownEntry(game, c).id, ownEntry(game, a).id, ownEntry(game, b).id]);
  assert.equal(game.round.revealSteps.at(-1).type, 'real');
  assert.equal(game.round.revealSteps.length, 3 * 3 + 1);
});

test('scores are applied only when leaving the reveal', () => {
  const { game, ids } = createGame();
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  for (const id of ids) game.vote(id, realEntry(game).id, 0);
  assert.equal(game.players.get(ids[0]).score, 0);
  game.revealAll(0);
  game.next(0);
  assert.equal(game.players.get(ids[0]).score, 2);
  assert.equal(game.lastScoreChanges[ids[0]].delta, 2);
});

test('joining: validation, lock, max players, kicked sessions, late join', () => {
  const { game, ids } = createGame({ settings: { maxPlayers: 4 } });
  assertGameError(() => game.addPlayer({ name: 'anna' }, 0), 'nameTaken');
  assertGameError(() => game.addPlayer({ name: 'X' }, 0), 'nameTooShort');
  assertGameError(() => game.addPlayer({ name: 'Doofi' }, 0), 'nameBlocked');
  assertGameError(() => game.addPlayer({ name: 'Team', members: 'x'.repeat(61) }, 0), 'membersTooLong');

  const kicked = game.players.get(ids[2]);
  game.removePlayer(ids[2], 0);
  assertGameError(() => game.addPlayer({ name: 'Neu', sessionId: kicked.sessionId }, 0), 'kicked');

  game.setLocked(true, 0);
  assertGameError(() => game.addPlayer({ name: 'Dora' }, 0), 'roomLocked');
  game.setLocked(false, 0);
  game.addPlayer({ name: 'Dora' }, 0);
  game.addPlayer({ name: 'Emil' }, 0);
  assertGameError(() => game.addPlayer({ name: 'Fritz' }, 0), 'roomFull');

  game.updateSettings({ maxPlayers: 10 }, 0);
  game.startGame(0);
  assertGameError(() => game.addPlayer({ name: 'Fritz' }, 0), 'gameRunning');
  game.updateSettings({ allowLateJoin: true }, 0);
  const late = game.addPlayer({ name: 'Fritz' }, 0);
  assert.equal(late.activeFromRound, 2);
  assert.equal(late.score, 0);
  assertGameError(() => game.submitDefinition(late.id, 'Hallo', 0), 'notParticipant');
});

test('in-game settings changes are restricted', () => {
  const { game } = createGame();
  game.startGame(0);
  game.updateSettings({ writingSeconds: 120, points: { correctVote: 9 }, wordlist: 'other' }, 0);
  assert.equal(game.settings.writingSeconds, 120);
  assert.equal(game.settings.points.correctVote, 2);
  assert.equal(game.settings.wordlist, 'test');
});

test('manual score correction', () => {
  const { game, ids } = createGame();
  game.adjustScore(ids[0], 3, 0);
  game.adjustScore(ids[0], -1, 0);
  assert.equal(game.players.get(ids[0]).score, 2);
  assertGameError(() => game.adjustScore(ids[0], 'x', 0), 'invalidDelta');
});

test('play again resets scores and prefers unplayed words', () => {
  const { game, ids } = createGame({ settings: { rounds: 1 } });
  game.startGame(0);
  const firstTerm = game.round.word.term;
  game.endGame(0);
  game.adjustScore(ids[0], 5, 0);
  game.playAgain(0);
  assert.equal(game.phase, PHASES.LOBBY);
  assert.equal(game.players.get(ids[0]).score, 0);
  for (let i = 0; i < 3; i++) {
    game.phase === PHASES.LOBBY ? game.startGame(0) : game.skipWord(0);
    assert.notEqual(game.round.word.term, firstTerm);
  }
});

test('fewer than two player definitions produces a warning', () => {
  const { game, ids } = createGame();
  toModeration(game, ids, ['Eins', null, null]);
  assert.equal(game.moderationWarning(), 'fewDefinitions');
  game.startVoting(0);
  assert.equal(game.round.ballot.length, 2);
});

test('merge and unmerge', () => {
  const { game, ids } = createGame();
  toModeration(game, ids, ['Eins', 'Eins!', 'Drei']);
  const [d0, d1] = [moderationDefinitionOf(game, ids[0]), moderationDefinitionOf(game, ids[1])];
  game.mergeDefinitions([d0.id, d1.id], 0);
  assert.equal(game.effectiveDefinitions().filter((d) => !d.isReal).length, 2);
  game.unmergeDefinition(d0.id, 0);
  assert.equal(game.effectiveDefinitions().filter((d) => !d.isReal).length, 3);
});

test('serialisation round trip keeps the game and pauses timers', () => {
  const { game, ids } = createGame({ settings: { writingSeconds: 60 } });
  game.startGame(0);
  game.submitDefinition(ids[0], 'Eins', 1_000);
  const data = JSON.parse(JSON.stringify({ ...game.toJSON(), savedAt: 10_000 }));
  const restored = Game.fromJSON(data, { getWordlists: game.getWordlists, now: 20_000 });
  assert.equal(restored.phase, PHASES.WRITING);
  assert.equal(restored.round.submissions.get(ids[0]).text, 'Eins');
  assert.equal(restored.timer.paused, true);
  assert.equal(restored.timer.remainingMs, 50_000);
  assert.equal(restored.players.get(ids[0]).connected, false);
  restored.setHostConnected(true, 30_000);
  assert.equal(restored.timer.endsAt, 80_000);
});

test('removing a player during voting drops their vote and authorship', () => {
  const { game, ids } = createGame({ settings: { autoRevealWhenAllVoted: false } });
  toModeration(game, ids, ['Eins', 'Zwei', 'Drei']);
  game.startVoting(0);
  game.vote(ids[0], realEntry(game).id, 0);
  game.removePlayer(ids[0], 0);
  assert.equal(game.round.votes[ids[0]], undefined);
  game.startReveal(0);
  game.revealAll(0);
  game.goToScoreboard(0);
  assert.equal(game.players.size, 2);
});
