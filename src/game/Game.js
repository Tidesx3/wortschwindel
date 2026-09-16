import { GameError, PHASES, assertTransition } from './phases.js';
import { DEFAULT_SETTINGS, mergeSettings } from './settings.js';
import { normalizeDefinition, cleanText } from './normalize.js';
import { validateMembers, validateName } from './names.js';
import { filterWords, pickWord } from './wordlists.js';
import { isVotable, scoreRound } from './scoring.js';
import { randomId, shuffle, uuid } from './random.js';

export const DISCONNECT_GRACE_MS = 30_000;
export const MAX_DRAFT_LENGTH = 400;

const { LOBBY, WRITING, MODERATION, VOTING, REVEAL, SCOREBOARD, GAME_OVER } = PHASES;

function fail(code) {
  throw new GameError(code);
}

/**
 * Complete state and rules of one room. No networking, no real timers:
 * every time-dependent method takes `now` (ms). The caller schedules
 * `onTimerExpired(now)` at `timer.endsAt` and calls `tick(now)` periodically.
 */
export class Game {
  /**
   * @param {object} options
   * @param {string} options.code
   * @param {string} options.hostToken
   * @param {string} [options.screenToken]
   * @param {object} [options.settings]
   * @param {() => Record<string, {title: string, words: object[]}>} [options.getWordlists]
   * @param {string[]} [options.blockedWords]
   * @param {() => number} [options.random]
   * @param {number} [options.now]
   */
  constructor({ code, hostToken, screenToken, settings, getWordlists, blockedWords, random, now = Date.now() }) {
    this.code = code;
    this.hostToken = hostToken;
    this.screenToken = screenToken ?? randomId(9);
    this.settings = mergeSettings(structuredClone(DEFAULT_SETTINGS), settings ?? {});
    this.getWordlists = getWordlists ?? (() => ({}));
    this.blockedWords = blockedWords ?? [];
    this.random = random ?? Math.random;

    this.createdAt = now;
    this.lastActivity = now;
    this.phase = LOBBY;
    this.locked = false;
    /** @type {Map<string, object>} */
    this.players = new Map();
    this.kickedSessions = new Set();
    this.customWordlist = null;
    this.hostConnected = false;
    this.hostEverConnected = false;
    this.roundNumber = 0;
    this.round = null;
    this.timer = null;
    this.usedTerms = new Set();
    this.playedTerms = new Set();
    this.history = [];
    this.lastScoreChanges = {};
    this.version = 0;
  }

  // ---------------------------------------------------------------- helpers

  touch(now) {
    this.lastActivity = now;
    this.version++;
  }

  getPlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) fail('playerNotFound');
    return player;
  }

  findPlayerBySession(sessionId) {
    if (typeof sessionId !== 'string') return null;
    for (const player of this.players.values()) {
      if (player.sessionId === sessionId) return player;
    }
    return null;
  }

  isInGame() {
    return this.phase !== LOBBY && this.phase !== GAME_OVER;
  }

  /** Players taking part in the current round (late joiners wait for the next one). */
  roundParticipants() {
    if (!this.round) return [];
    return [...this.players.values()].filter((player) => player.activeFromRound <= this.round.number);
  }

  isParticipant(playerId) {
    const player = this.players.get(playerId);
    return Boolean(player && this.round && player.activeFromRound <= this.round.number);
  }

  /** Participants we still wait for: connected, or disconnected for less than the grace period. */
  waitingParticipants(now) {
    return this.roundParticipants().filter(
      (player) => player.connected || now - (player.disconnectedAt ?? 0) < DISCONNECT_GRACE_MS,
    );
  }

  wordPool() {
    const base = this.customWordlist ?? this.getWordlists()[this.settings.wordlist];
    if (!base) return [];
    return filterWords(base.words, {
      categories: this.settings.categories,
      difficulties: this.settings.difficulties,
    });
  }

  wordlistInfo() {
    const base = this.customWordlist ?? this.getWordlists()[this.settings.wordlist];
    const pool = this.wordPool();
    const unused = pool.filter((word) => !this.usedTerms.has(word.term)).length;
    const categories = base ? [...new Set(base.words.map((w) => w.category).filter(Boolean))].sort() : [];
    return {
      title: base?.title ?? null,
      custom: Boolean(this.customWordlist),
      total: base?.words.length ?? 0,
      matching: pool.length,
      unused,
      categories,
    };
  }

  // ---------------------------------------------------------------- timer

  startTimer(seconds, now) {
    this.timer = seconds > 0
      ? { durationMs: seconds * 1000, endsAt: now + seconds * 1000, remainingMs: null, paused: false, pauseReason: null, expired: false }
      : null;
    // A running timer must not start while the host is away.
    if (this.timer && !this.hostConnected && this.hostEverConnected) this.pauseTimer('hostDisconnected', now);
  }

  timerRemaining(now) {
    if (!this.timer) return null;
    if (this.timer.paused) return this.timer.remainingMs;
    return Math.max(0, this.timer.endsAt - now);
  }

  /**
   * Host sets (or replaces) the countdown during a running phase; 0 removes the limit.
   * Also restarts an expired timer, reopening input.
   */
  setTimer(seconds, now) {
    const timedPhase = this.phase === WRITING || (this.phase === VOTING && this.round.votingOpen);
    if (!timedPhase) fail('wrongPhase');
    const value = Math.round(Number(seconds));
    if (!Number.isFinite(value) || value < 0 || value > 900) fail('invalidPayload');
    const wasPaused = this.timer?.paused && this.timer.pauseReason === 'host';
    this.startTimer(value, now);
    if (wasPaused && this.timer) this.pauseTimer('host', now);
    this.touch(now);
  }

  addTime(seconds, now) {
    if (!this.timer) return this.setTimer(seconds, now);
    const ms = seconds * 1000;
    if (this.timer.paused) {
      this.timer.remainingMs += ms;
    } else {
      this.timer.endsAt = Math.max(this.timer.endsAt, now) + ms;
    }
    this.timer.durationMs += ms;
    this.timer.expired = false;
    this.touch(now);
  }

  pauseTimer(reason, now) {
    if (!this.timer || this.timer.paused || this.timer.expired) return false;
    this.timer.remainingMs = Math.max(0, this.timer.endsAt - now);
    this.timer.endsAt = null;
    this.timer.paused = true;
    this.timer.pauseReason = reason;
    this.touch(now);
    return true;
  }

  resumeTimer(now, onlyReason = null) {
    if (!this.timer || !this.timer.paused) return false;
    if (onlyReason && this.timer.pauseReason !== onlyReason) return false;
    this.timer.endsAt = now + this.timer.remainingMs;
    this.timer.remainingMs = null;
    this.timer.paused = false;
    this.timer.pauseReason = null;
    this.touch(now);
    return true;
  }

  /** Host: "end now" – behaves like the timer running out, but always advances. */
  endPhaseNow(now) {
    if (this.phase === WRITING) return this.endWriting(now);
    if (this.phase === VOTING) {
      if (!this.round.votingOpen) fail('votingNotOpen');
      return this.startReveal(now);
    }
    fail('wrongPhase');
  }

  /** Called by the scheduler when `timer.endsAt` is reached. Returns true if state changed. */
  onTimerExpired(now) {
    const timer = this.timer;
    if (!timer || timer.paused || timer.expired || timer.endsAt > now) return false;
    if (this.phase === WRITING) {
      if (this.settings.autoAdvanceOnTimer) {
        this.endWriting(now);
      } else {
        timer.expired = true;
        this.touch(now);
      }
      return true;
    }
    if (this.phase === VOTING) {
      if (this.settings.autoAdvanceOnTimer) {
        this.startReveal(now);
      } else {
        timer.expired = true;
        this.touch(now);
      }
      return true;
    }
    this.timer = null;
    return true;
  }

  /** Periodic check for conditions that depend only on time (e.g. disconnect grace). */
  tick(now) {
    if (this.timer && !this.timer.paused && !this.timer.expired && this.timer.endsAt <= now) {
      return this.onTimerExpired(now);
    }
    return this.checkAutoAdvance(now);
  }

  // ---------------------------------------------------------------- host connection

  setHostConnected(connected, now) {
    if (connected === this.hostConnected) return false;
    this.hostConnected = connected;
    if (connected) {
      this.hostEverConnected = true;
      this.resumeTimer(now, 'hostDisconnected');
    } else {
      this.pauseTimer('hostDisconnected', now);
    }
    this.touch(now);
    return true;
  }

  // ---------------------------------------------------------------- players

  addPlayer({ name, members, sessionId }, now) {
    if (sessionId && this.kickedSessions.has(sessionId)) fail('kicked');
    if (this.locked) fail('roomLocked');
    if (this.players.size >= this.settings.maxPlayers) fail('roomFull');
    if (this.isInGame() && !this.settings.allowLateJoin) fail('gameRunning');
    const nameResult = validateName(name, {
      existingNames: [...this.players.values()].map((p) => p.name),
      blockedWords: this.blockedWords,
    });
    if (!nameResult.ok) fail(nameResult.error);
    const membersResult = validateMembers(members);
    if (!membersResult.ok) fail(membersResult.error);

    const player = {
      id: randomId(6),
      sessionId: sessionId && !this.findPlayerBySession(sessionId) ? sessionId : uuid(),
      name: nameResult.name,
      members: membersResult.members,
      score: 0,
      connected: true,
      disconnectedAt: null,
      joinedAt: now,
      // In LOBBY / GAME_OVER the player joins the next game from round 1.
      activeFromRound: this.isInGame() ? this.roundNumber + 1 : 1,
      stats: { fooled: 0, correct: 0 },
    };
    this.players.set(player.id, player);
    this.touch(now);
    return player;
  }

  setPlayerConnected(playerId, connected, now) {
    const player = this.players.get(playerId);
    if (!player) return false;
    if (player.connected === connected) return false;
    player.connected = connected;
    player.disconnectedAt = connected ? null : now;
    this.touch(now);
    if (!connected) this.checkAutoAdvance(now);
    return true;
  }

  renamePlayer(playerId, newName, now) {
    const player = this.getPlayer(playerId);
    const result = validateName(newName, {
      existingNames: [...this.players.values()].filter((p) => p.id !== playerId).map((p) => p.name),
      blockedWords: [],
    });
    if (!result.ok) fail(result.error);
    player.name = result.name;
    this.touch(now);
  }

  removePlayer(playerId, now, { ban = true } = {}) {
    const player = this.getPlayer(playerId);
    if (ban) this.kickedSessions.add(player.sessionId);
    this.players.delete(playerId);
    if (this.round) {
      this.round.submissions.delete(playerId);
      this.round.drafts.delete(playerId);
      delete this.round.votes[playerId];
      if (this.round.definitions) {
        for (const definition of this.round.definitions) {
          definition.authorIds = definition.authorIds.filter((id) => id !== playerId);
          if (!definition.isReal && definition.authorIds.length === 0 && !definition.mergedInto) {
            definition.deleted = true;
          }
        }
      }
    }
    this.touch(now);
    this.checkAutoAdvance(now);
    return player;
  }

  /** Player leaves voluntarily: removed in the lobby, otherwise just treated as disconnected. */
  leavePlayer(playerId, now) {
    if (this.isInGame()) return this.setPlayerConnected(playerId, false, now);
    this.removePlayer(playerId, now, { ban: false });
    return true;
  }

  adjustScore(playerId, delta, now) {
    const player = this.getPlayer(playerId);
    const amount = Math.round(Number(delta));
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 100) fail('invalidDelta');
    player.score += amount;
    this.touch(now);
  }

  // ---------------------------------------------------------------- room settings

  setLocked(locked, now) {
    this.locked = Boolean(locked);
    this.touch(now);
  }

  updateSettings(partial, now) {
    this.settings = mergeSettings(this.settings, partial, { inGame: this.isInGame() });
    if (this.isInGame()) this.settings.rounds = Math.max(this.settings.rounds, this.roundNumber);
    this.touch(now);
    this.checkAutoAdvance(now);
  }

  setCustomWordlist(list, now) {
    if (this.isInGame()) fail('gameRunning');
    this.customWordlist = list ? { title: list.title, words: list.words } : null;
    this.settings.categories = [];
    this.settings.difficulties = [];
    this.touch(now);
  }

  // ---------------------------------------------------------------- game flow

  startGame(now) {
    if (this.phase !== LOBBY) fail('wrongPhase');
    if (this.players.size < 1) fail('noPlayers');
    if (this.wordPool().length < 1) fail('noWords');
    for (const player of this.players.values()) {
      player.score = 0;
      player.activeFromRound = 1;
      player.stats = { fooled: 0, correct: 0 };
    }
    this.roundNumber = 0;
    this.usedTerms = new Set();
    this.history = [];
    this.lastScoreChanges = {};
    this.startRound(now);
  }

  startRound(now, { sameNumber = false } = {}) {
    const word = pickWord(this.wordPool(), this.usedTerms, this.playedTerms, this.random);
    if (!word) fail('noWordsLeft');
    assertTransition(this.phase, WRITING);
    this.usedTerms.add(word.term);
    this.playedTerms.add(word.term);
    if (!sameNumber) this.roundNumber += 1;
    this.phase = WRITING;
    this.round = {
      number: this.roundNumber,
      word: {
        term: word.term,
        article: word.article ?? null,
        wordClass: word.wordClass ?? null,
        category: word.category ?? null,
        difficulty: word.difficulty ?? null,
        definition: normalizeDefinition(word.definition, { standardize: this.settings.standardizeAnswers }),
      },
      submissions: new Map(),
      drafts: new Map(),
      definitions: null,
      ballot: null,
      presentedCount: 0,
      votingOpen: false,
      highlight: null,
      votes: {},
      result: null,
      revealSteps: null,
      revealStep: 0,
      scoresApplied: false,
    };
    this.startTimer(this.settings.writingSeconds, now);
    this.touch(now);
  }

  skipWord(now) {
    if (this.phase !== WRITING && this.phase !== MODERATION) fail('wrongPhase');
    this.startRound(now, { sameNumber: true });
  }

  saveDraft(playerId, text, now) {
    if (this.phase !== WRITING) fail('wrongPhase');
    if (!this.isParticipant(playerId)) fail('notParticipant');
    if (this.timer?.expired) fail('timeUp');
    if (typeof text !== 'string' || text.length > MAX_DRAFT_LENGTH) fail('invalidText');
    this.round.drafts.set(playerId, text);
    this.lastActivity = now;
  }

  submitDefinition(playerId, text, now) {
    if (this.phase !== WRITING) fail('wrongPhase');
    if (!this.isParticipant(playerId)) fail('notParticipant');
    if (this.timer?.expired) fail('timeUp');
    if (typeof text !== 'string') fail('invalidText');
    const cleaned = cleanText(text);
    if (cleaned.length < 3) fail('textTooShort');
    if (cleaned.length > this.settings.maxDefinitionLength) fail('textTooLong');
    this.round.submissions.set(playerId, { text: cleaned, submittedAt: now, auto: false });
    this.round.drafts.set(playerId, cleaned);
    this.touch(now);
    this.checkAutoAdvance(now);
  }

  allSubmitted(now) {
    const waiting = this.waitingParticipants(now);
    return waiting.length > 0 && this.round.submissions.size > 0 && waiting.every((p) => this.round.submissions.has(p.id));
  }

  allVoted(now) {
    const waiting = this.waitingParticipants(now);
    return waiting.length > 0 && waiting.every((p) => this.round.votes[p.id] || !this.canVote(p.id));
  }

  /** Whether a player has at least one ballot entry that is not their own. */
  canVote(playerId) {
    return this.round.ballot.some((entry) => !entry.authorIds.includes(playerId));
  }

  checkAutoAdvance(now) {
    if (this.timer?.paused) return false;
    if (this.phase === WRITING && this.settings.autoModeration && this.allSubmitted(now)) {
      this.endWriting(now);
      return true;
    }
    if (
      this.phase === VOTING &&
      this.round.votingOpen &&
      this.settings.autoRevealWhenAllVoted &&
      this.allVoted(now)
    ) {
      this.startReveal(now);
      return true;
    }
    return false;
  }

  endWriting(now) {
    if (this.phase !== WRITING) fail('wrongPhase');
    const round = this.round;
    const maxLength = this.settings.maxDefinitionLength;
    // Auto-submit non-empty drafts that were never sent.
    for (const player of this.roundParticipants()) {
      if (round.submissions.has(player.id)) continue;
      const draft = cleanText(round.drafts.get(player.id) ?? '');
      if (draft.length >= 3) {
        round.submissions.set(player.id, { text: draft.slice(0, maxLength), submittedAt: now, auto: true });
      }
    }
    const standardize = this.settings.standardizeAnswers;
    round.definitions = [
      {
        id: randomId(6),
        isReal: true,
        text: round.word.definition,
        originalText: round.word.definition,
        authorIds: [],
        deleted: false,
        markedCorrect: false,
        mergedInto: null,
      },
    ];
    for (const [playerId, submission] of round.submissions) {
      if (!this.players.has(playerId)) continue;
      const text = normalizeDefinition(submission.text, { standardize });
      if (!text) continue;
      round.definitions.push({
        id: randomId(6),
        isReal: false,
        text,
        originalText: submission.text,
        authorIds: [playerId],
        deleted: false,
        markedCorrect: false,
        mergedInto: null,
        auto: submission.auto,
      });
    }
    round.drafts.clear();
    assertTransition(this.phase, MODERATION);
    this.phase = MODERATION;
    this.timer = null;
    this.touch(now);
  }

  // ---------------------------------------------------------------- moderation

  moderationDefinition(id) {
    if (this.phase !== MODERATION) fail('wrongPhase');
    const definition = this.round.definitions.find((d) => d.id === id);
    if (!definition) fail('definitionNotFound');
    return definition;
  }

  editDefinition(id, text, now) {
    const definition = this.moderationDefinition(id);
    if (definition.isReal) fail('cannotEditReal');
    if (typeof text !== 'string') fail('invalidText');
    const normalized = normalizeDefinition(text, { standardize: this.settings.standardizeAnswers });
    if (normalized.length < 3) fail('textTooShort');
    if (normalized.length > 300) fail('textTooLong');
    definition.text = normalized;
    this.touch(now);
  }

  setDefinitionDeleted(id, deleted, now) {
    const definition = this.moderationDefinition(id);
    if (definition.isReal) fail('cannotEditReal');
    definition.deleted = Boolean(deleted);
    if (definition.deleted) {
      definition.markedCorrect = false;
      this.unmergeDefinition(id, now);
      definition.mergedInto = null;
    }
    this.touch(now);
  }

  markCorrect(id, correct, now) {
    const definition = this.moderationDefinition(id);
    if (definition.isReal) fail('cannotEditReal');
    definition.markedCorrect = Boolean(correct);
    if (definition.markedCorrect) {
      definition.deleted = false;
      // Merged children share the verdict of their parent.
      for (const child of this.round.definitions) {
        if (child.mergedInto === id) child.markedCorrect = true;
      }
    }
    this.touch(now);
  }

  mergeDefinitions(ids, now) {
    if (!Array.isArray(ids) || ids.length < 2) fail('mergeNeedsTwo');
    const unique = [...new Set(ids)];
    const definitions = unique.map((id) => this.moderationDefinition(id));
    if (definitions.some((d) => d.isReal || d.deleted)) fail('cannotMerge');
    // Resolve to top-level parents so merging merged groups works.
    const parents = [...new Set(definitions.map((d) => d.mergedInto ?? d.id))];
    const [targetId, ...others] = parents;
    for (const definition of this.round.definitions) {
      if (others.includes(definition.id) || others.includes(definition.mergedInto)) {
        definition.mergedInto = targetId;
      }
    }
    this.touch(now);
  }

  unmergeDefinition(id, now) {
    const definition = this.moderationDefinition(id);
    const parentId = definition.mergedInto ?? definition.id;
    if (definition.mergedInto) {
      definition.mergedInto = null;
    } else {
      for (const child of this.round.definitions) {
        if (child.mergedInto === parentId) child.mergedInto = null;
      }
    }
    this.touch(now);
  }

  /** Top-level definitions with merged author lists. */
  effectiveDefinitions() {
    const all = this.round.definitions;
    return all
      .filter((d) => !d.mergedInto)
      .map((d) => {
        const children = all.filter((child) => child.mergedInto === d.id && !child.deleted);
        return {
          ...d,
          authorIds: [...new Set([...d.authorIds, ...children.flatMap((child) => child.authorIds)])],
          mergedIds: children.map((child) => child.id),
        };
      });
  }

  moderationWarning() {
    if (this.phase !== MODERATION) return null;
    const playerDefinitions = this.effectiveDefinitions().filter((d) => !d.isReal && isVotable(d));
    return playerDefinitions.length < 2 ? 'fewDefinitions' : null;
  }

  // ---------------------------------------------------------------- voting

  startVoting(now) {
    if (this.phase !== MODERATION) fail('wrongPhase');
    const round = this.round;
    const votable = this.effectiveDefinitions().filter(isVotable);
    // Fresh random ids so nothing can be correlated with earlier data.
    round.ballot = shuffle(votable, this.random).map((d, index) => ({
      id: randomId(6),
      sourceId: d.id,
      number: index + 1,
      text: d.text,
      isReal: d.isReal,
      authorIds: d.authorIds,
    }));
    round.votes = {};
    round.highlight = null;
    assertTransition(this.phase, VOTING);
    this.phase = VOTING;
    this.timer = null;
    if (this.settings.readAloudMode) {
      round.presentedCount = 0;
      round.votingOpen = false;
    } else {
      this.openVoting(now);
    }
    this.touch(now);
  }

  openVoting(now) {
    const round = this.round;
    round.presentedCount = round.ballot.length;
    round.votingOpen = true;
    round.highlight = null;
    this.startTimer(this.settings.votingSeconds, now);
    this.touch(now);
  }

  /** Read-aloud mode: reveal ballot entries one by one before voting opens. */
  present(action, now) {
    if (this.phase !== VOTING) fail('wrongPhase');
    const round = this.round;
    const total = round.ballot.length;
    if (action === 'next') {
      if (round.votingOpen) fail('votingAlreadyOpen');
      if (round.presentedCount < total) {
        round.presentedCount += 1;
        round.highlight = round.presentedCount;
      } else {
        this.openVoting(now);
      }
    } else if (action === 'prev') {
      if (round.votingOpen) fail('votingAlreadyOpen');
      round.presentedCount = Math.max(0, round.presentedCount - 1);
      round.highlight = round.presentedCount || null;
    } else if (action === 'all' || action === 'openVoting') {
      if (!round.votingOpen) this.openVoting(now);
    } else {
      fail('invalidAction');
    }
    this.touch(now);
  }

  setHighlight(number, now) {
    if (this.phase !== VOTING) fail('wrongPhase');
    const round = this.round;
    if (number === null) {
      round.highlight = null;
    } else {
      const n = Number(number);
      if (!Number.isInteger(n) || n < 1 || n > round.presentedCount) fail('invalidNumber');
      round.highlight = n;
    }
    this.touch(now);
  }

  vote(playerId, ballotId, now) {
    if (this.phase !== VOTING) fail('wrongPhase');
    const round = this.round;
    if (!round.votingOpen) fail('votingNotOpen');
    if (this.timer?.expired) fail('timeUp');
    if (!this.isParticipant(playerId)) fail('notParticipant');
    const entry = round.ballot.find((e) => e.id === ballotId);
    if (!entry) fail('definitionNotFound');
    if (entry.authorIds.includes(playerId)) fail('ownDefinition');
    round.votes[playerId] = ballotId;
    this.touch(now);
    this.checkAutoAdvance(now);
  }

  // ---------------------------------------------------------------- reveal

  startReveal(now) {
    if (this.phase !== VOTING) fail('wrongPhase');
    const round = this.round;
    if (!round.votingOpen) this.openVoting(now);
    const participantIds = this.roundParticipants().map((p) => p.id);
    // scoreRound works on source definitions; translate ballot votes to them.
    const definitions = round.ballot.map((entry) => ({
      id: entry.id,
      isReal: entry.isReal,
      authorIds: entry.authorIds,
    }));
    const markedCorrect = this.effectiveDefinitions()
      .filter((d) => !d.isReal && d.markedCorrect && !d.deleted)
      .map((d) => ({ id: d.id, isReal: false, authorIds: d.authorIds, markedCorrect: true }));
    round.result = scoreRound({
      definitions: [...definitions, ...markedCorrect],
      votes: round.votes,
      playerIds: participantIds,
      points: this.settings.points,
    });

    const fakes = round.ballot
      .filter((entry) => !entry.isReal)
      .map((entry, index) => ({ entry, votes: round.result.votesByDefinition[entry.id].length, index }))
      .sort((a, b) => a.votes - b.votes || a.index - b.index);
    const steps = [];
    for (const { entry } of fakes) {
      steps.push({ type: 'text', ballotId: entry.id });
      steps.push({ type: 'voters', ballotId: entry.id });
      steps.push({ type: 'authors', ballotId: entry.id });
    }
    const real = round.ballot.find((entry) => entry.isReal);
    steps.push({ type: 'real', ballotId: real.id });
    if (markedCorrect.length) steps.push({ type: 'bonus' });
    round.revealSteps = steps;
    round.revealStep = 0;
    round.highlight = null;
    assertTransition(this.phase, REVEAL);
    this.phase = REVEAL;
    this.timer = null;
    this.touch(now);
  }

  revealDone() {
    return this.phase === REVEAL && this.round.revealStep >= this.round.revealSteps.length;
  }

  revealNext(now) {
    if (this.phase !== REVEAL) fail('wrongPhase');
    if (this.revealDone()) fail('revealDone');
    this.round.revealStep += 1;
    this.touch(now);
  }

  revealAll(now) {
    if (this.phase !== REVEAL) fail('wrongPhase');
    this.round.revealStep = this.round.revealSteps.length;
    this.touch(now);
  }

  applyRoundScores(now) {
    const round = this.round;
    if (!round?.result || round.scoresApplied) return;
    const previousRanks = rankMap([...this.players.values()]);
    const changes = {};
    for (const [playerId, result] of Object.entries(round.result.players)) {
      const player = this.players.get(playerId);
      if (!player) continue;
      player.score += result.total;
      player.stats.fooled += result.fooledCount;
      if (result.votedReal) player.stats.correct += 1;
      changes[playerId] = { delta: result.total, previousRank: previousRanks.get(playerId) ?? null };
    }
    round.scoresApplied = true;
    this.lastScoreChanges = changes;
    this.history.push(this.summarizeRound());
    this.touch(now);
  }

  summarizeRound() {
    const round = this.round;
    const nameOf = (id) => this.players.get(id)?.name ?? '(entfernt)';
    const votesBy = round.result.votesByDefinition;
    const ballotBySource = new Map(round.ballot.map((entry) => [entry.sourceId, entry]));
    const definitions = this.effectiveDefinitions().map((d) => {
      const entry = ballotBySource.get(d.id);
      return {
        text: d.text,
        isReal: d.isReal,
        authors: d.authorIds.map(nameOf),
        authorIds: d.authorIds,
        voters: entry ? votesBy[entry.id].map(nameOf) : [],
        votes: entry ? votesBy[entry.id].length : 0,
        deleted: d.deleted,
        markedCorrect: d.markedCorrect,
      };
    });
    return {
      number: round.number,
      term: round.word.term,
      article: round.word.article,
      realDefinition: round.word.definition,
      definitions,
    };
  }

  // ---------------------------------------------------------------- navigation

  goToScoreboard(now) {
    if (this.phase !== REVEAL) fail('wrongPhase');
    this.applyRoundScores(now);
    assertTransition(this.phase, SCOREBOARD);
    this.phase = SCOREBOARD;
    this.touch(now);
  }

  isLastRound() {
    return this.roundNumber >= this.settings.rounds;
  }

  /** Host "next" button / space bar: advances whatever comes next. */
  next(now) {
    switch (this.phase) {
      case LOBBY:
        return this.startGame(now);
      case WRITING:
        return this.endWriting(now);
      case MODERATION:
        return this.startVoting(now);
      case VOTING:
        if (!this.round.votingOpen) return this.present('next', now);
        return this.startReveal(now);
      case REVEAL:
        if (!this.revealDone()) return this.revealNext(now);
        return this.goToScoreboard(now);
      case SCOREBOARD:
        if (this.isLastRound()) return this.endGame(now);
        return this.startRound(now);
      default:
        fail('wrongPhase');
    }
  }

  endGame(now) {
    if (this.phase === GAME_OVER || this.phase === LOBBY) fail('wrongPhase');
    if (this.phase === REVEAL) this.applyRoundScores(now);
    assertTransition(this.phase, GAME_OVER);
    this.phase = GAME_OVER;
    this.timer = null;
    this.touch(now);
  }

  playAgain(now) {
    if (this.phase !== GAME_OVER) fail('wrongPhase');
    assertTransition(this.phase, LOBBY);
    this.phase = LOBBY;
    this.round = null;
    this.roundNumber = 0;
    this.usedTerms = new Set();
    this.history = [];
    this.lastScoreChanges = {};
    for (const player of this.players.values()) {
      player.score = 0;
      player.activeFromRound = 1;
      player.stats = { fooled: 0, correct: 0 };
    }
    this.touch(now);
  }

  // ---------------------------------------------------------------- persistence

  toJSON() {
    const round = this.round && {
      ...this.round,
      submissions: [...this.round.submissions],
      drafts: [...this.round.drafts],
    };
    return {
      code: this.code,
      hostToken: this.hostToken,
      screenToken: this.screenToken,
      settings: this.settings,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      phase: this.phase,
      locked: this.locked,
      players: [...this.players.values()],
      kickedSessions: [...this.kickedSessions],
      customWordlist: this.customWordlist,
      hostEverConnected: this.hostEverConnected ?? false,
      roundNumber: this.roundNumber,
      round,
      timer: this.timer,
      usedTerms: [...this.usedTerms],
      playedTerms: [...this.playedTerms],
      history: this.history,
      lastScoreChanges: this.lastScoreChanges,
    };
  }

  static fromJSON(data, { getWordlists, blockedWords, now = Date.now() } = {}) {
    const game = new Game({
      code: data.code,
      hostToken: data.hostToken,
      screenToken: data.screenToken,
      settings: data.settings,
      getWordlists,
      blockedWords,
      now: data.createdAt,
    });
    game.settings = { ...game.settings, ...data.settings };
    game.lastActivity = data.lastActivity;
    game.phase = data.phase;
    game.locked = data.locked;
    game.players = new Map(
      data.players.map((p) => [p.id, { ...p, connected: false, disconnectedAt: now }]),
    );
    game.kickedSessions = new Set(data.kickedSessions);
    game.customWordlist = data.customWordlist;
    game.hostEverConnected = data.hostEverConnected;
    game.roundNumber = data.roundNumber;
    game.round = data.round && {
      ...data.round,
      submissions: new Map(data.round.submissions),
      drafts: new Map(data.round.drafts),
    };
    game.timer = data.timer;
    game.usedTerms = new Set(data.usedTerms);
    game.playedTerms = new Set(data.playedTerms);
    game.history = data.history;
    game.lastScoreChanges = data.lastScoreChanges ?? {};
    // After a restart the host is gone: freeze any running timer until they return.
    game.hostConnected = false;
    if (game.timer && !game.timer.paused && !game.timer.expired) {
      game.timer.remainingMs = Math.max(0, game.timer.endsAt - (data.savedAt ?? now));
      game.timer.endsAt = null;
      game.timer.paused = true;
      game.timer.pauseReason = 'hostDisconnected';
    }
    return game;
  }
}

/** Competition ranking ("1224"): equal scores share a rank. */
export function rankPlayers(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'de'));
  let lastScore = null;
  let lastRank = 0;
  return sorted.map((player, index) => {
    const rank = player.score === lastScore ? lastRank : index + 1;
    lastScore = player.score;
    lastRank = rank;
    return { player, rank };
  });
}

function rankMap(players) {
  return new Map(rankPlayers(players).map(({ player, rank }) => [player.id, rank]));
}
