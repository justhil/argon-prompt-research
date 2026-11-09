import { parseHeaderMap } from './header_parser.mjs';

export function extractTenantCode(rawHeader) {
  const parsed = parseHeaderMap(rawHeader, false);
  return parsed.tenantId.trim().toUpperCase();
}
