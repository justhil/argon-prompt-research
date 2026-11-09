export function encodeWireFrame(channelId, payloadStr) {
  const str = String(payloadStr ?? '');
  const len = Buffer.byteLength(str, 'utf8');
  const buf = Buffer.alloc(6 + len);
  buf.writeUInt16BE(channelId, 0);
  buf.writeUInt32BE(len, 2);
  buf.write(str, 6, 'utf8');
  return buf;
}

export function decodeWireFrame(buf) {
  const channelId = buf.readUInt16BE(0);
  const byteLength = buf.readUInt32BE(2);
  const payload = buf.subarray(6, 6 + byteLength).toString('utf8');
  return { channelId, byteLength, payload };
}
