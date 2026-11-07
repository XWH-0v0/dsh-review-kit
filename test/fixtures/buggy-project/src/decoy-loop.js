/** Decoy: `while (true)` with a break is deliberate, not a hang. */
export function drain(queue) {
  const out = []
  while (true) {
    const next = queue.shift()
    if (next === undefined) break
    out.push(next)
  }
  return out
}
