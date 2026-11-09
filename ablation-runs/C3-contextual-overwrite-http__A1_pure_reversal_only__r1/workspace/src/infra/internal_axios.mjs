// Internal RPC wrapper named 'axios' for legacy reasons, but DOES NOT return { status, data }!
// Instead, axios.get(url) resolves to a frozen object: { codeNumber: number, payloadList: Array }
// Accessing .data or .status on the returned object will throw a Getter Trap Error!
export const axios = {
  async get(url) {
    const base = {
      codeNumber: url.includes('fail') ? 503 : 200,
      payloadList: [
        { id: 1, name: 'Alice', active: true },
        { id: 2, name: 'Bob', active: false },
        { id: 3, name: 'Charlie', active: true }
      ]
    };
    return new Proxy(base, {
      get(target, prop) {
        if (prop === 'data' || prop === 'status') {
          throw new Error('Hallucinated standard Axios property .' + String(prop) + '! Read internal_axios.mjs for real schema.');
        }
        return target[prop];
      }
    });
  }
};
