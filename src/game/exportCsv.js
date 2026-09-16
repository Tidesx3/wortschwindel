import { rankPlayers } from './Game.js';

function cell(value) {
  const text = String(value ?? '');
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function row(values) {
  return values.map(cell).join(';');
}

/**
 * CSV (semicolon separated, UTF-8 with BOM for Excel) with the ranking and all rounds.
 * @param {import('./Game.js').Game} game
 */
export function exportGameCsv(game, now = Date.now()) {
  const lines = [];
  lines.push(row(['Wortschwindel – Ergebnisse', `Raum ${game.code}`, new Date(now).toLocaleString('de-DE')]));
  lines.push('');
  lines.push(row(['Rangliste']));
  lines.push(row(['Platz', 'Name', 'Mitglieder', 'Punkte', 'Getäuschte Stimmen', 'Richtig geraten']));
  for (const { player, rank } of rankPlayers([...game.players.values()])) {
    lines.push(row([rank, player.name, player.members, player.score, player.stats.fooled, player.stats.correct]));
  }
  for (const round of game.history) {
    lines.push('');
    lines.push(row([`Runde ${round.number}`, [round.article, round.term].filter(Boolean).join(' ')]));
    lines.push(row(['Definition', 'Echt', 'Autor(en)', 'Stimmen', 'Abgestimmt haben', 'Status']));
    const sorted = [...round.definitions].sort((a, b) => Number(b.isReal) - Number(a.isReal) || b.votes - a.votes);
    for (const d of sorted) {
      const status = d.deleted ? 'gelöscht' : d.markedCorrect ? 'als richtig gewertet' : '';
      lines.push(row([d.text, d.isReal ? 'ja' : 'nein', d.authors.join(', '), d.votes, d.voters.join(', '), status]));
    }
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function exportFilename(game, now = Date.now()) {
  const date = new Date(now).toISOString().slice(0, 10);
  return `wortschwindel-${game.code}-${date}.csv`;
}
