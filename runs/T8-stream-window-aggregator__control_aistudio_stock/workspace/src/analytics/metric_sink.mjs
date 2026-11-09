export class MetricSink {
  constructor() {
    this.points = [];
  }

  publishDataPoint({ windowKey, meanValue, sampleCount }) {
    if (!windowKey || typeof meanValue !== 'number' || typeof sampleCount !== 'number') {
      throw new Error('publishDataPoint requires { windowKey, meanValue, sampleCount }');
    }
    this.points.push({ windowKey, meanValue, sampleCount });
  }
}
