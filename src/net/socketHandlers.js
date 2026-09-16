import { timingSafeEqual, createHash } from 'node:crypto';
import { GameError } from '../game/phases.js';
import { getStateFor } from '../game/views.js';
import { parseCsvWordlist, parseJsonWordlist } from '../game/wordlists.js';
import { exportFilename, exportGameCsv } from '../game/exportCsv.js';
import { uuid } from '../game/random.js';
import { pinMatches } from './auth.js';
import { FailureLimiter, TokenBucket } from './rateLimit.js';
import { summarizeWordlists } from './wordlistStore.js';
import * as v from './validate.js';

const MAX_IMPORT_BYTES = 512 * 1024;

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hash = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

export function clientIp(socket) {
  const headers = socket.handshake.headers;
  const forwarded = headers['cf-connecting-ip'] || String(headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || socket.handshake.address || 'unknown';
}

function baseUrlOf(socket) {
  const headers = socket.handshake.headers;
  const proto = String(headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || (socket.handshake.secure ? 'https' : 'http');
  const host = String(headers['x-forwarded-host'] ?? '').split(',')[0].trim() || headers.host || 'localhost';
  return `${proto}://${host}`;
}

/**
 * Wires Socket.IO to the room manager. The socket layer only validates input,
 * checks roles, calls Game methods and distributes filtered state.
 */
export function registerSocketHandlers({ io, rooms, hostTokens, config, getWordlists, persistence, log = console }) {
  /** @type {Map<string, Set<import('socket.io').Socket>>} */
  const members = new Map();
  /** @type {Map<string, number>} */
  const connectionCounts = new Map();
  const pendingBroadcasts = new Set();
  const joinFailures = new FailureLimiter({ max: 15, windowMs: 60_000 });
  const pinFailures = new FailureLimiter({ max: 5, windowMs: 5 * 60_000 });

  setInterval(() => {
    const now = Date.now();
    joinFailures.cleanup(now);
    pinFailures.cleanup(now);
    hostTokens.cleanup(now);
  }, 60_000).unref?.();

  function viewFor(socket, game, now) {
    const { role, playerId } = socket.data;
    const view = getStateFor(game, role, playerId ?? null, now);
    if (role === 'host' || role === 'screen') view.join = rooms.getJoinInfo(game.code);
    if (role === 'host') {
      view.host.wordlists = summarizeWordlists(getWordlists());
      view.host.pinIsDefault = config.hostPinIsDefault;
      view.host.devShortTimers = config.devShortTimers;
    }
    return view;
  }

  function sendState(socket, game) {
    socket.emit('state', viewFor(socket, game, Date.now()));
  }

  function flush(code) {
    pendingBroadcasts.delete(code);
    const game = rooms.get(code);
    if (!game) return;
    const now = Date.now();
    for (const socket of members.get(code) ?? []) {
      socket.emit('state', viewFor(socket, game, now));
    }
    if (persistence) persistence.schedule(snapshot);
  }

  /** Coalesces several changes in the same tick into one broadcast. */
  function broadcast(game) {
    if (pendingBroadcasts.has(game.code)) return;
    pendingBroadcasts.add(game.code);
    setImmediate(() => flush(game.code));
  }

  function snapshot() {
    return { savedAt: Date.now(), rooms: rooms.snapshot(), hostTokens: hostTokens.toJSON() };
  }

  function countKey(socket) {
    const { code, role, playerId } = socket.data;
    return role === 'player' ? `${code}:p:${playerId}` : `${code}:${role}`;
  }

  function attach(socket, game, role, playerId = null) {
    detach(socket);
    socket.data.role = role;
    socket.data.code = game.code;
    socket.data.playerId = playerId;
    if (!members.has(game.code)) members.set(game.code, new Set());
    members.get(game.code).add(socket);
    const key = countKey(socket);
    connectionCounts.set(key, (connectionCounts.get(key) ?? 0) + 1);
    const now = Date.now();
    if (role === 'player') game.setPlayerConnected(playerId, true, now);
    if (role === 'host') {
      game.setHostConnected(true, now);
      rooms.schedule(game);
    }
    broadcast(game);
  }

  function detach(socket) {
    const { code, role } = socket.data;
    if (!code || !role) return;
    const key = countKey(socket);
    const remaining = (connectionCounts.get(key) ?? 1) - 1;
    if (remaining > 0) connectionCounts.set(key, remaining);
    else connectionCounts.delete(key);
    members.get(code)?.delete(socket);
    if (members.get(code)?.size === 0) members.delete(code);
    const game = rooms.get(code);
    if (game && remaining <= 0) {
      const now = Date.now();
      if (role === 'player') game.setPlayerConnected(socket.data.playerId, false, now);
      if (role === 'host') game.setHostConnected(false, now);
      rooms.schedule(game);
      broadcast(game);
    }
    socket.data.role = null;
    socket.data.code = null;
    socket.data.playerId = null;
  }

  function onRoomClosed(game, reason) {
    for (const socket of [...(members.get(game.code) ?? [])]) {
      socket.emit('roomClosed', { reason });
      socket.data.role = null;
      socket.data.code = null;
      socket.data.playerId = null;
    }
    members.delete(game.code);
    for (const key of connectionCounts.keys()) {
      if (key.startsWith(`${game.code}:`)) connectionCounts.delete(key);
    }
    if (persistence) persistence.schedule(snapshot);
  }

  io.on('connection', (socket) => {
    socket.data = { role: null, code: null, playerId: null, hostToken: null, ip: clientIp(socket) };
    const bucket = new TokenBucket(20, 20);

    const currentGame = () => {
      const game = rooms.get(socket.data.code);
      if (!game) throw new GameError('roomNotFound');
      return game;
    };

    /**
     * @param {string} event
     * @param {{role?: 'host'|'player'|null}} options
     * @param {(payload: object, game: import('../game/Game.js').Game|null, now: number) => object|void|Promise<object|void>} handler
     */
    function on(event, { role }, handler) {
      socket.on(event, async (payload, callback) => {
        if (typeof payload === 'function') {
          callback = payload;
          payload = undefined;
        }
        const ack = typeof callback === 'function' ? callback : () => {};
        if (!bucket.take()) {
          log.warn(`[socket ${socket.id}] rate limit: ${event}`);
          return ack({ ok: false, error: 'rateLimited' });
        }
        let game = null;
        let versionBefore = null;
        try {
          if (role && socket.data.role !== role) throw new GameError('forbidden');
          if (role === 'host') {
            if (!hostTokens.isValid(socket.data.hostToken)) throw new GameError('hostAuthExpired');
            hostTokens.refresh(socket.data.hostToken);
          }
          if (role) {
            game = currentGame();
            versionBefore = game.version;
          }
          const result = await handler(v.object(payload), game, Date.now());
          if (game && game.version !== versionBefore) {
            rooms.schedule(game);
            broadcast(game);
          }
          ack({ ok: true, ...(result ?? {}) });
        } catch (error) {
          if (game && versionBefore !== null && game.version !== versionBefore) {
            rooms.schedule(game);
            broadcast(game);
          }
          if (error instanceof GameError) {
            log.warn(`[socket ${socket.id}] ${event} abgelehnt (${socket.data.role ?? 'ohne Rolle'}): ${error.message}`);
            ack({ ok: false, error: error.code });
          } else {
            log.error(`[socket ${socket.id}] ${event} fehlgeschlagen: ${error.stack ?? error}`);
            ack({ ok: false, error: 'serverError' });
          }
        }
      });
    }

    // ------------------------------------------------------------ players

    function roomForJoin(code) {
      const now = Date.now();
      if (joinFailures.isBlocked(socket.data.ip, now)) throw new GameError('tooManyAttempts');
      const game = rooms.get(v.str(code, { max: 10, name: 'code' }));
      if (!game) {
        joinFailures.fail(socket.data.ip, now);
        throw new GameError('roomNotFound');
      }
      return game;
    }

    on('player:join', {}, (payload, _, now) => {
      const game = roomForJoin(payload.code);
      const sessionId = v.optionalStr(payload.sessionId, { max: 64, name: 'sessionId' });
      const player = game.addPlayer(
        {
          name: v.str(payload.name, { max: 100, name: 'name' }),
          members: v.optionalStr(payload.members, { max: 200, name: 'members' }),
          sessionId: sessionId || uuid(),
        },
        now,
      );
      attach(socket, game, 'player', player.id);
      log.info(`[room ${game.code}] ${player.name} ist beigetreten`);
      return { sessionId: player.sessionId, playerId: player.id, code: game.code };
    });

    on('player:resume', {}, (payload) => {
      const game = roomForJoin(payload.code);
      const sessionId = v.str(payload.sessionId, { min: 1, max: 64, name: 'sessionId' });
      if (game.kickedSessions.has(sessionId)) throw new GameError('kicked');
      const player = game.findPlayerBySession(sessionId);
      if (!player) throw new GameError('sessionNotFound');
      attach(socket, game, 'player', player.id);
      return { playerId: player.id, code: game.code };
    });

    on('player:draft', { role: 'player' }, (payload, game, now) => {
      game.saveDraft(socket.data.playerId, v.str(payload.text, { max: 400, name: 'text' }), now);
    });

    on('player:submit', { role: 'player' }, (payload, game, now) => {
      game.submitDefinition(socket.data.playerId, v.str(payload.text, { max: 400, name: 'text' }), now);
    });

    on('player:vote', { role: 'player' }, (payload, game, now) => {
      game.vote(socket.data.playerId, v.id(payload.definitionId, 'definitionId'), now);
    });

    on('player:favorite', { role: 'player' }, (payload, game, now) => {
      const definitionId = payload.definitionId === null ? null : v.id(payload.definitionId, 'definitionId');
      game.voteFavorite(socket.data.playerId, definitionId, now);
    });

    on('player:leave', { role: 'player' }, (_, game, now) => {
      const playerId = socket.data.playerId;
      detach(socket);
      game.leavePlayer(playerId, now);
    });

    // ------------------------------------------------------------ screen

    on('screen:join', {}, (payload) => {
      const game = roomForJoin(payload.code);
      if (!sameSecret(payload.screenToken, game.screenToken)) {
        joinFailures.fail(socket.data.ip);
        throw new GameError('forbidden');
      }
      attach(socket, game, 'screen');
      sendState(socket, game);
    });

    // ------------------------------------------------------------ host auth

    on('host:login', {}, (payload, _, now) => {
      if (pinFailures.isBlocked(socket.data.ip, now)) throw new GameError('tooManyAttempts');
      if (!pinMatches(payload.pin, config.hostPin)) {
        pinFailures.fail(socket.data.ip, now);
        throw new GameError('wrongPin');
      }
      const hostToken = hostTokens.issue(now);
      socket.data.hostToken = hostToken;
      if (persistence) persistence.schedule(snapshot);
      return { hostToken };
    });

    // Validates a stored token without joining a room (used on page load).
    on('host:auth', {}, (payload, _, now) => {
      const token = v.str(payload.hostToken, { max: 100, name: 'hostToken' });
      if (!hostTokens.isValid(token, now)) throw new GameError('hostAuthExpired');
      socket.data.hostToken = token;
      const activeRooms = [...rooms.rooms.values()].map((g) => ({
        code: g.code,
        players: g.players.size,
        phase: g.phase,
        mine: g.hostToken === token,
        lastActivity: g.lastActivity,
      }));
      return {
        rooms: activeRooms,
        wordlists: summarizeWordlists(getWordlists()),
        pinIsDefault: config.hostPinIsDefault,
      };
    });

    on('host:createRoom', {}, async (payload, _, now) => {
      if (!hostTokens.isValid(socket.data.hostToken, now)) throw new GameError('hostAuthExpired');
      const game = await rooms.create(
        { hostToken: socket.data.hostToken, settings: v.object(payload.settings, 'settings'), baseUrl: baseUrlOf(socket) },
        now,
      );
      attach(socket, game, 'host');
      return { code: game.code };
    });

    // Anyone who knows the PIN may take over any room (e.g. after switching laptops).
    on('host:resume', {}, async (payload, _, now) => {
      if (!hostTokens.isValid(socket.data.hostToken, now)) throw new GameError('hostAuthExpired');
      const game = rooms.get(v.str(payload.code, { max: 10, name: 'code' }));
      if (!game) throw new GameError('roomNotFound');
      await rooms.ensureJoinInfo(game, baseUrlOf(socket));
      attach(socket, game, 'host');
      return { code: game.code };
    });

    // ------------------------------------------------------------ host: lobby & settings

    const host = (event, handler) => on(event, { role: 'host' }, handler);

    host('host:updateSettings', (payload, game, now) => {
      const settings = v.object(payload.settings, 'settings');
      if (typeof settings.wordlist === 'string' && !getWordlists()[settings.wordlist]) {
        throw new GameError('wordlistNotFound');
      }
      if (typeof settings.wordlist === 'string' && settings.wordlist !== game.settings.wordlist && !game.isInGame()) {
        game.setCustomWordlist(null, now);
      }
      game.updateSettings(settings, now);
    });

    host('host:importWordlist', (payload, game, now) => {
      const format = v.oneOf(payload.format, ['json', 'csv'], 'format');
      const content = v.str(payload.content, { max: MAX_IMPORT_BYTES, name: 'content' });
      const title = v.optionalStr(payload.title, { max: 60, name: 'title' }) || 'Eigene Liste';
      const result = format === 'json' ? parseJsonWordlist(content, title) : parseCsvWordlist(content, title);
      if (payload.apply === true) {
        if (!result.ok) throw new GameError('importInvalid');
        game.setCustomWordlist({ title: result.title, words: result.words }, now);
      }
      return {
        preview: {
          title: result.title,
          valid: result.words.length,
          invalid: result.invalid,
          errors: result.errors.slice(0, 20),
          moreErrors: Math.max(0, result.errors.length - 20),
          sample: result.words.slice(0, 5).map((w) => w.term),
          applied: payload.apply === true,
        },
      };
    });

    host('host:clearCustomWordlist', (_, game, now) => {
      game.setCustomWordlist(null, now);
    });

    host('host:lockLobby', (payload, game, now) => {
      game.setLocked(v.bool(payload.locked, 'locked'), now);
    });

    host('host:renamePlayer', (payload, game, now) => {
      game.renamePlayer(v.id(payload.playerId, 'playerId'), v.str(payload.name, { max: 100, name: 'name' }), now);
    });

    host('host:kickPlayer', (payload, game, now) => {
      const playerId = v.id(payload.playerId, 'playerId');
      const player = game.removePlayer(playerId, now);
      for (const other of [...(members.get(game.code) ?? [])]) {
        if (other.data.role === 'player' && other.data.playerId === playerId) {
          other.emit('kicked', {});
          detach(other);
        }
      }
      log.info(`[room ${game.code}] ${player.name} wurde entfernt`);
    });

    host('host:adjustScore', (payload, game, now) => {
      game.adjustScore(v.id(payload.playerId, 'playerId'), v.int(payload.delta, { min: -100, max: 100, name: 'delta' }), now);
    });

    // ------------------------------------------------------------ host: game flow

    host('host:startGame', (_, game, now) => {
      game.startGame(now);
    });

    host('host:next', (_, game, now) => {
      game.next(now);
    });

    host('host:timer', (payload, game, now) => {
      const action = v.oneOf(payload.action, ['add', 'set', 'pause', 'resume', 'end'], 'action');
      if (action === 'add') game.addTime(30, now);
      if (action === 'set') game.setTimer(v.int(payload.seconds, { min: 0, max: 900, name: 'seconds' }), now);
      if (action === 'pause' && !game.pauseTimer('host', now)) throw new GameError('noTimer');
      if (action === 'resume' && !game.resumeTimer(now)) throw new GameError('noTimer');
      if (action === 'end') game.endPhaseNow(now);
    });

    host('host:setNextRound', (payload, game, now) => {
      const update = {};
      if (payload.modifiers !== undefined) update.modifiers = v.idList(payload.modifiers, { max: 10, name: 'modifiers' });
      if (payload.wheel !== undefined) update.wheel = v.bool(payload.wheel, 'wheel');
      game.setNextRound(update, now);
    });

    host('host:nextWord', (payload, game, now) => {
      const action = v.oneOf(payload.action, ['draw', 'choose', 'random'], 'action');
      if (action === 'draw') game.drawNextWord(now);
      if (action === 'choose') game.chooseNextWord(v.str(payload.term, { min: 1, max: 80, name: 'term' }), now);
      if (action === 'random') game.chooseNextWord(null, now);
    });

    host('host:skipWord', (_, game, now) => {
      game.skipWord(now);
    });

    host('host:editDefinition', (payload, game, now) => {
      game.editDefinition(v.id(payload.id), v.str(payload.text, { max: 400, name: 'text' }), now);
    });

    host('host:deleteDefinition', (payload, game, now) => {
      game.setDefinitionDeleted(v.id(payload.id), payload.deleted !== false, now);
    });

    host('host:markCorrect', (payload, game, now) => {
      game.markCorrect(v.id(payload.id), v.bool(payload.correct, 'correct'), now);
    });

    host('host:mergeDefinitions', (payload, game, now) => {
      game.mergeDefinitions(v.idList(payload.ids), now);
    });

    host('host:unmerge', (payload, game, now) => {
      game.unmergeDefinition(v.id(payload.id), now);
    });

    host('host:startVoting', (_, game, now) => {
      game.startVoting(now);
    });

    host('host:present', (payload, game, now) => {
      game.present(v.oneOf(payload.action, ['next', 'prev', 'all', 'openVoting'], 'action'), now);
    });

    host('host:highlight', (payload, game, now) => {
      const number = payload.number === null ? null : v.int(payload.number, { min: 1, max: 200, name: 'number' });
      game.setHighlight(number, now);
    });

    host('host:revealAll', (_, game, now) => {
      game.revealAll(now);
    });

    host('host:endGame', (_, game, now) => {
      game.endGame(now);
    });

    host('host:playAgain', (_, game, now) => {
      game.playAgain(now);
    });

    host('host:exportCsv', (_, game, now) => ({
      filename: exportFilename(game, now),
      csv: exportGameCsv(game, now),
    }));

    host('host:closeRoom', (_, game) => {
      rooms.close(game.code, 'host');
    });

    socket.on('disconnect', () => detach(socket));
  });

  return { broadcast, onRoomClosed, snapshot };
}
