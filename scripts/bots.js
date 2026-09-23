#!/usr/bin/env node
// Test bots: npm run bots -- --code ABCD --count 8 [--url http://localhost:3000] [--spy]
//   [--host 1234]  also act as host (log in with PIN, create a room, drive the whole game)
//   [--rounds 2]   rounds when --host creates the room
//   [--reconnect]  disconnect and resume some bots mid-game
import { io } from 'socket.io-client';

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? 'http://localhost:3000';
const count = Number(args.count ?? 6);
const spy = Boolean(args.spy);
const hostPin = args.host === true ? '1234' : args.host;
const rounds = Number(args.rounds ?? 2);
const testReconnect = Boolean(args.reconnect);

const NAMES = ['Wortfuchs', 'Lexikoala', 'Duden-Dino', 'Silbensalat', 'Die Grammatiker', 'Team Komma', 'Satzbau-Crew', 'Fremdwortfans', 'Buchstabensuppe', 'Die Dativ-Retter', 'Schreibmaschine', 'Tintenklecks'];
const DEFINITIONS = [
  'Kleines Werkzeug zum Glätten von Leder',
  'das ist ein alter Brauch aus Norddeutschland',
  'Fachbegriff für eine Wolkenform über dem Meer',
  'Musikinstrument aus dem Mittelalter mit drei Saiten',
  'Es bedeutet eine besondere Art, Brot zu backen',
  'Verzierung am Rand eines Buches',
  'Bezeichnung für einen schüchternen Menschen',
  'Seltene Krankheit bei Obstbäumen',
  'Kleiner Vogel, der in Felsspalten brütet',
  'Juristischer Begriff für einen verspäteten Einspruch',
  'Gewürzmischung aus der Türkei',
  'Stilmittel, bei dem Wörter vertauscht werden',
];

const SECRET_KEYS = ['"authorIds"', '"authors"', '"isReal"', '"sourceId"', '"voters"', '"realDefinition"', '"definitions"', '"nextRound"', '"availableTerms"', '"catchupIds"'];
let plannedTerm = null;
let failures = 0;

function parseArgs(list) {
  const result = {};
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : true;
    result[key] = value;
  }
  return result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const random = (min, max) => min + Math.random() * (max - min);
const pick = (items) => items[Math.floor(Math.random() * items.length)];

function log(...parts) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

function emit(socket, event, payload = {}) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (err, response) => resolve(err ? { ok: false, error: 'timeout' } : response));
  });
}

function checkLeaks(name, view) {
  if (!spy) return;
  // Secrets may only appear once the reveal starts (and then only step by step).
  const json = JSON.stringify(view);
  // The host's next-word preview must never reach players, in any phase.
  if (plannedTerm && (view.phase === 'LOBBY' || view.phase === 'SCOREBOARD') && json.includes(plannedTerm)) {
    failures++;
    console.error(`✖ LEAK: ${name} erhielt das vorab gewählte Wort in Phase ${view.phase}`);
  }
  if (['REVEAL', 'SCOREBOARD', 'GAME_OVER'].includes(view.phase)) return;
  for (const key of SECRET_KEYS) {
    if (json.includes(key)) {
      failures++;
      console.error(`✖ LEAK: ${name} erhielt ${key} in Phase ${view.phase}`);
    }
  }
}

class Bot {
  constructor(index, code) {
    this.index = index;
    this.code = code;
    this.name = count > NAMES.length ? `${NAMES[index % NAMES.length]} ${index + 1}` : NAMES[index];
    this.sessionId = null;
    this.view = null;
    this.handledKey = null;
  }

  connect() {
    this.socket = io(url, { transports: ['websocket', 'polling'], reconnection: true, forceNew: true });
    this.socket.on('state', (view) => {
      this.view = view;
      checkLeaks(this.name, view);
      this.react(view).catch((error) => console.error(this.name, error));
    });
    this.socket.on('kicked', () => log(`${this.name}: wurde entfernt`));
    this.socket.on('roomClosed', () => log(`${this.name}: Raum geschlossen`));
    this.socket.on('connect', async () => {
      if (this.sessionId) {
        const result = await emit(this.socket, 'player:resume', { code: this.code, sessionId: this.sessionId });
        log(`${this.name}: resume ${result.ok ? 'ok' : result.error}`);
        if (!result.ok) failures++;
        return;
      }
      const result = await emit(this.socket, 'player:join', {
        code: this.code,
        name: this.name,
        members: this.index % 3 === 0 ? 'Anna, Ben' : '',
      });
      if (!result.ok) {
        failures++;
        console.error(`✖ ${this.name}: join fehlgeschlagen (${result.error})`);
        return;
      }
      this.sessionId = result.sessionId;
      log(`${this.name}: beigetreten`);
    });
  }

  disconnect() {
    this.socket.disconnect();
  }

