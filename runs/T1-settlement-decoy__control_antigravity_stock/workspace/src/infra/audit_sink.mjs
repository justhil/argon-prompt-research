export class AuditSink {
  constructor() {
    this.envelopes = [];
  }

  async writeEnvelope({ category, subjectId, metadata = {} }) {
    if (!category || !subjectId) {
      throw new Error('AuditSink.writeEnvelope requires category and subjectId');
    }
    const env = { category, subjectId, metadata, ts: Date.now() };
    this.envelopes.push(env);
    return env;
  }
}
