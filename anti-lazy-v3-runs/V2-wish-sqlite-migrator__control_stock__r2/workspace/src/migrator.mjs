import { DatabaseSync } from 'node:sqlite';

export class Migrator {
  constructor(dbPath = ':memory:', options = {}) {
    this.tableName = options.tableName || '_migrations';
    this.db = dbPath instanceof DatabaseSync ? dbPath : new DatabaseSync(dbPath);
    this.#init();
  }

  #init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        down TEXT,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  #validateMigrations(migrations) {
    if (!Array.isArray(migrations)) {
      throw new TypeError('migrations must be an array');
    }
    const seen = new Set();
    for (const m of migrations) {
      if (!m || typeof m.version !== 'number' || !Number.isInteger(m.version) || m.version < 1) {
        throw new Error(`Invalid migration version: ${m?.version}`);
      }
      if (!m.name || typeof m.name !== 'string') {
        throw new Error(`Invalid migration name for version ${m.version}`);
      }
      if (!m.up || typeof m.up !== 'string') {
        throw new Error(`Missing "up" SQL for migration ${m.version} (${m.name})`);
      }
      if (seen.has(m.version)) {
        throw new Error(`Duplicate migration version: ${m.version}`);
      }
      seen.add(m.version);
    }
  }

  getApplied() {
    const stmt = this.db.prepare(
      `SELECT version, name, applied_at FROM ${this.tableName} ORDER BY version ASC`
    );
    return stmt.all();
  }

  getCurrentVersion() {
    const stmt = this.db.prepare(
      `SELECT MAX(version) as version FROM ${this.tableName}`
    );
    const row = stmt.get();
    return row?.version ?? 0;
  }

  status(migrations = []) {
    this.#validateMigrations(migrations);
    const applied = this.getApplied();
    const appliedMap = new Map(applied.map((m) => [m.version, m]));
    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const pending = sorted
      .filter((m) => !appliedMap.has(m.version))
      .map(({ version, name }) => ({ version, name }));

    return {
      currentVersion: this.getCurrentVersion(),
      applied,
      pending,
    };
  }

  migrate(migrations, { targetVersion = Infinity } = {}) {
    this.#validateMigrations(migrations);

    const appliedRows = this.db
      .prepare(`SELECT version, name FROM ${this.tableName}`)
      .all();
    const appliedMap = new Map(appliedRows.map((r) => [r.version, r.name]));

    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const insertStmt = this.db.prepare(
      `INSERT INTO ${this.tableName} (version, name, down) VALUES (?, ?, ?)`
    );

    const newlyApplied = [];

    for (const m of sorted) {
      if (m.version > targetVersion) break;

      if (appliedMap.has(m.version)) {
        const existingName = appliedMap.get(m.version);
        if (existingName !== m.name) {
          throw new Error(
            `Migration version ${m.version} name mismatch: expected "${existingName}", got "${m.name}"`
          );
        }
        continue;
      }

      this.db.exec('BEGIN');
      try {
        this.db.exec(m.up);
        insertStmt.run(m.version, m.name, m.down ?? null);
        this.db.exec('COMMIT');
        newlyApplied.push(m.version);
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(
          `Migration ${m.version} (${m.name}) failed: ${err.message}`,
          { cause: err }
        );
      }
    }

    return {
      applied: newlyApplied.length,
      versions: newlyApplied,
      currentVersion: this.getCurrentVersion(),
    };
  }

  rollback(migrationsOrSteps = 1, steps = 1) {
    let migrations = [];
    let count = 1;

    if (Array.isArray(migrationsOrSteps)) {
      migrations = migrationsOrSteps;
      count = typeof steps === 'number' ? steps : 1;
    } else if (typeof migrationsOrSteps === 'number') {
      count = migrationsOrSteps;
    }

    if (count < 1) {
      return {
        rolledBack: 0,
        versions: [],
        currentVersion: this.getCurrentVersion(),
      };
    }

    const migrationMap = new Map(migrations.map((m) => [m.version, m]));
    const appliedRows = this.db
      .prepare(
        `SELECT version, name, down FROM ${this.tableName} ORDER BY version DESC LIMIT ?`
      )
      .all(count);

    const deleteStmt = this.db.prepare(
      `DELETE FROM ${this.tableName} WHERE version = ?`
    );

    const rolledBack = [];

    for (const row of appliedRows) {
      const downSql = migrationMap.get(row.version)?.down ?? row.down;
      if (!downSql || typeof downSql !== 'string') {
        throw new Error(
          `Cannot rollback migration ${row.version} (${row.name}): missing "down" SQL`
        );
      }

      this.db.exec('BEGIN');
      try {
        this.db.exec(downSql);
        deleteStmt.run(row.version);
        this.db.exec('COMMIT');
        rolledBack.push(row.version);
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(
          `Rollback ${row.version} (${row.name}) failed: ${err.message}`,
          { cause: err }
        );
      }
    }

    return {
      rolledBack: rolledBack.length,
      versions: rolledBack,
      currentVersion: this.getCurrentVersion(),
    };
  }

  close() {
    this.db.close();
  }
}
