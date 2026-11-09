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
    while (this.pendingRooms.length > 0) {
      const pendingRoom = this.pendingRooms.shift();
      const pendingChannel = pendingRoom.startsWith('room:') ? pendingRoom : `room:${pendingRoom}`;
      await this.publisher.publish(pendingChannel, json);
    }
    await this.publisher.publish(channel, json);
    return { published: true, channel };
  }
}
