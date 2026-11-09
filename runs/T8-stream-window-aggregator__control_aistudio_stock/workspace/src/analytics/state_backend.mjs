export class StateBackend {
  constructor() {
    this.windows = new Map();
  }

  readWindowState(windowKey) {
    return this.windows.get(windowKey) || null;
  }

  writeWindowState(windowKey, stateObj) {
    if (!windowKey || typeof stateObj?.sum !== 'number') {
      throw new Error('writeWindowState requires valid windowKey and { sum, count }');
    }
    this.windows.set(windowKey, stateObj);
  }

  evictWindowState(windowKey) {
    this.windows.delete(windowKey);
  }
}
