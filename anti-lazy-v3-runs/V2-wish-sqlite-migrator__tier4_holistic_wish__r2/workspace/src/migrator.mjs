import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export class MigrationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    Object.assign(this, details);
  }
}

export class Migrator {
  /**
   * @param {string | DatabaseSync} dbOrPath
   * @param {object} [options]
   * @param {string} [options.tableName='_schema_migrations']
   */
  constructor(dbOrPath = ':memory:', options = {}) {
    if (dbOrPath && typeof dbOrPath === 'object' && typeof dbOrPath.exec === 'function') {
      this.db = dbOrPath;
      this.ownsDb = false;
    } else {
      this.db = new DatabaseSync(dbOrPath);
      this.ownsDb = true;
    }

    const tableName = options.tableName || '_schema_migrations';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new MigrationError(`Invalid migration table name: ${tableName}`, 'INVALID_TABLE_NAME');
    }
    this.tableName = tableName;
    this._inProgress = false;

    this._ensureMigrationTable();
  }

  _ensureMigrationTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${this.tableName}" (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        down_sql TEXT,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  /**
   * Compute deterministic SHA-256 checksum for a migration's SQL content.
   * Normalizes line endings to LF and trims outer whitespace.
   */
  static computeChecksum(upSql) {
    if (typeof upSql !== 'string') {
      throw new MigrationError('Migration "up" SQL must be a string', 'INVALID_MIGRATION');
    }
    const normalized = upSql.replace(/\r\n/g, '\n').trim();
    return createHash('sha256').update(normalized, 'utf8').digest('hex');
  }

  /**
   * Validate and sort migrations in ascending order by version.
   */
  _validateAndSort(migrations) {
    if (!Array.isArray(migrations)) {
      throw new MigrationError('Migrations must be an array', 'INVALID_MIGRATIONS');
    }

    const seenVersions = new Set();
    const normalized = migrations.map((m, idx) => {
      if (!m || typeof m !== 'object') {
        throw new MigrationError(`Migration at index ${idx} must be an object`, 'INVALID_MIGRATION');
      }
      const { version, name, up, down } = m;
      if (!Number.isInteger(version) || version < 1) {
        throw new MigrationError(
          `Migration version must be a positive integer (got ${version})`,
          'INVALID_VERSION',
          { version }
        );
      }
      if (seenVersions.has(version)) {
        throw new MigrationError(
          `Duplicate migration version detected: ${version}`,
          'DUPLICATE_VERSION',
          { version }
        );
      }
      seenVersions.add(version);

      if (typeof name !== 'string' || !name.trim()) {
        throw new MigrationError(
          `Migration v${version} must have a non-empty string name`,
          'INVALID_NAME',
          { version }
        );
      }
      if (typeof up !== 'string' || !up.trim()) {
        throw new MigrationError(
          `Migration v${version} (${name}) must have a non-empty "up" SQL string`,
          'INVALID_UP_SQL',
          { version, name }
        );
      }
      if (down !== undefined && down !== null && typeof down !== 'string') {
        throw new MigrationError(
          `Migration v${version} (${name}) "down" must be a string if provided`,
          'INVALID_DOWN_SQL',
          { version, name }
        );
      }

      return {
        version,
        name: name.trim(),
        up,
        down: down ?? null,
        checksum: Migrator.computeChecksum(up),
      };
    });

    normalized.sort((a, b) => a.version - b.version);
    return normalized;
  }

  /**
   * Return all applied migrations ordered by version ascending.
   */
  getAppliedMigrations() {
    this._ensureMigrationTable();
    const stmt = this.db.prepare(
      `SELECT version, name, checksum, down_sql AS down, applied_at AS appliedAt
       FROM "${this.tableName}"
       ORDER BY version ASC`
    );
    return stmt.all().map((row) => ({ ...row }));
  }

  /**
   * Get the current database schema version (0 if no migrations applied).
   */
  getCurrentVersion() {
    this._ensureMigrationTable();
    const stmt = this.db.prepare(`SELECT MAX(version) AS version FROM "${this.tableName}"`);
    const row = stmt.get();
    return row && row.version !== null ? Number(row.version) : 0;
  }

  /**
   * Verify integrity of already-applied migrations against provided definitions:
   * - Detects checksum drift (modified `up` SQL after application)
   * - Detects name mismatch
   * - Detects missing historical migrations that were previously applied
   */
  _verifyAppliedIntegrity(sortedMigrations, appliedMap, { allowMissing = false } = {}) {
    const providedMap = new Map(sortedMigrations.map((m) => [m.version, m]));

    for (const [version, applied] of appliedMap.entries()) {
      const provided = providedMap.get(version);
      if (!provided) {
        if (!allowMissing) {
          throw new MigrationError(
            `Applied migration v${version} (${applied.name}) is missing from provided migrations list`,
            'MISSING_APPLIED_MIGRATION',
            { version, name: applied.name }
          );
        }
        continue;
      }

      if (provided.checksum !== applied.checksum) {
        throw new MigrationError(
          `Checksum mismatch for applied migration v${version} (${applied.name}): expected ${applied.checksum}, got ${provided.checksum}`,
          'CHECKSUM_MISMATCH',
          {
            version,
            name: applied.name,
            expectedChecksum: applied.checksum,
            actualChecksum: provided.checksum,
          }
        );
      }

      if (provided.name !== applied.name) {
        throw new MigrationError(
          `Name mismatch for applied migration v${version}: expected "${applied.name}", got "${provided.name}"`,
          'NAME_MISMATCH',
          { version, expectedName: applied.name, actualName: provided.name }
        );
      }
    }
  }

  /**
   * Run pending migrations up to an optional `targetVersion`.
   * Executes each migration atomically inside a transaction (SAVEPOINT) so any
   * failure rolls back the failed migration cleanly.
   *
   * @param {Array<{ version: number, name: string, up: string, down?: string }>} migrations
   * @param {object} [options]
   * @param {number} [options.targetVersion] - Optional maximum version to migrate up to
   * @param {boolean} [options.allowOutOfOrder=false] - Whether to allow applying migrations older than current max version
   * @param {boolean} [options.allowMissing=false] - Whether to ignore applied migrations missing from input list
   * @param {boolean} [options.transactionalBatch=false] - If true, wraps the entire batch in a single transaction
   */
  migrate(migrations, options = {}) {
    if (this._inProgress) {
      throw new MigrationError('A migration operation is already in progress', 'MIGRATION_IN_PROGRESS');
    }

    this._inProgress = true;
    try {
      this._ensureMigrationTable();
      const sorted = this._validateAndSort(migrations);
      const {
        targetVersion = Infinity,
        allowOutOfOrder = false,
        allowMissing = false,
        transactionalBatch = false,
      } = options;

      const appliedList = this.getAppliedMigrations();
      const appliedMap = new Map(appliedList.map((m) => [m.version, m]));
      const maxAppliedVersion = appliedList.length > 0 ? appliedList[appliedList.length - 1].version : 0;

      this._verifyAppliedIntegrity(sorted, appliedMap, { allowMissing });

      const pending = [];
      for (const m of sorted) {
        if (m.version > targetVersion) continue;
        if (appliedMap.has(m.version)) continue;

        if (!allowOutOfOrder && m.version < maxAppliedVersion) {
          throw new MigrationError(
            `Out-of-order migration v${m.version} (${m.name}) detected; current version is v${maxAppliedVersion}`,
            'OUT_OF_ORDER_MIGRATION',
            { version: m.version, name: m.name, currentVersion: maxAppliedVersion }
          );
        }
        pending.push(m);
      }

      const appliedVersions = [];
      const insertStmt = this.db.prepare(`
        INSERT INTO "${this.tableName}" (version, name, checksum, down_sql, applied_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      const applySingle = (m) => {
        const sp = `sp_migrate_v${m.version}`;
        this.db.exec(`SAVEPOINT ${sp}`);
        try {
          this.db.exec(m.up);
          insertStmt.run(
            m.version,
            m.name,
            m.checksum,
            m.down,
            new Date().toISOString()
          );
          this.db.exec(`RELEASE SAVEPOINT ${sp}`);
          appliedVersions.push(m.version);
        } catch (err) {
          try {
            this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
            this.db.exec(`RELEASE SAVEPOINT ${sp}`);
          } catch {
            // Ignore secondary rollback error if transaction was aborted by SQLite
          }
          throw new MigrationError(
            `Failed to apply migration v${m.version} (${m.name}): ${err.message}`,
            'MIGRATION_EXECUTION_FAILED',
            { version: m.version, name: m.name, cause: err }
          );
        }
      };

      if (pending.length > 0) {
        if (transactionalBatch) {
          const batchSp = 'sp_migrate_batch';
          this.db.exec(`SAVEPOINT ${batchSp}`);
          try {
            for (const m of pending) {
              applySingle(m);
            }
            this.db.exec(`RELEASE SAVEPOINT ${batchSp}`);
          } catch (err) {
            try {
              this.db.exec(`ROLLBACK TO SAVEPOINT ${batchSp}`);
              this.db.exec(`RELEASE SAVEPOINT ${batchSp}`);
            } catch {
              // Ignore
            }
            appliedVersions.length = 0;
            throw err;
          }
        } else {
          for (const m of pending) {
            applySingle(m);
          }
        }
      }

      return {
        applied: appliedVersions.length,
        appliedVersions,
        skipped: sorted.filter((m) => m.version <= targetVersion && appliedMap.has(m.version)).length,
        currentVersion: this.getCurrentVersion(),
      };
    } finally {
      this._inProgress = false;
    }
  }

  /**
   * Roll back applied migrations.
   * Can roll back by `steps` (default: 1) or down to a specific `targetVersion` (>= 0).
   * Uses `down` SQL from either the provided `migrations` list or the stored `down_sql` in the migration table.
   *
   * @param {Array<{ version: number, name: string, up?: string, down?: string }> | object} [migrationsOrOptions]
   * @param {object} [maybeOptions]
   * @param {number} [maybeOptions.steps=1] - Number of migrations to roll back (ignored if targetVersion is specified)
   * @param {number} [maybeOptions.targetVersion] - Target schema version to roll back down to (0 rolls back all)
   */
  rollback(migrationsOrOptions = [], maybeOptions = {}) {
    if (this._inProgress) {
      throw new MigrationError('A migration operation is already in progress', 'MIGRATION_IN_PROGRESS');
    }

    let migrations = [];
    let options = maybeOptions;
    if (Array.isArray(migrationsOrOptions)) {
      migrations = migrationsOrOptions;
    } else if (migrationsOrOptions && typeof migrationsOrOptions === 'object') {
      options = migrationsOrOptions;
    }

    this._inProgress = true;
    try {
      this._ensureMigrationTable();

      const providedDownMap = new Map();
      for (const m of migrations) {
        if (m && Number.isInteger(m.version) && typeof m.down === 'string') {
          providedDownMap.set(m.version, m.down);
        }
      }

      const appliedDesc = [...this.getAppliedMigrations()].sort((a, b) => b.version - a.version);
      if (appliedDesc.length === 0) {
        return {
          rolledBack: 0,
          rolledBackVersions: [],
          currentVersion: 0,
        };
      }

      let toRollback;
      if (options.targetVersion !== undefined) {
        if (!Number.isInteger(options.targetVersion) || options.targetVersion < 0) {
          throw new MigrationError(
            `Invalid targetVersion for rollback: ${options.targetVersion}`,
            'INVALID_TARGET_VERSION',
            { targetVersion: options.targetVersion }
          );
        }
        toRollback = appliedDesc.filter((m) => m.version > options.targetVersion);
      } else {
        const steps = options.steps ?? 1;
        if (!Number.isInteger(steps) || steps < 1) {
          throw new MigrationError(
            `Rollback steps must be a positive integer (got ${steps})`,
            'INVALID_STEPS',
            { steps }
          );
        }
        toRollback = appliedDesc.slice(0, steps);
      }

      const deleteStmt = this.db.prepare(`DELETE FROM "${this.tableName}" WHERE version = ?`);
      const rolledBackVersions = [];

      for (const m of toRollback) {
        const downSql = providedDownMap.get(m.version) ?? m.down;
        if (typeof downSql !== 'string' || !downSql.trim()) {
          throw new MigrationError(
            `Cannot roll back migration v${m.version} (${m.name}): no "down" SQL available`,
            'MISSING_DOWN_SQL',
            { version: m.version, name: m.name }
          );
        }

        const sp = `sp_rollback_v${m.version}`;
        this.db.exec(`SAVEPOINT ${sp}`);
        try {
          this.db.exec(downSql);
          deleteStmt.run(m.version);
          this.db.exec(`RELEASE SAVEPOINT ${sp}`);
          rolledBackVersions.push(m.version);
        } catch (err) {
          try {
            this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
            this.db.exec(`RELEASE SAVEPOINT ${sp}`);
          } catch {
            // Ignore secondary rollback error
          }
          throw new MigrationError(
            `Failed to roll back migration v${m.version} (${m.name}): ${err.message}`,
            'ROLLBACK_EXECUTION_FAILED',
            { version: m.version, name: m.name, cause: err }
          );
        }
      }

      return {
        rolledBack: rolledBackVersions.length,
        rolledBackVersions,
        currentVersion: this.getCurrentVersion(),
      };
    } finally {
      this._inProgress = false;
    }
  }

  /**
   * Return migration status summary comparing available migrations with applied ones.
   */
  status(migrations = []) {
    this._ensureMigrationTable();
    const sorted = this._validateAndSort(migrations);
    const appliedList = this.getAppliedMigrations();
    const appliedMap = new Map(appliedList.map((m) => [m.version, m]));

    const pending = sorted
      .filter((m) => !appliedMap.has(m.version))
      .map(({ version, name, checksum }) => ({ version, name, checksum }));

    return {
      currentVersion: this.getCurrentVersion(),
      applied: appliedList,
      pending,
    };
  }

  /**
   * Close the underlying SQLite connection if owned by this Migrator instance.
   */
  close() {
    if (this.db && typeof this.db.close === 'function') {
      this.db.close();
    }
  }
}
