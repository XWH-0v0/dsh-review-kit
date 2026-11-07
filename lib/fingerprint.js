/**
 * Stable finding identity.
 *
 * The fingerprint deliberately covers exactly the evidence that survives a
 * rebase, a reformat, or added blank lines: the kind, the repository path, and
 * the whitespace-folded anchor line. Re-running a review therefore reports the
 * same bug under the same id.
 *
 * @module dsh-review-kit/fingerprint
 */

import { createHash } from 'node:crypto'

import { normalizeLine } from './text.js'

/**
 * @param {{kind: string, file: string, anchor: string}} finding finding evidence.
 * @returns {string} 16 hex characters.
 */
export function fingerprintOf({ kind, file, anchor }) {
  const payload = [
    String(kind ?? '').toLowerCase(),
    String(file ?? '').replace(/\\/g, '/'),
    normalizeLine(anchor),
  ].join('\u0000')
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}
