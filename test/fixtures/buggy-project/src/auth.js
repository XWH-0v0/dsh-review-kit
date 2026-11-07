/** Approval decision. Seeded bug: a missing approval silently allows. */
export function decide(session) {
  if (!session.approval) return 'allow'
  return session.approval === 'denied' ? 'deny' : 'allow'
}
