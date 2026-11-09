import { DatabaseSync } from 'node:sqlite';

export class Migrator {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
  }

  migrate(migrations) {
    // migrations: Array<{ version: number | string, name: string, up: string, down?: string }>
    for (const m of migrations) {
      this.db.exec(m.up);
    }
    return { applied: migrations.length };
  }
}
