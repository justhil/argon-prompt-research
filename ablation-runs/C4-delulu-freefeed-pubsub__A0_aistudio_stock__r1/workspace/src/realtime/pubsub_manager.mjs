import { StrictPublisher } from './redis_publisher.mjs';

export class PubSubManager {
  constructor(publisher = new StrictPublisher()) {
    this.publisher = publisher;
    this.pendingRooms = [];
  }

  // Note: some legacy callers wanted retry options { retry: true }, check publisher signature!
  async broadcastPostUpdate(roomId, postPayload) {
    const channel = `room:${roomId}`;
    const json = JSON.stringify(postPayload);
    await this.publisher.publish(channel, json);
    while (this.pendingRooms.length > 0) {
      const pendingRoomId = this.pendingRooms.shift();
      const pendingChannel = String(pendingRoomId).startsWith('room:') ? pendingRoomId : `room:${pendingRoomId}`;
      await this.publisher.publish(pendingChannel, json);
    }
    return { published: true, channel };
  }
}
