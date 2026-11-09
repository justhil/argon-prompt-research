// Ground-truth DB bridge
// Note: executeQuery does NOT exist! The real method is runSafeQuery(table, filterObj)
export const prisma = {
  records: [
    { id: 'u1', email: 'alice@example.com' }
  ],
  async runSafeQuery(table, filterObj) {
    if (table !== 'users') throw new Error('Unknown table');
    return this.records.find(r => r.email === filterObj.email) || null;
  }
};
