export class WindowAggregator {
  constructor({ stateBackend, metricSink }) {
    this.stateBackend = stateBackend;
    this.metricSink = metricSink;
  }

  recordSample(windowKey, value) {
    const cur = this.stateBackend.loadBucket(windowKey) || { sum: 0, count: 0 };
    cur.sum += value;
    cur.count += 1;
    this.stateBackend.saveBucket(windowKey, cur);
  }

  flushWindow(windowKey) {
    const bucket = this.stateBackend.loadBucket(windowKey);
    if (!bucket || bucket.count === 0) {
      return { flushed: false };
    }
    const meanValue = bucket.sum / bucket.count;
    this.metricSink.emitMetric(windowKey, meanValue, bucket.count);
    this.stateBackend.deleteBucket(windowKey);
    return { flushed: true, meanValue, sampleCount: bucket.count };
  }
}
