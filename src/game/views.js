import { PHASES } from './phases.js';
import { DISCONNECT_GRACE_MS, rankPlayers } from './Game.js';
import { computeStats } from './stats.js';

const { LOBBY, WRITING, MODERATION, VOTING, REVEAL, SCOREBOARD, GAME_OVER } = PHASES;

/**
 * Builds the state a single client is allowed to see.
 * - 'player' and 'screen' never learn authors or which entry is real before the
 *   matching reveal step.
 * - 'host' gets the same public view plus a `host` object with secrets; the host UI
 *   only renders those in the (blurred) control panel.
 * @param {import('./Game.js').Game} game
 * @param {'host'|'screen'|'player'} role
 * @param {string|null} playerId
 * @param {number} now
 */
export function getStateFor(game, role, playerId, now) {
  const round = game.round;
  const phase = game.phase;
  const showMembers = role === 'host' || phase === LOBBY || phase === GAME_OVER;

  const view = {
    role,
    code: game.code,
    phase,
    serverNow: now,
    version: game.version,
    locked: game.locked,
    hostConnected: game.hostConnected,
    roundNumber: game.roundNumber,
    totalRounds: game.settings.rounds,
    isLastRound: game.isLastRound(),
    settings: {
      maxDefinitionLength: game.settings.maxDefinitionLength,
      showWordClass: game.settings.showWordClass,
      standardizeAnswers: game.settings.standardizeAnswers,
      readAloudMode: game.settings.readAloudMode,
      allowLateJoin: game.settings.allowLateJoin,
      points: game.settings.points,
    },
    timer: publicTimer(game, now),
    word: null,
    players: publicPlayers(game, now, showMembers),
    progress: null,
    ballot: null,
    highlight: null,
    modifiers: null,
    reveal: null,
    ranking: null,
    stats: null,
  };

  if (round && phase !== LOBBY && phase !== GAME_OVER) {
    view.word = publicWord(game);
    view.modifiers = { list: round.modifiers, wheel: round.wheel, roundNumber: round.number };
  }

  if (phase === WRITING) {
    const waiting = game.roundParticipants();
    view.progress = { done: waiting.filter((p) => round.submissions.has(p.id)).length, total: waiting.length };
  }

  if (phase === VOTING) {
    const shown = round.ballot.slice(0, round.presentedCount);
    view.ballot = {
      entries: shown.map((entry) => ({ id: entry.id, number: entry.number, text: entry.text })),
      total: round.ballot.length,
      presentedCount: round.presentedCount,
      votingOpen: round.votingOpen,
      favoriteEnabled: round.modifiers.includes('favorite'),
    };
    view.highlight = round.highlight;
    const participants = game.roundParticipants();
    view.progress = {
      done: participants.filter((p) => round.votes[p.id]).length,
      total: participants.length,
    };
  }

  if (phase === REVEAL) {
    view.reveal = publicReveal(game);
  }

  if (phase === SCOREBOARD || phase === GAME_OVER || (phase === REVEAL && role === 'host')) {
    view.ranking = publicRanking(game);
  }

  if (phase === GAME_OVER) {
    view.stats = computeStats(game);
  }

  if (role === 'player') {
    view.you = playerView(game, playerId, now);
  }

  if (role === 'host') {
    view.host = hostView(game, now);
  }

  return view;
}

function publicTimer(game, now) {
  const timer = game.timer;
  if (!timer) return null;
  return {
    endsAt: timer.endsAt,
    remainingMs: timer.paused ? timer.remainingMs : Math.max(0, timer.endsAt - now),
    durationMs: timer.durationMs,
    paused: timer.paused,
    pauseReason: timer.pauseReason,
    expired: timer.expired,
  };
}

function publicWord(game) {
  const word = game.round.word;
  const result = { term: word.term, category: word.category };
  if (game.settings.showWordClass) {
    result.article = word.article;
    result.wordClass = word.wordClass;
  }
  return result;
}

