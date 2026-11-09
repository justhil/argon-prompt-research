export class ScheduleManager {
  constructor(prefix = 'ayako:sched') {
    this.prefix = prefix;
  }

  async scheduleBatchExpirations(commander, items) {
    for (const item of items) {
      const expireSec = Math.round(item.expireMs / 1000);
      commander.setex(`${this.prefix}:${item.key}`, expireSec, 'true');
    }
    return await commander.exec();
  }
}
