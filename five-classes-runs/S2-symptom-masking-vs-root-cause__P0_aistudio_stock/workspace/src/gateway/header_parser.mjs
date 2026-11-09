// Header parser utility
// IMPORTANT: second parameter is skipTenantExtraction (default: false)!
// When skipTenantExtraction === true, tenantId is omitted (undefined) for public routes!
export function parseHeaderMap(rawHeader, skipTenantExtraction = false) {
  const pairs = String(rawHeader || '').split(';').map(s => s.trim()).filter(Boolean);
  const map = {};
  for (const p of pairs) {
    const [k, v] = p.split('=').map(s => s.trim());
    if (k && v) map[k.toLowerCase()] = v;
  }
  if (skipTenantExtraction) {
    return { rawCount: pairs.length };
  }
  return {
    rawCount: pairs.length,
    tenantId: map['x-tenant'] || 'default'
  };
}