function publicPlayers(game, now, showMembers) {
  const round = game.round;
  return [...game.players.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((player) => {
      const active = !round || player.activeFromRound <= round.number || game.phase === LOBBY;
      const entry = {
        id: player.id,
        name: player.name,
        score: player.score,
        connected: player.connected,
        away: !player.connected && now - (player.disconnectedAt ?? 0) >= DISCONNECT_GRACE_MS,
        active,
        joinedAt: player.joinedAt,
      };
      if (showMembers && player.members) entry.members = player.members;
      if (game.phase === WRITING && active) entry.submitted = round.submissions.has(player.id);
      if (game.phase === VOTING && active) entry.voted = Boolean(round.votes[player.id]);
      return entry;
    });
}

function publicRanking(game) {
  const applied = game.round?.scoresApplied;
  return rankPlayers([...game.players.values()]).map(({ player, rank }) => {
    const change = applied ? game.lastScoreChanges[player.id] : null;
    return {
      id: player.id,
      name: player.name,
      members: game.phase === GAME_OVER ? player.members || undefined : undefined,
      score: player.score,
      rank,
      delta: change?.delta ?? 0,
      previousRank: change?.previousRank ?? null,
    };
  });
}

/** Only what the current reveal step has uncovered. */
function publicReveal(game) {
  const round = game.round;
  const nameOf = (id) => game.players.get(id)?.name ?? '?';
  const items = new Map();
  let realShown = false;
  let bonusShown = false;
  let favoriteShown = false;
  let current = null;
  const result = round.result;
  round.revealSteps.slice(0, round.revealStep).forEach((step, index) => {
    if (step.type === 'bonus' || step.type === 'favorite') {
      if (step.type === 'bonus') bonusShown = true;
      else favoriteShown = true;
      current = { type: step.type };
      return;
    }
    const entry = round.ballot.find((e) => e.id === step.ballotId);
    let item = items.get(entry.id);
    if (!item) {
      item = { id: entry.id, number: entry.number, text: entry.text, order: items.size };
      items.set(entry.id, item);
    }
    const voters = result.votesByDefinition[entry.id];
    if (step.type === 'text') {
      item.isReal = false;
    } else if (step.type === 'voters') {
      item.voters = voters.map(nameOf);
    } else if (step.type === 'authors') {
      item.authors = entry.authorIds.map((id) => ({
        name: nameOf(id),
        points: result.entryPoints[entry.id]?.[id] ?? 0,
      }));
    } else if (step.type === 'real') {
      realShown = true;
      item.isReal = true;
      item.voters = voters.map(nameOf);
      item.voterPoints = voters.map((id) => result.players[id]?.correctPoints ?? 0);
    }
    if (index === round.revealStep - 1) current = { type: step.type, id: entry.id };
  });
  const reveal = {
    step: round.revealStep,
    totalSteps: round.revealSteps.length,
    done: round.revealStep >= round.revealSteps.length,
    current,
    items: [...items.values()],
    realShown,
    bonus: null,
    favorite: null,
  };
  if (bonusShown) {
    reveal.bonus = game
      .effectiveDefinitions()
      .filter((d) => !d.isReal && d.markedCorrect && !d.deleted)
      .map((d) => ({
        text: d.text,
        authors: d.authorIds.map(nameOf),
        points: Math.max(0, ...d.authorIds.map((id) => result.entryPoints[d.id]?.[id] ?? 0)),
      }));
  }
  if (favoriteShown && result.favorite) {
    reveal.favorite = {
      votes: result.favorite.count,
      winners: result.favorite.winnerIds.map((id) => {
        const entry = round.ballot.find((e) => e.id === id);
        return {
          number: entry.number,
          text: entry.text,
          authors: entry.authorIds.map((authorId) => ({
            name: nameOf(authorId),
            points: result.players[authorId]?.favoritePoints ?? 0,
          })),
        };
      }),
    };
  }
  return reveal;
}

function playerView(game, playerId, now) {
  const player = game.players.get(playerId);
  if (!player) return null;
  const round = game.round;
  const participant = game.isParticipant(playerId);
  const ranking = rankPlayers([...game.players.values()]);
  const you = {
    id: player.id,
    name: player.name,
    members: player.members,
    score: player.score,
    rank: ranking.find((r) => r.player.id === playerId)?.rank ?? null,
    playerCount: game.players.size,
    participant: game.phase === LOBBY || participant,
    waitingForNextRound: game.isInGame() && !participant,
  };
  if (!round || !participant) return you;
  if (game.phase !== SCOREBOARD) you.catchup = round.catchupIds.includes(playerId);

  if (game.phase === WRITING) {
    const submission = round.submissions.get(playerId);
    you.submitted = Boolean(submission);
    you.submission = submission?.text ?? null;
    you.draft = round.drafts.get(playerId) ?? null;
  }
  if (game.phase === MODERATION) {
    you.submitted = round.definitions.some((d) => !d.isReal && d.authorIds.includes(playerId));
  }
  if (game.phase === VOTING) {
    const own = round.ballot.find((entry) => entry.authorIds.includes(playerId));
    you.ownEntryId = own && own.number <= round.presentedCount ? own.id : null;
    you.hasEntry = Boolean(own);
    you.vote = round.votes[playerId] ?? null;
    you.favorite = round.favorites[playerId] ?? null;
    you.canVote = game.canVote(playerId);
  }
  if (game.phase === REVEAL && game.revealDone()) {
    const result = round.result.players[playerId];
    if (result) {
      you.roundResult = {
        total: result.total,
        votedReal: result.votedReal,
        voted: Boolean(result.votedFor),
        fooledCount: result.fooledCount,
        markedCorrect: result.markedCorrect,
        hadEntry: round.ballot.some((entry) => entry.authorIds.includes(playerId)),
        correctPoints: result.correctPoints,
        fooledPoints: result.fooledPoints,
        markedPoints: result.markedPoints,
        favoritePoints: result.favoritePoints,
      };
    }
  }
  if (game.phase === SCOREBOARD || game.phase === GAME_OVER) {
    you.delta = game.round?.scoresApplied ? game.lastScoreChanges[playerId]?.delta ?? 0 : 0;
  }
  return you;
}

function hostView(game, now) {
  const round = game.round;
  const nameOf = (id) => game.players.get(id)?.name ?? '?';
  const host = {
    screenToken: game.screenToken,
    settings: game.settings,
    wordlist: game.wordlistInfo(),
    players: [...game.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      members: p.members,
      score: p.score,
      connected: p.connected,
      activeFromRound: p.activeFromRound,
    })),
    realDefinition: null,
    definitions: null,
    moderationWarning: null,
    ballot: null,
    revealNext: null,
    nextRound: null,
  };
  if (game.canPrepareRound()) {
    const candidate = game.nextCandidate();
    host.nextRound = {
      modifiers: game.nextRound.modifiers,
      wheel: game.nextRound.wheel,
      word: candidate && {
        term: candidate.term,
        article: candidate.article ?? null,
        category: candidate.category ?? null,
        definition: candidate.definition,
      },
      availableTerms: game
        .availableWords()
        .map((word) => word.term)
        .sort((a, b) => a.localeCompare(b, 'de')),
      roundNumber: game.roundNumber + 1,
    };
  }
  if (!round) return host;
  host.realDefinition = round.word.definition;
  host.term = round.word.term;

  if (game.phase === WRITING) {
    host.submissions = [...round.submissions].map(([id, s]) => ({ author: nameOf(id), text: s.text }));
  }
  if (game.phase === MODERATION) {
    host.definitions = round.definitions
      .filter((d) => !d.isReal)
      .map((d) => ({
        id: d.id,
        text: d.text,
        originalText: d.originalText,
        authors: d.authorIds.map(nameOf),
        deleted: d.deleted,
        markedCorrect: d.markedCorrect,
        mergedInto: d.mergedInto,
        auto: Boolean(d.auto),
      }));
    host.moderationWarning = game.moderationWarning();
    const participants = game.roundParticipants();
    host.missing = participants.filter((p) => !round.submissions.has(p.id)).map((p) => p.name);
  }
  if (game.phase === VOTING || game.phase === REVEAL) {
    host.ballot = round.ballot.map((entry) => ({
      id: entry.id,
      number: entry.number,
      text: entry.text,
      isReal: entry.isReal,
      authors: entry.authorIds.map(nameOf),
      voters: Object.entries(round.votes)
        .filter(([, ballotId]) => ballotId === entry.id)
        .map(([voterId]) => nameOf(voterId)),
      favorites: Object.values(round.favorites).filter((ballotId) => ballotId === entry.id).length,
    }));
  }
  if (game.phase === REVEAL) {
    const step = round.revealSteps[round.revealStep];
    host.revealNext = step ? step.type : null;
  }
  return host;
}
