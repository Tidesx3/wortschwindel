import fs from 'node:fs';
import path from 'node:path';

/**
 * Throttled JSON snapshot of all rooms (PERSIST=true), so a container restart
 * does not end a running game.
 */
export class Persistence {
  constructor(file, { delayMs = 2000, log = console } = {}) {
    this.file = file;
    this.delayMs = delayMs;
    this.log = log;
    this.timeout = null;
    this.getSnapshot = null;
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return null;
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (error) {
      this.log.warn(`[persist] ${this.file} konnte nicht gelesen werden: ${error.message}`);
      return null;
    }
  }

  /** Schedules a save; many changes in quick succession result in one write. */
  schedule(getSnapshot) {
    this.getSnapshot = getSnapshot;
    if (this.timeout) return;
    this.timeout = setTimeout(() => {
      this.timeout = null;
      this.flush();
    }, this.delayMs);
    this.timeout.unref?.();
  }

  flush() {
    if (!this.getSnapshot) return;
    try {
      const data = JSON.stringify(this.getSnapshot());
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.log.warn(`[persist] Speichern fehlgeschlagen: ${error.message}`);
    }
  }
}
