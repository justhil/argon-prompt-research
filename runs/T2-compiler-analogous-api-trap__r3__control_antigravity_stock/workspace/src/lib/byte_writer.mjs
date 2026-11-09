export class ByteWriter {
  constructor() {
    this.chunks = [];
  }

  putU32(val) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(val >>> 0, 0);
    this.chunks.push(b);
  }

  toHex() {
    return Buffer.concat(this.chunks).toString('hex');
  }
}
