/**
 * AUTO-STUB (desktop build): CLI-only module absent from the vendored leak.
 * checkProtectedNamespace only runs under USER_TYPE==='ant' (DCE'd off here),
 * so this no-op is never reached at runtime — it exists so the import resolves.
 */
export function checkProtectedNamespace(): boolean {
  return false
}
