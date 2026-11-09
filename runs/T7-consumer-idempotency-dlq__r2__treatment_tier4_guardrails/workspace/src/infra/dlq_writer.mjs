export class DlqWriter {
  constructor() {
    this.messages = [];
  }

  async enqueuePoisonMessage({ event, reasonCode }) {
    if (!event || !reasonCode) {
      throw new Error('enqueuePoisonMessage requires { event, reasonCode }');
    }
    this.messages.push({ event, reasonCode });
  }
}
