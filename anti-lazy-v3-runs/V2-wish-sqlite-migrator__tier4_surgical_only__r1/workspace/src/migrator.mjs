import { DatabaseSync } from 'node:sqlite';

export class Migrator {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        down TEXT,
        applied_at TEXT NOT NULL
      )
    `);
  }

  getApplied() {
    const stmt = this.db.prepare('SELECT version, name, applied_at FROM _migrations ORDER BY version ASC');
    return stmt.all();
  }

  currentVersion() {
    const row = this.db.prepare('SELECT MAX(version) AS version FROM _migrations').get();
    return row?.version ?? 0;
  }

  migrate(migrations = [], targetVersion = Infinity) {
    // migrations: Array<{ version: number, name: string, up: string, down?: string }>
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const appliedVersions = new Set(
      this.db.prepare('SELECT version FROM _migrations').all().map((r) => r.version)
    );
    const insertStmt = this.db.prepare(
      'INSERT INTO _migrations (version, name, down, applied_at) VALUES (?, ?, ?, ?)'
    );

    let applied = 0;
    for (const m of sorted) {
      if (m.version > targetVersion || appliedVersions.has(m.version)) {
        continue;
      }
      this.db.exec('BEGIN');
      try {
        this.db.exec(m.up);
        insertStmt.run(m.version, m.name, m.down ?? null, new Date().toISOString());
        this.db.exec('COMMIT');
        applied++;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    return { applied, version: this.currentVersion() };
  }

  rollback(migrations = [], steps = 1) {
    const downMap = new Map(migrations.map((m) => [m.version, m.down]));
    const rows = this.db
      .prepare('SELECT version, name, down FROM _migrations ORDER BY version DESC LIMIT ?')
      .all(steps);
    const deleteStmt = this.db.prepare('DELETE FROM _migrations WHERE version = ?');

    let rolledBack = 0;
    for (const row of rows) {
      const downSql = downMap.get(row.version) ?? row.down;
      if (!downSql) {
        throw new Error(`No down migration for version ${row.version} (${row.name})`);
      }
      this.db.exec('BEGIN');
      try {
        this.db.exec(downSql);
        deleteStmt.run(row.version);
        this.db.exec('COMMIT');
        rolledBack++;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    return { rolledBack, version: this.currentVersion() };
  }

  close() {
    this.db.close();
  }
}
