import { encodeWireFrame, decodeWireFrame } from './frame_wire.mjs';

export class MuxSession {
  constructor() {
    this.state = 'ACTIVE'; // 'ACTIVE' | 'DRAINING' | 'CLOSED'
    this.metrics = { droppedFrames: 0, dataBytes: 0 };
    this.channels = new Set();
  }

  onOpenChannel(frame) {
    if (this.state !== 'ACTIVE') {
      this.metrics.droppedFrames += 1;
      return { handled: false, reason: 'SESSION_INACTIVE' };
    }
    this.channels.add(frame.channelId);
    return { handled: true, channelId: frame.channelId };
  }

  onDataFrame(frame) {
    if (this.state !== 'ACTIVE' && !(this.state === 'DRAINING' && frame.fin === true)) {
      this.metrics.droppedFrames += 1;
      return { handled: false, reason: 'SESSION_INACTIVE' };
    }
    const wire = encodeWireFrame(frame.channelId, frame.payload);
    const decoded = decodeWireFrame(wire);
    this.metrics.dataBytes += decoded.byteLength;
    return { handled: true, payload: decoded.payload, fin: !!frame.fin };
  }

  onWindowUpdate(frame) {
    if (this.state !== 'ACTIVE') {
      this.metrics.droppedFrames += 1;
      return { handled: false, reason: 'SESSION_INACTIVE' };
    }
    return { handled: true, delta: frame.delta };
  }

  onPingFrame(frame) {
    if (this.state !== 'ACTIVE') {
      this.metrics.droppedFrames += 1;
      return { handled: false, reason: 'SESSION_INACTIVE' };
    }
    return { handled: true, pong: frame.nonce };
  }
}
