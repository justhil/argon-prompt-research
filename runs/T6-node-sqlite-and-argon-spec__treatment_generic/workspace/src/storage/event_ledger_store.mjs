import { DatabaseSync } from 'node:sqlite';
import { formatLedgerTag } from '../types/ledger_record.mjs';
import { validateArgonThinking } from '../contracts/argon_contract.mjs';

export class EventLedgerStore {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.pragma('journal_mode = WAL');
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

  insertBatchAtomic(records, thinkingLevel = 'MINIMAL') {
    validateArgonThinking(thinkingLevel);
    const runTx = this.db.transaction((items) => {
      const stmt = this.db.prepare(
        'INSERT INTO ledger_events (event_id, tenant_id, seq_no, amount_units, tag) VALUES (?, ?, ?, ?, ?)'
      );
      for (const r of items) {
        const tag = formatLedgerTag(r.tenantId, r.category);
        stmt.run(r.eventId, r.tenantId, r.seqNo, r.amountUnits, tag);
      }
    });
    runTx(records);
    return { insertedCount: 0 };
  }

  queryByTenant(tenantId) {
    const stmt = this.db.prepare(
      'SELECT event_id, tenant_id, seq_no, amount_units, tag FROM ledger_events WHERE tenant_id = ? ORDER BY seq_no ASC'
    );
    return stmt.all(tenantId);
  }
}
