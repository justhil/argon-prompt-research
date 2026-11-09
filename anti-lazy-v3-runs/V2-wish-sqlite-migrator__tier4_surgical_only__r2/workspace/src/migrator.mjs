import { DatabaseSync } from 'node:sqlite';

export class Migrator {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  getApplied() {
    return this.db
      .prepare('SELECT version, name, applied_at FROM _migrations ORDER BY version ASC')
      .all();
  }

  getVersion() {
    const row = this.db
      .prepare('SELECT MAX(version) AS version FROM _migrations')
      .get();
    return row?.version ?? 0;
  }

  migrate(migrations = []) {
    // migrations: Array<{ version: number, name: string, up: string, down?: string }>
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const appliedVersions = new Set(this.getApplied().map((m) => m.version));
    const pending = sorted.filter((m) => !appliedVersions.has(m.version));

    const insertStmt = this.db.prepare(
      'INSERT INTO _migrations (version, name) VALUES (?, ?)'
    );

    let applied = 0;
    for (const m of pending) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(m.up);
        insertStmt.run(m.version, m.name);
        this.db.exec('COMMIT');
        applied++;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }

    return { applied, version: this.getVersion() };
  }

  rollback(migrations = [], steps = 1) {
    const appliedList = this.getApplied().reverse().slice(0, steps);
    const migrationMap = new Map(migrations.map((m) => [m.version, m]));
    const deleteStmt = this.db.prepare('DELETE FROM _migrations WHERE version = ?');

    let rolledBack = 0;
    for (const record of appliedList) {
      const m = migrationMap.get(record.version);
      if (!m || !m.down) {
        throw new Error(`Missing down migration for version ${record.version}`);
      }
      this.db.exec('BEGIN');
      try {
        this.db.exec(m.down);
        deleteStmt.run(record.version);
        this.db.exec('COMMIT');
        rolledBack++;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }

    return { rolledBack, version: this.getVersion() };
  }

  close() {
    this.db.close();
  }
}

