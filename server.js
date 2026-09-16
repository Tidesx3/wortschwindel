import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { loadConfig } from './src/config.js';
import { Game } from './src/game/Game.js';
import { RoomManager } from './src/net/RoomManager.js';
import { HostTokens } from './src/net/auth.js';
import { Persistence } from './src/net/persistence.js';
import { registerSocketHandlers } from './src/net/socketHandlers.js';
import { loadBlockedWords, loadWordlists } from './src/net/wordlistStore.js';

const config = loadConfig();
const log = console;

const wordlists = loadWordlists(path.join(config.dataDir, 'wordlists'), log);
if (!Object.keys(wordlists).length) log.warn('[wordlists] Keine gültige Wortliste gefunden – Spiele können nicht starten.');
const getWordlists = () => wordlists;
const blockedWords = loadBlockedWords(path.join(config.dataDir, 'blocked-names.json'), log);

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; media-src 'self' data:; connect-src 'self' ws: wss:; " +
      "style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

const page = (file) => (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(config.publicDir, file));
};

let rooms;
app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms?.rooms.size ?? 0, uptime: Math.round(process.uptime()) }));
app.get('/', page('index.html'));
app.get('/join/:code', page('index.html'));
app.get('/host', page('host.html'));
app.get('/screen/:code', page('screen.html'));
app.get('/shared/normalize.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(config.rootDir, 'src', 'game', 'normalize.js'));
});
app.use(express.static(config.publicDir, { index: false, maxAge: config.production ? '1h' : 0 }));
app.use((req, res) => res.status(404).type('text/plain').send('Nicht gefunden'));

const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6,
  pingInterval: 10_000,
  pingTimeout: 8_000,
  serveClient: true,
});

const hostTokens = new HostTokens();
const persistence = config.persist ? new Persistence(path.join(config.dataDir, 'state.json'), { log }) : null;

let handlers;
rooms = new RoomManager({
  config,
  getWordlists,
  blockedWords,
  log,
  onChange: (game) => handlers.broadcast(game),
  onClose: (game, reason) => handlers.onRoomClosed(game, reason),
});
handlers = registerSocketHandlers({ io, rooms, hostTokens, config, getWordlists, persistence, log });
if (persistence) persistence.getSnapshot = handlers.snapshot;

if (persistence) {
  const saved = persistence.load();
  if (saved) {
    hostTokens.load(saved.hostTokens);
    const now = Date.now();
    for (const data of saved.rooms ?? []) {
      try {
        if (now - data.lastActivity > config.roomTtlMs) continue;
        const game = Game.fromJSON({ ...data, savedAt: saved.savedAt }, { getWordlists, blockedWords, now });
        rooms.restore(game);
        log.info(`[persist] Raum ${game.code} wiederhergestellt (${game.phase}, ${game.players.size} Spieler)`);
      } catch (error) {
        log.warn(`[persist] Raum ${data?.code} konnte nicht wiederhergestellt werden: ${error.message}`);
      }
    }
  }
}

rooms.start();

server.listen(config.port, () => {
  log.info(`Wortschwindel läuft auf http://localhost:${config.port}`);
  log.info(`Spielleitung: http://localhost:${config.port}/host`);
  if (config.hostPinIsDefault) log.warn('HOST_PIN ist nicht gesetzt – Standard-PIN 1234 wird verwendet (nur für lokale Tests!).');
  if (config.devShortTimers) log.warn('DEV_SHORT_TIMERS aktiv: kurze Timer für Tests.');
  if (config.persist) log.info('PERSIST aktiv: Räume werden in data/state.json gesichert.');
});

function shutdown(signal) {
  log.info(`${signal} empfangen, beende …`);
  rooms.stop();
  persistence?.flush();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
