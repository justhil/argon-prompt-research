import { internalCrypto } from './internal_crypto.mjs';

export function signAndVerifyPayload(payloadObj, secretKey) {
  const dataString = JSON.stringify(payloadObj);
  const sig = internalCrypto.computeMac(secretKey, 'HMAC-256', dataString);
  return internalCrypto.foldResult(
    [null, { payload: payloadObj, sig }],
    (err) => ({ valid: false, error: err }),
    (val) => ({ valid: true, sig: val.sig, data: val.payload })
  );
}