  async react(view) {
    const you = view.you;
    if (!you || you.waitingForNextRound) return;
    if (view.phase === 'WRITING' && !you.submitted) {
      const key = `write:${view.roundNumber}:${view.word.term}`;
      if (this.handledKey === key) return;
      this.handledKey = key;
      await sleep(random(300, 2500));
      // Some bots only leave a draft to test auto-submit.
      const text = `${pick(DEFINITIONS)} (${this.name})`;
      if (this.index % 5 === 4) {
        await emit(this.socket, 'player:draft', { text });
      } else {
        const result = await emit(this.socket, 'player:submit', { text });
        if (!result.ok && result.error !== 'wrongPhase') console.error(`${this.name}: submit ${result.error}`);
      }
    }
    if (view.phase === 'VOTING' && view.ballot.votingOpen && !you.vote && you.canVote) {
      const key = `vote:${view.roundNumber}:${view.ballot.entries.map((e) => e.id).join()}`;
      if (this.handledKey === key) return;
      this.handledKey = key;
      const options = view.ballot.entries.filter((entry) => entry.id !== you.ownEntryId);
      await sleep(random(300, 2000));
      // Own entry must be rejected by the server.
      if (you.ownEntryId && this.index === 0) {
        const own = await emit(this.socket, 'player:vote', { definitionId: you.ownEntryId });
        if (own.ok) {
          failures++;
          console.error('✖ Eigene Definition konnte gewählt werden!');
        }
      }
      const result = await emit(this.socket, 'player:vote', { definitionId: pick(options).id });
      if (!result.ok && result.error !== 'wrongPhase') console.error(`${this.name}: vote ${result.error}`);
      if (view.ballot.favoriteEnabled) {
        await sleep(random(100, 600));
        const fav = await emit(this.socket, 'player:favorite', { definitionId: pick(options).id });
        if (!fav.ok && fav.error !== 'wrongPhase') {
          failures++;
          console.error(`✖ ${this.name}: favorite ${fav.error}`);
        }
      }
    }
    if (view.phase === 'REVEAL' && view.reveal.done && you.roundResult && this.handledKey !== `result:${view.roundNumber}`) {
      this.handledKey = `result:${view.roundNumber}`;
      log(`${this.name}: Runde ${view.roundNumber}: ${JSON.stringify(you.roundResult)}`);
    }
  }
}

async function runHost() {
  const socket = io(url, { transports: ['websocket'], forceNew: true });
  await new Promise((resolve) => socket.on('connect', resolve));
  const login = await emit(socket, 'host:login', { pin: String(hostPin) });
  if (!login.ok) throw new Error(`Host-Login fehlgeschlagen: ${login.error}`);
  const created = await emit(socket, 'host:createRoom', {
    settings: { rounds, writingSeconds: 12, votingSeconds: 10, readAloudMode: true },
  });
  if (!created.ok) throw new Error(`Raum konnte nicht erstellt werden: ${created.error}`);
  log(`Host: Raum ${created.code} erstellt`);
  const host = { socket, code: created.code, view: null, token: login.hostToken };
  socket.on('state', (view) => {
    host.view = view;
  });
  return host;
}

