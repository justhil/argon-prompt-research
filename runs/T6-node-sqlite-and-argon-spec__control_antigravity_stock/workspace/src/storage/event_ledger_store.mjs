import { DatabaseSync } from 'node:sqlite';
import { serializeTag } from '../types/ledger_record.mjs';
import { validateArgonThinking } from '../contracts/argon_contract.mjs';

export class EventLedgerStore {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_events (
        event_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        seq_no INTEGER NOT NULL,
        amount_units INTEGER NOT NULL,
        tag TEXT NOT NULL
      )
    `);
  }

  insertBatchAtomic(records, thinkingLevel = 'HIGH') {
    validateArgonThinking(thinkingLevel);
    const stmt = this.db.prepare(
      'INSERT INTO ledger_events (event_id, tenant_id, seq_no, amount_units, tag) VALUES (?, ?, ?, ?, ?)'
    );
    let insertedCount = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of records) {
        const tag = serializeTag({ tenantId: r.tenantId, category: r.category, version: r.version });
        const result = stmt.run(r.eventId, r.tenantId, r.seqNo, r.amountUnits, tag);
        insertedCount += Number(result.changes);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { insertedCount };
  }

  queryByTenant(tenantId) {
    const stmt = this.db.prepare(
      'SELECT event_id, tenant_id, seq_no, amount_units, tag FROM ledger_events WHERE tenant_id = ? ORDER BY seq_no ASC'
    );
    return stmt.all(tenantId);
  }
}
