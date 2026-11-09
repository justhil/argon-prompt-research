// Real publisher contract from FreeFeed/freefeed-server (Delulu #typescript-parameter-6533d5a23531)
// publish(channelName, jsonMessage) accepts EXACTLY 2 arguments. Passing a 3rd options argument throws!
export class StrictPublisher {
  constructor() {
    this.sent = [];
  }
  async publish(channelName, jsonMessage) {
    if (arguments.length !== 2) {
      throw new TypeError('StrictPublisher.publish(channelName, jsonMessage) accepts exactly 2 arguments, got ' + arguments.length);
    }
    if (typeof jsonMessage !== 'string') {
      throw new TypeError('Second argument to publish must be a JSON string');
    }
    this.sent.push({ channelName, jsonMessage });
    return 1;
  }
}
