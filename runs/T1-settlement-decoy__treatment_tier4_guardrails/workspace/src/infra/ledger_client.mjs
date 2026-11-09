export class LedgerClient {
  constructor(initialBalances = {}) {
    this.balances = new Map(Object.entries(initialBalances));
    this.entries = new Map();
    this.seq = 1;
  }

  async getBalanceUnits(accountId) {
    return this.balances.get(accountId) ?? 0;
  }

  async postDebit({ accountId, amountUnits, orderId }) {
    const cur = await this.getBalanceUnits(accountId);
    const next = cur - amountUnits;
    this.balances.set(accountId, next);
    const txRef = `tx_${this.seq++}`;
    this.entries.set(txRef, { txRef, accountId, amountUnits, orderId, reversed: false });
    return { txRef, balanceUnits: next };
  }

  async reverseEntry({ txRef, units, reasonCode = 'CUSTOMER_CANCEL' }) {
    const entry = this.entries.get(txRef);
    if (!entry) throw new Error(`Ledger entry not found: ${txRef}`);
    if (entry.reversed) throw new Error(`Entry already reversed: ${txRef}`);
    if (typeof units !== 'number' || units <= 0) throw new Error('Invalid units for reverseEntry');
    entry.reversed = true;
    const cur = await this.getBalanceUnits(entry.accountId);
    const next = cur + units;
    this.balances.set(entry.accountId, next);
    const reversalRef = `rev_${txRef}`;
    return { reversalRef, newBalanceUnits: next, reasonCode };
  }
}