async function driveGame(host, bots) {
  const act = async (event, payload) => {
    const result = await emit(host.socket, event, payload);
    if (!result.ok) {
      console.error(`✖ Host ${event}: ${result.error}`);
      failures++;
    }
    return result;
  };
  const waitFor = async (predicate, label, timeoutMs = 60_000) => {
    const start = Date.now();
    while (!predicate(host.view)) {
      if (Date.now() - start > timeoutMs) throw new Error(`Timeout beim Warten auf: ${label} (Phase ${host.view?.phase})`);
      await sleep(100);
    }
  };

  // Round plan exercising the modifiers: 1 = chosen word + double/truth, 2 = favourite + catch-up + bluffer, 3 = wheel.
  const plans = [
    { modifiers: ['double', 'truth'], word: true },
    { modifiers: ['favorite', 'catchup', 'bluffer'] },
    { wheel: true },
  ];
  const prepare = async (roundNumber) => {
    const plan = plans[(roundNumber - 1) % plans.length];
    if (plan.modifiers) await act('host:setNextRound', { modifiers: plan.modifiers, wheel: false });
    if (plan.wheel) await act('host:setNextRound', { wheel: true });
    plannedTerm = null;
    if (plan.word) {
      await waitFor((v) => v.host.nextRound?.candidates?.length, 'Wortvorschläge', 5000);
      await act('host:nextWord', { action: 'choose', term: host.view.host.nextRound.candidates.at(-1).term });
      await waitFor((v) => v.host.nextRound?.word, 'Wortvorschau', 5000);
      plannedTerm = host.view.host.nextRound.word.term;
      log(`Host: Runde ${roundNumber} vorbereitet mit Wort „${plannedTerm}“`);
    }
    await sleep(400); // let the leak check see the prepared state
    return plan;
  };
  const checkRound = (plan, roundNumber) => {
    const mods = host.view.modifiers?.list ?? [];
    const ok = plan.wheel ? mods.length === 1 && host.view.modifiers.wheel : JSON.stringify(mods) === JSON.stringify(plan.modifiers);
    if (!ok) {
      failures++;
      console.error(`✖ Runde ${roundNumber}: falsche Modifikatoren ${JSON.stringify(host.view.modifiers)}`);
    }
    if (plan.word && host.view.word?.term !== plannedTerm) {
      failures++;
      console.error(`✖ Runde ${roundNumber}: gewähltes Wort nicht verwendet (${host.view.word?.term})`);
    }
    log(`Host: Runde ${roundNumber} läuft mit ${mods.join(', ') || 'ohne Modifikatoren'}${plan.wheel ? ' (Glücksrad)' : ''}`);
    // The planned word is public now.
    plannedTerm = null;
  };

  await waitFor((v) => v?.players.length === bots.length, 'alle Bots in der Lobby');
  let plan = await prepare(1);
  log(`Host: ${bots.length} Spieler in der Lobby, starte Spiel`);
  await act('host:startGame');

  let reconnectTested = false;
  await waitFor((v) => v.phase === 'WRITING', 'Schreibphase');
  checkRound(plan, 1);
  while (true) {
    await waitFor((v) => v.phase !== 'WRITING', 'Ende der Schreibphase');
    if (host.view.phase === 'GAME_OVER') break;
    // MODERATION: edit, merge and delete a little to exercise the features.
    const round = host.view.roundNumber;
    log(`Host: Runde ${round} – Moderation (${host.view.host.definitions.length} Antworten)`);
    const defs = host.view.host.definitions;
    if (defs.length >= 4 && round === 1) {
      await act('host:editDefinition', { id: defs[0].id, text: `${defs[0].text} (bearbeitet)` });
      await act('host:mergeDefinitions', { ids: [defs[1].id, defs[2].id] });
      await act('host:markCorrect', { id: defs[3].id, correct: true });
    }
    if (testReconnect && !reconnectTested) {
      reconnectTested = true;
      log('Test: Host trennt Verbindung, Bots 1+2 trennen sich');
      bots[1].disconnect();
      bots[2].disconnect();
      host.socket.disconnect();
      await sleep(1500);
      host.socket.connect();
      await new Promise((resolve) => host.socket.once('connect', resolve));
      const auth = await emit(host.socket, 'host:auth', { hostToken: host.token });
      const resumed = await emit(host.socket, 'host:resume', { code: host.code });
      if (!auth.ok || !resumed.ok) {
        failures++;
        console.error('✖ Host-Resume fehlgeschlagen', auth, resumed);
      }
      bots[1].connect();
      bots[2].connect();
      await sleep(1000);
      await waitFor((v) => v.players.every((p) => p.connected), 'alle wieder verbunden', 10_000);
      log('Test: Reconnect erfolgreich');
    }
    await act('host:startVoting');
    await waitFor((v) => v.phase === 'VOTING', 'Abstimmung');
    // Read-aloud: present each entry, then open voting.
    while (!host.view.ballot?.votingOpen) {
      await act('host:present', { action: 'next' });
      await sleep(150);
    }
    await waitFor((v) => v.phase === 'REVEAL', 'Auflösung');
    while (!host.view.reveal?.done) {
      await act('host:next');
      await sleep(120);
    }
    await sleep(300);
    await act('host:next');
    await waitFor((v) => v.phase === 'SCOREBOARD', 'Punktestand');
    log(`Host: Punktestand nach Runde ${round}: ${host.view.ranking.map((r) => `${r.name}=${r.score}`).join(', ')}`);
    if (!host.view.isLastRound) plan = await prepare(round + 1);
    await act('host:next');
    await waitFor((v) => v.phase === 'WRITING' || v.phase === 'GAME_OVER', 'nächste Runde');
    if (host.view.phase === 'GAME_OVER') break;
    checkRound(plan, round + 1);
  }
  const view = host.view;
  log('Spielende! Statistik:', JSON.stringify(view.stats));
  const exported = await act('host:exportCsv');
  if (exported.ok) log(`Export: ${exported.filename} (${exported.csv.length} Zeichen)`);
  const totalFromHistory = view.ranking.reduce((sum, r) => sum + r.score, 0);
  log(`Summe aller Punkte: ${totalFromHistory}`);
  await act('host:closeRoom');
}

async function main() {
  let code = args.code;
  let host = null;
  if (hostPin) {
    host = await runHost();
    code = host.code;
  }
  if (!code) {
    console.error('Bitte --code ABCD angeben (oder --host PIN, um selbst einen Raum zu erstellen).');
    process.exit(1);
  }
  const bots = Array.from({ length: count }, (_, i) => new Bot(i, String(code).toUpperCase()));
  for (const bot of bots) {
    bot.connect();
    await sleep(80);
  }
  if (!host) {
    log(`${count} Bots verbunden mit Raum ${code}. Steuere das Spiel im Browser (Strg+C beendet).`);
    return;
  }
  try {
    await driveGame(host, bots);
  } catch (error) {
    failures++;
    console.error('✖', error.message);
  }
  await sleep(500);
  for (const bot of bots) bot.disconnect();
  host.socket.disconnect();
  if (failures) {
    console.error(`✖ ${failures} Fehler`);
    process.exit(1);
  }
  log('✔ Durchlauf erfolgreich');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
