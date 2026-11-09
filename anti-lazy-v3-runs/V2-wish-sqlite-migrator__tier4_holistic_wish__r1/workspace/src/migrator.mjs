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
   * @param {boolean} [options.validateChecksums=true]
   * @param {boolean} [options.allowOutOfOrder=false]
   */
  constructor(dbOrPath = ':memory:', options = {}) {
    if (dbOrPath && typeof dbOrPath === 'object' && typeof dbOrPath.exec === 'function') {
      this.db = dbOrPath;
      this._ownsDb = false;
    } else {
      this.db = new DatabaseSync(dbOrPath);
      this._ownsDb = true;
    }

    const tableName = options.tableName ?? '_schema_migrations';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new MigrationError(`Invalid migration table name: ${tableName}`, 'INVALID_TABLE_NAME');
    }

    this.tableName = tableName;
    this.validateChecksums = options.validateChecksums ?? true;
    this.allowOutOfOrder = options.allowOutOfOrder ?? false;
    this._inProgress = false;

    this._ensureSchemaTable();
  }

  _ensureSchemaTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${this.tableName}" (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        up_sql TEXT NOT NULL,
        down_sql TEXT,
        applied_at TEXT NOT NULL,
        execution_time_ms INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  /**
   * Compute deterministic SHA-256 checksum for a migration's SQL/definition.
   * Normalizes CRLF to LF and trims outer whitespace so platform line-endings don't cause false drift.
   */
  static computeChecksum(migration) {
    const normalizedUp = String(migration.up ?? '').replace(/\r\n/g, '\n').trim();
    const normalizedName = String(migration.name ?? '').trim();
    return createHash('sha256')
      .update(`${migration.version}:${normalizedName}:${normalizedUp}`, 'utf8')
      .digest('hex');
  }

  /**
   * Validate and normalize an array of migration definitions, sorted ascending by version.
   */
  _normalizeMigrations(migrations) {
    if (!Array.isArray(migrations)) {
      throw new MigrationError('Migrations must be an array', 'INVALID_MIGRATIONS');
    }

    const seenVersions = new Set();
    const normalized = migrations.map((m, idx) => {
      if (!m || typeof m !== 'object') {
        throw new MigrationError(`Migration at index ${idx} must be an object`, 'INVALID_MIGRATION');
      }
      const version = Number(m.version);
      if (!Number.isInteger(version) || version < 0) {
        throw new MigrationError(
          `Invalid migration version at index ${idx}: ${m.version} (must be a non-negative integer)`,
          'INVALID_VERSION',
          { version: m.version }
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

      const name = String(m.name ?? `migration_${version}`).trim();
      if (!name) {
        throw new MigrationError(
          `Migration version ${version} is missing a valid name`,
          'INVALID_NAME',
          { version }
        );
      }

      if (typeof m.up !== 'string' || !m.up.trim()) {
        throw new MigrationError(
          `Migration ${version} (${name}) must have a non-empty 'up' SQL string`,
          'INVALID_UP_SQL',
          { version, name }
        );
      }

      if (m.down !== undefined && m.down !== null && typeof m.down !== 'string') {
        throw new MigrationError(
          `Migration ${version} (${name}) 'down' must be a SQL string if provided`,
          'INVALID_DOWN_SQL',
          { version, name }
        );
      }

      const item = {
        version,
        name,
        up: m.up,
        down: m.down ?? null,
      };
      item.checksum = Migrator.computeChecksum(item);
      return item;
    });

    // Sort by version ascending
    normalized.sort((a, b) => a.version - b.version);
    return normalized;
  }

  /**
   * Returns all applied migrations ordered by version ascending.
   */
  getAppliedMigrations() {
    this._ensureSchemaTable();
    const stmt = this.db.prepare(
      `SELECT version, name, checksum, up_sql AS up, down_sql AS down, applied_at AS appliedAt, execution_time_ms AS executionTimeMs
       FROM "${this.tableName}"
       ORDER BY version ASC`
    );
    return stmt.all().map((row) => ({ ...row }));
  }

  /**
   * Returns current schema version (highest applied version, or 0 if none applied).
   */
  getCurrentVersion() {
    this._ensureSchemaTable();
    const stmt = this.db.prepare(`SELECT MAX(version) AS version FROM "${this.tableName}"`);
    const row = stmt.get();
    return row && row.version !== null && row.version !== undefined ? Number(row.version) : 0;
  }

  /**
   * Verify integrity of already-applied migrations against the provided definitions.
   */
  verify(migrations, options = {}) {
    const normalized = this._normalizeMigrations(migrations);
    const applied = this.getAppliedMigrations();
    const byVersion = new Map(normalized.map((m) => [m.version, m]));
    const checkDrift = options.validateChecksums ?? this.validateChecksums;
    const allowMissing = options.allowMissing ?? false;

    for (const record of applied) {
      const def = byVersion.get(record.version);
      if (!def) {
        if (!allowMissing) {
          throw new MigrationError(
            `Applied migration version ${record.version} (${record.name}) is missing from provided migrations list`,
            'MISSING_APPLIED_MIGRATION',
            { version: record.version, name: record.name }
          );
        }
        continue;
      }

      if (checkDrift && record.checksum !== def.checksum) {
        throw new MigrationError(
          `Checksum mismatch for applied migration version ${record.version} (${record.name}): expected ${record.checksum}, got ${def.checksum}`,
          'CHECKSUM_MISMATCH',
          {
            version: record.version,
            name: record.name,
            expectedChecksum: record.checksum,
            actualChecksum: def.checksum,
          }
        );
      }
    }

    return true;
  }

  /**
   * Get detailed migration status including current version, applied list, and pending list.
   */
  status(migrations = []) {
    const normalized = this._normalizeMigrations(migrations);
    const applied = this.getAppliedMigrations();
    const appliedMap = new Map(applied.map((a) => [a.version, a]));

    const pending = normalized
      .filter((m) => !appliedMap.has(m.version))
      .map(({ version, name, checksum }) => ({ version, name, checksum }));

    return {
      currentVersion: this.getCurrentVersion(),
      applied: applied.map(({ version, name, checksum, appliedAt, executionTimeMs }) => ({
        version,
        name,
        checksum,
        appliedAt,
        executionTimeMs,
      })),
      pending,
    };
  }

  /**
   * Run pending migrations up to `options.targetVersion` (if specified).
   * Each migration is executed atomically inside a transaction (or savepoint) along with its tracking record.
   *
   * @param {Array<{ version: number, name: string, up: string, down?: string }>} migrations
   * @param {object} [options]
   * @param {number} [options.targetVersion] - Stop at this version (inclusive)
   * @param {boolean} [options.validateChecksums] - Override checksum validation
   * @param {boolean} [options.allowOutOfOrder] - Allow applying migrations older than highest applied version
   * @param {boolean} [options.dryRun=false] - Validate and compute pending migrations without applying
   */
  migrate(migrations, options = {}) {
    if (this._inProgress) {
      throw new MigrationError('A migration operation is already in progress', 'MIGRATION_IN_PROGRESS');
    }

    this._inProgress = true;
    try {
      this._ensureSchemaTable();
      const normalized = this._normalizeMigrations(migrations);
      const validateChecksums = options.validateChecksums ?? this.validateChecksums;
      const allowOutOfOrder = options.allowOutOfOrder ?? this.allowOutOfOrder;
      const targetVersion = options.targetVersion;
      const dryRun = options.dryRun ?? false;

      // Verify existing applied migrations for checksum drift / missing definitions
      this.verify(normalized, { validateChecksums });

      const appliedRecords = this.getAppliedMigrations();
      const appliedVersions = new Set(appliedRecords.map((r) => r.version));
      const maxAppliedVersion = appliedRecords.length > 0
        ? appliedRecords[appliedRecords.length - 1].version
        : -1;

      const toApply = [];
      for (const m of normalized) {
        if (targetVersion !== undefined && m.version > targetVersion) {
          continue;
        }
        if (appliedVersions.has(m.version)) {
          continue;
        }
        if (!allowOutOfOrder && m.version < maxAppliedVersion) {
          throw new MigrationError(
            `Out-of-order migration detected: version ${m.version} (${m.name}) is lower than already applied version ${maxAppliedVersion}`,
            'OUT_OF_ORDER_MIGRATION',
            { version: m.version, name: m.name, maxAppliedVersion }
          );
        }
        toApply.push(m);
      }

      if (dryRun) {
        return {
          applied: 0,
          appliedVersions: [],
          migrations: toApply.map((m) => ({ version: m.version, name: m.name })),
          currentVersion: this.getCurrentVersion(),
          dryRun: true,
        };
      }

      const insertStmt = this.db.prepare(`
        INSERT INTO "${this.tableName}" (version, name, checksum, up_sql, down_sql, applied_at, execution_time_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const appliedVersionsList = [];
      const appliedDetails = [];

      for (const m of toApply) {
        const spName = `sp_migrate_up_${m.version}`;
        const start = performance.now();
        this.db.exec(`SAVEPOINT "${spName}"`);
        try {
          this.db.exec(m.up);
          const durationMs = Math.max(0, Math.round(performance.now() - start));
          const appliedAt = new Date().toISOString();
          insertStmt.run(
            m.version,
            m.name,
            m.checksum,
            m.up,
            m.down,
            appliedAt,
            durationMs
          );
          this.db.exec(`RELEASE SAVEPOINT "${spName}"`);
          appliedVersionsList.push(m.version);
          appliedDetails.push({
            version: m.version,
            name: m.name,
            checksum: m.checksum,
            appliedAt,
            executionTimeMs: durationMs,
          });
        } catch (err) {
          try {
            this.db.exec(`ROLLBACK TO SAVEPOINT "${spName}"`);
            this.db.exec(`RELEASE SAVEPOINT "${spName}"`);
          } catch {
            // Ignore secondary rollback errors if transaction was already aborted by SQLite
          }
          throw new MigrationError(
            `Failed to apply migration ${m.version} (${m.name}): ${err.message}`,
            'MIGRATION_UP_FAILED',
            { version: m.version, name: m.name, cause: err }
          );
        }
      }

      return {
        applied: appliedVersionsList.length,
        appliedVersions: appliedVersionsList,
        migrations: appliedDetails,
        currentVersion: this.getCurrentVersion(),
      };
    } finally {
      this._inProgress = false;
    }
  }

  /**
   * Roll back applied migrations.
   * Can roll back by `steps` (default 1) or down to `targetVersion` (exclusive: targetVersion remains applied; use 0 to roll back all).
   * Uses `down` SQL from provided `migrations` array or falls back to stored `down_sql` in the tracking table.
   *
   * @param {Array<{ version: number, name: string, up?: string, down?: string }> | object} [migrationsOrOptions=[]]
   * @param {object} [maybeOptions={}]
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
      this._ensureSchemaTable();

      const providedMap = new Map();
      if (migrations.length > 0) {
        for (const m of migrations) {
          if (m && typeof m === 'object' && Number.isInteger(Number(m.version))) {
            providedMap.set(Number(m.version), m);
          }
        }
      }

      const appliedDesc = [...this.getAppliedMigrations()].sort((a, b) => b.version - a.version);
      if (appliedDesc.length === 0) {
        return {
          rolledBack: 0,
          rolledBackVersions: [],
          migrations: [],
          currentVersion: 0,
        };
      }

      let toRollback = [];
      if (options.targetVersion !== undefined) {
        const target = Number(options.targetVersion);
        if (!Number.isInteger(target) || target < 0) {
          throw new MigrationError(
            `Invalid targetVersion for rollback: ${options.targetVersion}`,
            'INVALID_TARGET_VERSION'
          );
        }
        toRollback = appliedDesc.filter((r) => r.version > target);
      } else {
        const steps = options.steps ?? 1;
        if (!Number.isInteger(steps) || steps <= 0) {
          throw new MigrationError(
            `Invalid rollback steps: ${steps} (must be a positive integer)`,
            'INVALID_STEPS'
          );
        }
        toRollback = appliedDesc.slice(0, steps);
      }

      // Pre-validate that every migration to roll back has a valid `down` script
      const resolvedRollbacks = toRollback.map((record) => {
        const provided = providedMap.get(record.version);
        const downSql = provided?.down ?? record.down;
        if (typeof downSql !== 'string' || !downSql.trim()) {
          throw new MigrationError(
            `Cannot roll back migration ${record.version} (${record.name}): no 'down' SQL provided`,
            'MISSING_DOWN_SQL',
            { version: record.version, name: record.name }
          );
        }
        return {
          version: record.version,
          name: record.name,
          down: downSql,
        };
      });

      const deleteStmt = this.db.prepare(`DELETE FROM "${this.tableName}" WHERE version = ?`);
      const rolledBackVersions = [];
      const rolledBackDetails = [];

      for (const item of resolvedRollbacks) {
        const spName = `sp_migrate_down_${item.version}`;
        this.db.exec(`SAVEPOINT "${spName}"`);
        try {
          this.db.exec(item.down);
          deleteStmt.run(item.version);
          this.db.exec(`RELEASE SAVEPOINT "${spName}"`);
          rolledBackVersions.push(item.version);
          rolledBackDetails.push({ version: item.version, name: item.name });
        } catch (err) {
          try {
            this.db.exec(`ROLLBACK TO SAVEPOINT "${spName}"`);
            this.db.exec(`RELEASE SAVEPOINT "${spName}"`);
          } catch {
            // Ignore secondary rollback error
          }
          throw new MigrationError(
            `Failed to roll back migration ${item.version} (${item.name}): ${err.message}`,
            'MIGRATION_DOWN_FAILED',
            { version: item.version, name: item.name, cause: err }
          );
        }
      }

      return {
        rolledBack: rolledBackVersions.length,
        rolledBackVersions,
        migrations: rolledBackDetails,
        currentVersion: this.getCurrentVersion(),
      };
    } finally {
      this._inProgress = false;
    }
  }

  /**
   * Close the underlying database connection if opened by this Migrator.
   */
  close() {
    if (this.db && typeof this.db.close === 'function') {
      this.db.close();
    }
  }
}
