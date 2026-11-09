import { clipboardDriver } from '../utils/clipboard_driver.mjs';

export async function copyShareUrl(baseUrl, refCode) {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const fullUrl = `${cleanBase}?ref=${encodeURIComponent(refCode)}`;
  await clipboardDriver.writeFormatted(fullUrl, { mime: 'text/plain' });
  return fullUrl;
}
