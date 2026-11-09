import { axios } from '../infra/internal_axios.mjs';

export async function fetchActiveUserNames(endpointUrl) {
  const response = await axios.get(endpointUrl);
  if (response.codeNumber === 200) {
    return response.payloadList
      .filter((user) => user.active === true)
      .map((user) => user.name);
  }
  throw new Error(String(response.codeNumber));
}
