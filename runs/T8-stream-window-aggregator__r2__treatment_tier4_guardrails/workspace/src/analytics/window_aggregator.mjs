export class WindowAggregator {
  constructor({ stateBackend, metricSink }) {
    this.stateBackend = stateBackend;
    this.metricSink = metricSink;
  }

  recordSample(windowKey, value) {
    const cur = this.stateBackend.readWindowState(windowKey) || { sum: 0, count: 0 };
    cur.sum += value;
    cur.count += 1;
    this.stateBackend.writeWindowState(windowKey, cur);
  }

  flushWindow(windowKey) {
    const bucket = this.stateBackend.readWindowState(windowKey);
    if (!bucket || bucket.count === 0) {
      return { flushed: false };
    }
    const meanValue = bucket.sum / bucket.count;
    this.metricSink.publishDataPoint({ windowKey, meanValue, sampleCount: bucket.count });
    this.stateBackend.evictWindowState(windowKey);
    return { flushed: true, meanValue, sampleCount: bucket.count };
  }
}
