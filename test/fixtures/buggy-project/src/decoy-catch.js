/** Decoy: the empty catch is deliberate; the caller gets a safe fallback. */
export function readConfig(read) {
  try {
    return JSON.parse(read())
  } catch {
    return {}
  }
}
