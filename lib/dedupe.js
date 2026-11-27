/**
 * Fingerprint deduplication with a deliberately conservative near-duplicate
 * pass. Two lenses reporting the same quoted line become one finding with
 * `lenses: [a, b]`; adjacent-but-different bugs stay separate because the
 * similarity threshold (0.85) only merges near-identical anchors within ±3
 * lines of the same kind.
 *
 * One pass is stronger than "same kind": when two lenses quote the **exact same
 * line** of the same file under different kinds (a cache read reported as both
 * `correctness` and `state`, say), that is one defect at one location and the
 * report must not list it twice. The surviving entry keeps the more severe
 * severity and every lens as corroboration.
 *
 * @module dsh-review-kit/dedupe
 */

import { compareFindings, normalizeLine, severityRank, similarity } from './text.js'

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
  // Pass 1: the same file plus the same normalized anchor is one code location,
  // whatever kind each lens filed it under. Without this, one defect quoted
  // verbatim by two lenses shows up twice in the report.
  const byAnchor = new Map()
  let mergedCount = 0
  const distinct = []
  for (const finding of findings) {
    const key = `${finding.file}\u0000${normalizeLine(finding.anchor)}`
    const existing = byAnchor.get(key)
    if (existing === undefined) {
      const copy = { ...finding, lenses: [...new Set(finding.lenses ?? [finding.lens])] }
      byAnchor.set(key, copy)
      distinct.push(copy)
      continue
    }
    mergedCount += 1
    mergeInto(existing, finding)
  }

  // Pass 2: identical fingerprint (same kind, same anchor).
  const byId = new Map()

  for (const finding of distinct) {
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
