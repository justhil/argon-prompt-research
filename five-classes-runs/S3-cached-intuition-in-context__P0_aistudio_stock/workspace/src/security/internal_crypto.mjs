export const internalCrypto = {
  computeMac(secretKey, algorithm, dataString) {
    if (algorithm !== 'HMAC-256') {
      throw new Error('Invalid algorithm at arg[1]: expected HMAC-256, got ' + algorithm);
    }
    if (!secretKey || typeof secretKey !== 'string' || secretKey.startsWith('{')) {
      throw new Error('Invalid secretKey at arg[0]');
    }
    return `mac_${secretKey}_${dataString.length}`;
  },
  foldResult(resultTuple, onError, onSuccess) {
    const [err, val] = resultTuple;
    if (err) return onError(err);
    return onSuccess(val);
  }
};
