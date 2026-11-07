/**
 * Fingerprint deduplication with a deliberately conservative near-duplicate
 * pass. Two lenses reporting the same quoted line become one finding with
 * `lenses: [a, b]`; adjacent-but-different bugs stay separate because the
 * similarity threshold (0.85) only merges near-identical anchors within ±3
 * lines of the same kind.
 *
 * @module dsh-review-kit/dedupe
 */

import { compareFindings, severityRank, similarity } from './text.js'

/**
 * Merge one finding into another without losing evidence.
 *
 * @param {object} target surviving finding (mutated).
 * @param {object} source duplicate finding.
 * @returns {void}
 */
function mergeInto(target, source) {
  for (const lens of source.lenses ?? [source.lens]) {
    if (!target.lenses.includes(lens)) target.lenses.push(lens)
  }
  if (severityRank(source.severity) < severityRank(target.severity)) target.severity = source.severity
  if ((source.detail?.length ?? 0) > (target.detail?.length ?? 0)) {
    target.title = source.title
    target.detail = source.detail
    target.failureScenario = source.failureScenario
  }
  if (target.suggestedFix === undefined && source.suggestedFix !== undefined) target.suggestedFix = source.suggestedFix
}

/**
 * Deduplicate gated findings.
 *
 * @param {object[]} findings gated findings.
 * @returns {{findings: object[], mergedCount: number}} deduplicated findings in report order.
 */
export function dedupeFindings(findings) {
  const byId = new Map()
  let mergedCount = 0

  for (const finding of findings) {
    const existing = byId.get(finding.id)
    if (existing === undefined) {
      byId.set(finding.id, { ...finding, lenses: [...new Set(finding.lenses ?? [finding.lens])] })
      continue
    }
    mergedCount += 1
    mergeInto(existing, finding)
  }

  const kept = []
  for (const finding of [...byId.values()].sort(compareFindings)) {
    const twin = kept.find((other) => other.file === finding.file
      && other.kind === finding.kind
      && Math.abs((other.line ?? 0) - (finding.line ?? 0)) <= 3
      && similarity(other.anchor, finding.anchor) >= 0.85)
    if (twin === undefined) {
      kept.push(finding)
      continue
    }
    mergedCount += 1
    mergeInto(twin, finding)
  }

  return { findings: kept, mergedCount }
}
