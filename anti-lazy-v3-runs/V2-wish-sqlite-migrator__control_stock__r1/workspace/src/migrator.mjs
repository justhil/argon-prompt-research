import { DatabaseSync } from 'node:sqlite';

export class Migrator {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this._ensureMigrationsTable();
  }

  _ensureMigrationsTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        down TEXT,
        applied_at TEXT NOT NULL
      )
    `);
  }

  getAppliedMigrations() {
    const stmt = this.db.prepare(
      'SELECT version, name, applied_at FROM _migrations ORDER BY version ASC'
    );
    return stmt.all();
  }

  getCurrentVersion() {
    const stmt = this.db.prepare('SELECT MAX(version) AS version FROM _migrations');
    const row = stmt.get();
    return row?.version ?? 0;
  }

  migrate(migrations = []) {
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const appliedSet = new Set(
      this.getAppliedMigrations().map((m) => m.version)
    );

    const checkStmt = this.db.prepare('SELECT 1 FROM _migrations WHERE version = ?');
    const insertStmt = this.db.prepare(
      'INSERT INTO _migrations (version, name, down, applied_at) VALUES (?, ?, ?, ?)'
    );

    let appliedCount = 0;
    const appliedVersions = [];

    for (const m of sorted) {
      if (appliedSet.has(m.version) || checkStmt.get(m.version)) {
        continue;
      }

      this.db.exec('BEGIN');
      try {
        this.db.exec(m.up);
        insertStmt.run(
          m.version,
          m.name ?? `v${m.version}`,
          m.down ?? null,
          new Date().toISOString()
        );
        this.db.exec('COMMIT');
        appliedCount++;
        appliedVersions.push(m.version);
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }

    return { applied: appliedCount, versions: appliedVersions };
  }

  rollback(migrations = [], targetVersion = null) {
    const migrationMap = new Map(migrations.map((m) => [m.version, m]));
    const applied = this.db
      .prepare('SELECT version, name, down FROM _migrations ORDER BY version DESC')
      .all();

    if (applied.length === 0) {
      return { rolledBack: 0, versions: [] };
    }

    const toRollback =
      targetVersion === null
        ? [applied[0]]
        : applied.filter((m) => m.version > targetVersion);

    const deleteStmt = this.db.prepare('DELETE FROM _migrations WHERE version = ?');
    let rolledBackCount = 0;
    const rolledBackVersions = [];

    for (const item of toRollback) {
      const downSql = migrationMap.get(item.version)?.down ?? item.down;
      if (!downSql) {
        throw new Error(`Migration v${item.version} (${item.name}) does not define a "down" script.`);
      }

      this.db.exec('BEGIN');
      try {
        this.db.exec(downSql);
        deleteStmt.run(item.version);
        this.db.exec('COMMIT');
        rolledBackCount++;
        rolledBackVersions.push(item.version);
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }

    return { rolledBack: rolledBackCount, versions: rolledBackVersions };
  }

  close() {
    this.db.close();
  }
}
