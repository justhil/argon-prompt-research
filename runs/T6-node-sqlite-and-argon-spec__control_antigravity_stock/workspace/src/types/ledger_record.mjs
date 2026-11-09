export function serializeTag({ tenantId, category, version = 2 }) {
  if (!tenantId || !category) {
    throw new Error('serializeTag requires { tenantId, category }');
  }
  return `v${version}:${tenantId}:${String(category).toUpperCase()}`;
}
