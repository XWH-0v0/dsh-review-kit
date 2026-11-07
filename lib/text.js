/**
 * Small text primitives shared by the gate, the prompts and the report.
 *
 * The anchor contract lives here: an anchor is one source line compared after
 * whitespace folding, so re-indentation or CRLF conversion does not turn the
 * same finding into a different one.
 *
 * @module dsh-review-kit/text
 */

import { SEVERITY_RANK } from './config.js'

/**
 * Fold all runs of whitespace and trim. Used for both anchor comparison and
 * fingerprints, so the two can never disagree.
 *
 * @param {unknown} value any text.
 * @returns {string} the comparison form.
 */
export function normalizeLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Split text into lines without keeping a trailing empty line.
 *
 * @param {unknown} value any text.
 * @returns {string[]} lines.
 */
export function splitLines(value) {
  return String(value ?? '').split(/\r?\n/)
}

/**
 * Find the 1-based line number whose normalized form equals the anchor's.
 *
 * @param {string|null} content file text, or null when unavailable.
 * @param {string} anchor verbatim source line.
 * @returns {number} 1-based line number, or 0 when the anchor is absent.
 */
export function locateAnchor(content, anchor) {
  if (content === null || content === undefined) return 0
  const want = normalizeLine(anchor)
  if (want.length === 0) return 0
  const lines = splitLines(content)
  for (let index = 0; index < lines.length; index += 1) {
    if (normalizeLine(lines[index]) === want) return index + 1
  }
  return 0
}

/**
 * Clip text to a character budget, marking the omission explicitly.
 *
 * @param {unknown} value text to clip.
 * @param {number} max maximum retained characters.
 * @returns {string} clipped text.
 */
export function clip(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[已截断 ${text.length - max} 字符]`
}

/**
 * Collapse text to one bounded line, for report fields.
 *
 * @param {unknown} value text.
 * @param {number} max maximum retained characters.
 * @returns {string} a single line excerpt.
 */
export function excerpt(value, max) {
  const flat = normalizeLine(value)
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * Concatenate the text blocks of tool content.
 *
 * @param {unknown} content tool content blocks.
 * @returns {string} joined text.
 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * Normalize a severity label, defaulting unknown values to `major` so a label
 * typo never silently downgrades a real finding to noise.
 *
 * @param {unknown} value candidate severity.
 * @returns {'critical'|'major'|'minor'} a known severity.
 */
export function normalizeSeverity(value) {
  const lower = String(value ?? '').trim().toLowerCase()
  if (lower === 'critical' || lower === 'major' || lower === 'minor') return lower
  return 'major'
}

/**
 * @param {string} severity normalized severity.
 * @returns {number} sort rank.
 */
export function severityRank(severity) {
  return SEVERITY_RANK[normalizeSeverity(severity)] ?? 1
}

/**
 * Report order: severity, then file, then line, then id for determinism.
 *
 * @param {{severity: string, file: string, line: number, id: string, lenses?: string[]}} a left.
 * @param {typeof a} b right.
 * @returns {number} comparator result.
 */
export function compareFindings(a, b) {
  const bySeverity = severityRank(a.severity) - severityRank(b.severity)
  if (bySeverity !== 0) return bySeverity
  const byCorroboration = (b.lenses?.length ?? 1) - (a.lenses?.length ?? 1)
  if (byCorroboration !== 0) return byCorroboration
  const byFile = String(a.file).localeCompare(String(b.file))
  if (byFile !== 0) return byFile
  const byLine = (a.line ?? 0) - (b.line ?? 0)
  if (byLine !== 0) return byLine
  return String(a.id).localeCompare(String(b.id))
}

/**
 * Character-bigram Jaccard similarity, used only for the conservative
 * near-duplicate merge pass.
 *
 * @param {string} left first text.
 * @param {string} right second text.
 * @returns {number} similarity in 0..1.
 */
export function similarity(left, right) {
  const a = normalizeLine(left).replace(/\s+/g, '')
  const b = normalizeLine(right).replace(/\s+/g, '')
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = (text) => {
    const out = new Set()
    for (let index = 0; index < text.length - 1; index += 1) out.add(text.slice(index, index + 2))
    return out
  }
  const first = grams(a)
  const second = grams(b)
  let intersection = 0
  for (const gram of first) if (second.has(gram)) intersection += 1
  return intersection / (first.size + second.size - intersection)
}

/**
 * @param {number} ms elapsed milliseconds.
 * @returns {string} a compact duration.
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1_000)
  return `${minutes}m${seconds}s`
}
