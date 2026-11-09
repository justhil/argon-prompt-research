// Ground-truth clipboard driver
// Note: writeFormatted does NOT exist! The only method is copyText(str) accepting 1 argument.
export const clipboardDriver = {
  lastCopied: null,
  async copyText(str) {
    if (arguments.length !== 1 || typeof str !== 'string') {
      throw new TypeError('copyText(str) accepts exactly 1 string argument');
    }
    this.lastCopied = str;
    return true;
  }
};
