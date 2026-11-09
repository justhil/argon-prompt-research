import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export class MigrationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MigrationError';
    Object.assign(this, details);
  }
}

export class Migrator {
  /**
   * @param {string | DatabaseSync} dbOrPath - SQLite database path or existing DatabaseSync instance
   * @param {object} [options]
   * @param {string} [options.tableName='_migrations'] - Name of the migration tracking table
   * @param {boolean} [options.allowOutOfOrder=false] - Allow applying migrations older than the latest applied version
   * @param {boolean} [options.verifyChecksums=true] - Verify checksums of already-applied migrations
   */
  constructor(dbOrPath = ':memory:', options = {}) {
    if (dbOrPath && typeof dbOrPath === 'object' && typeof dbOrPath.exec === 'function') {
      this.db = dbOrPath;
      this._ownsDb = false;
    } else {
      this.db = new DatabaseSync(dbOrPath);
      this._ownsDb = true;
    }

    const tableName = options.tableName ?? '_migrations';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new MigrationError(`Invalid migration table name: "${tableName}"`);
    }

    this.tableName = tableName;
    this.allowOutOfOrder = Boolean(options.allowOutOfOrder ?? false);
    this.verifyChecksums = Boolean(options.verifyChecksums ?? true);

    this._init();
  }

  _init() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${this.tableName}" (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        down_sql TEXT,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        execution_time_ms INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  /**
   * Compute deterministic SHA-256 checksum for a migration's SQL content.
   * @param {object} migration
   * @returns {string}
   */
  static computeChecksum(migration) {
    const normalizedUp = String(migration.up ?? '').trim();
    const normalizedName = String(migration.name ?? '').trim();
    return createHash('sha256')
      .update(`${String(migration.version)}:${normalizedName}:${normalizedUp}`, 'utf8')
      .digest('hex');
  }

  _computeChecksum(migration) {
    return Migrator.computeChecksum(migration);
  }

  _compareVersions(a, b) {
    const numA = Number(a);
    const numB = Number(b);
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
      if (numA !== numB) return numA - numB;
    }
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  /**
   * Validate and normalize migrations list, sorted by version ascending.
   * @param {Array<{ version: number | string, name: string, up: string | ((db: DatabaseSync) => void), down?: string | ((db: DatabaseSync) => void) }>} migrations
   */
  _validateAndNormalize(migrations) {
    if (!Array.isArray(migrations)) {
      throw new MigrationError('Migrations must be an array');
    }

    const seenVersions = new Set();
    const normalized = migrations.map((m, idx) => {
      if (!m || typeof m !== 'object') {
        throw new MigrationError(`Invalid migration at index ${idx}: must be an object`);
      }
      if (m.version === undefined || m.version === null || String(m.version).trim() === '') {
        throw new MigrationError(`Migration at index ${idx} is missing a valid "version"`);
      }
      if (typeof m.name !== 'string' || m.name.trim() === '') {
        throw new MigrationError(`Migration "${m.version}" is missing a valid "name"`);
      }
      if (
        (typeof m.up !== 'string' || m.up.trim() === '') &&
        typeof m.up !== 'function'
      ) {
        throw new MigrationError(`Migration "${m.version}" (${m.name}) must have a non-empty "up" SQL string or function`);
      }
      if (
        m.down !== undefined &&
        m.down !== null &&
        typeof m.down !== 'string' &&
        typeof m.down !== 'function'
      ) {
        throw new MigrationError(`Migration "${m.version}" (${m.name}) has an invalid "down" script`);
      }

      const versionKey = String(m.version).trim();
      if (seenVersions.has(versionKey)) {
        throw new MigrationError(`Duplicate migration version detected: "${versionKey}"`, {
          version: versionKey,
        });
      }
      seenVersions.add(versionKey);

      const item = {
        version: versionKey,
        rawVersion: m.version,
        name: m.name.trim(),
        up: m.up,
        down: m.down ?? null,
      };
      item.checksum = this._computeChecksum(item);
      return item;
    });

    normalized.sort((a, b) => this._compareVersions(a.rawVersion, b.rawVersion));
    return normalized;
  }

  /**
   * Get all applied migrations from the database in ascending version order.
   */
  getAppliedMigrations() {
    const stmt = this.db.prepare(
      `SELECT version, name, checksum, down_sql AS down, applied_at AS appliedAt, execution_time_ms AS executionTimeMs
       FROM "${this.tableName}"`
    );
    const rows = stmt.all().map((row) => ({ ...row }));
    rows.sort((a, b) => this._compareVersions(a.version, b.version));
    return rows;
  }

  /**
   * Verify integrity of applied migrations against provided definitions.
   * Checks for checksum mismatches, name tampering, missing migration definitions, and out-of-order migrations.
   */
  validate(migrations, options = {}) {
    const normalized = this._validateAndNormalize(migrations);
    const applied = this.getAppliedMigrations();
    const appliedMap = new Map(applied.map((r) => [String(r.version), r]));
    const definedMap = new Map(normalized.map((m) => [m.version, m]));

    const verifyChecksums = options.verifyChecksums ?? this.verifyChecksums;
    const allowOutOfOrder = options.allowOutOfOrder ?? this.allowOutOfOrder;
    const allowMissing = Boolean(options.allowMissing ?? false);

    // 1. Check that all applied migrations exist in definitions and match checksum
    for (const record of applied) {
      const def = definedMap.get(record.version);
      if (!def) {
        if (!allowMissing) {
          throw new MigrationError(
            `Applied migration "${record.version}" (${record.name}) is missing from provided migrations list`,
            { version: record.version, code: 'MISSING_APPLIED_MIGRATION' }
          );
        }
        continue;
      }

      if (verifyChecksums && record.checksum !== def.checksum) {
        throw new MigrationError(
          `Checksum mismatch for applied migration "${record.version}" (${record.name}): expected ${record.checksum}, got ${def.checksum}`,
          {
            version: record.version,
            expectedChecksum: record.checksum,
            actualChecksum: def.checksum,
            code: 'CHECKSUM_MISMATCH',
          }
        );
      }
    }

    // 2. Check for out-of-order unapplied migrations
    if (!allowOutOfOrder && applied.length > 0) {
      const highestAppliedVersion = applied[applied.length - 1].version;
      for (const m of normalized) {
        if (!appliedMap.has(m.version) && this._compareVersions(m.version, highestAppliedVersion) < 0) {
          throw new MigrationError(
            `Out-of-order migration detected: pending migration "${m.version}" (${m.name}) is older than latest applied migration "${highestAppliedVersion}"`,
            {
              version: m.version,
              highestAppliedVersion,
              code: 'OUT_OF_ORDER_MIGRATION',
            }
          );
        }
      }
    }

    return { valid: true, appliedCount: applied.length, totalCount: normalized.length };
  }

  _runInTransaction(fn) {
    this.db.exec('SAVEPOINT migrator_tx;');
    try {
      const result = fn();
      this.db.exec('RELEASE SAVEPOINT migrator_tx;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK TO SAVEPOINT migrator_tx;');
        this.db.exec('RELEASE SAVEPOINT migrator_tx;');
      } catch {
        // Ignore rollback cleanup errors if transaction was already aborted by SQLite
      }
      throw err;
    }
  }

  _executeStep(step) {
    if (typeof step === 'function') {
      step(this.db);
    } else if (typeof step === 'string') {
      this.db.exec(step);
    } else {
      throw new MigrationError('Invalid migration step: must be a SQL string or function');
    }
  }

  /**
   * Apply pending migrations atomically (per migration) with validation and idempotency.
   * @param {Array<{ version: number | string, name: string, up: string | Function, down?: string | Function }>} migrations
   * @param {object} [options]
   * @param {number | string} [options.targetVersion] - Stop migrating at this version (inclusive)
   * @param {boolean} [options.dryRun=false] - Validate and compute pending migrations without applying
   */
  migrate(migrations, options = {}) {
    const normalized = this._validateAndNormalize(migrations);
    this.validate(normalized, options);

    const applied = this.getAppliedMigrations();
    const appliedVersions = new Set(applied.map((r) => String(r.version)));

    const targetVersion =
      options.targetVersion !== undefined && options.targetVersion !== null
        ? String(options.targetVersion).trim()
        : null;

    if (targetVersion !== null && !normalized.some((m) => m.version === targetVersion)) {
      throw new MigrationError(`Target version "${targetVersion}" not found in migrations`, {
        targetVersion,
        code: 'TARGET_VERSION_NOT_FOUND',
      });
    }

    const pending = normalized.filter((m) => {
      if (appliedVersions.has(m.version)) return false;
      if (targetVersion !== null && this._compareVersions(m.version, targetVersion) > 0) {
        return false;
      }
      return true;
    });

    const skippedCount = normalized.filter((m) => appliedVersions.has(m.version)).length;

    if (options.dryRun) {
      return {
        applied: 0,
        skipped: skippedCount,
        pending: pending.map((m) => m.version),
        migrations: [],
      };
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO "${this.tableName}" (version, name, checksum, down_sql, execution_time_ms)
      VALUES (?, ?, ?, ?, ?)
    `);

    const newlyApplied = [];

    for (const m of pending) {
      const startTime = performance.now();
      try {
        this._runInTransaction(() => {
          this._executeStep(m.up);
          const elapsed = Math.max(0, Math.round(performance.now() - startTime));
          const downSql = typeof m.down === 'string' ? m.down : null;
          insertStmt.run(m.version, m.name, m.checksum, downSql, elapsed);
        });
        newlyApplied.push(m.version);
      } catch (err) {
        throw new MigrationError(
          `Failed to apply migration "${m.version}" (${m.name}): ${err.message}`,
          {
            version: m.version,
            migrationName: m.name,
            cause: err,
            appliedBeforeFailure: newlyApplied,
            code: 'MIGRATION_EXECUTION_FAILED',
          }
        );
      }
    }

    return {
      applied: newlyApplied.length,
      skipped: skippedCount,
      migrations: newlyApplied,
    };
  }

  /**
   * Rollback applied migrations.
   * Supports rolling back by `steps` (default 1) or down to `targetVersion` (exclusive; `'0'` or `null` with steps rolls back).
   * Can use either the provided `migrations` array or stored `down_sql` from the database.
   *
   * @param {Array | object} [migrationsOrOptions]
   * @param {object} [maybeOptions]
   */
  rollback(migrationsOrOptions = [], maybeOptions = {}) {
    let migrations = [];
    let options = maybeOptions;

    if (Array.isArray(migrationsOrOptions)) {
      migrations = migrationsOrOptions;
    } else if (migrationsOrOptions && typeof migrationsOrOptions === 'object') {
      options = migrationsOrOptions;
      migrations = options.migrations ?? [];
    }

    const normalized = migrations.length > 0 ? this._validateAndNormalize(migrations) : [];
    const definedMap = new Map(normalized.map((m) => [m.version, m]));

    const applied = this.getAppliedMigrations();
    if (applied.length === 0) {
      return { rolledBack: 0, migrations: [] };
    }

    // Reverse order: latest applied first
    const appliedDesc = [...applied].reverse();

    let toRollback = [];
    if (options.targetVersion !== undefined && options.targetVersion !== null) {
      const target = String(options.targetVersion).trim();
      toRollback = appliedDesc.filter((r) => this._compareVersions(r.version, target) > 0);
    } else if (options.all === true) {
      toRollback = appliedDesc;
    } else {
      const steps = options.steps ?? 1;
      if (!Number.isInteger(steps) || steps < 1) {
        throw new MigrationError(`Invalid rollback steps: ${steps}. Must be a positive integer.`);
      }
      toRollback = appliedDesc.slice(0, steps);
    }

    const deleteStmt = this.db.prepare(`DELETE FROM "${this.tableName}" WHERE version = ?`);
    const rolledBackVersions = [];

    for (const record of toRollback) {
      const def = definedMap.get(record.version);
      const downStep = def?.down ?? record.down;

      if (!downStep || (typeof downStep === 'string' && downStep.trim() === '')) {
        throw new MigrationError(
          `Cannot rollback migration "${record.version}" (${record.name}): no "down" migration script provided or stored`,
          {
            version: record.version,
            migrationName: record.name,
            code: 'MISSING_DOWN_MIGRATION',
          }
        );
      }

      try {
        this._runInTransaction(() => {
          this._executeStep(downStep);
          deleteStmt.run(record.version);
        });
        rolledBackVersions.push(record.version);
      } catch (err) {
        throw new MigrationError(
          `Failed to rollback migration "${record.version}" (${record.name}): ${err.message}`,
          {
            version: record.version,
            migrationName: record.name,
            cause: err,
            rolledBackBeforeFailure: rolledBackVersions,
            code: 'ROLLBACK_EXECUTION_FAILED',
          }
        );
      }
    }

    return {
      rolledBack: rolledBackVersions.length,
      migrations: rolledBackVersions,
    };
  }

  /**
   * Return the current status of applied and pending migrations.
   * @param {Array} [migrations=[]]
   */
  status(migrations = []) {
    const normalized = migrations.length > 0 ? this._validateAndNormalize(migrations) : [];
    const applied = this.getAppliedMigrations();
    const appliedMap = new Map(applied.map((r) => [String(r.version), r]));

    const pending = normalized
      .filter((m) => !appliedMap.has(m.version))
      .map((m) => ({
        version: m.version,
        name: m.name,
        checksum: m.checksum,
      }));

    const currentVersion = applied.length > 0 ? applied[applied.length - 1].version : null;

    return {
      currentVersion,
      applied,
      pending,
    };
  }

  /**
   * Close the underlying database connection.
   */
  close() {
    if (this.db && typeof this.db.close === 'function') {
      this.db.close();
    }
  }
}
