/**
 * Finder phase: one child per lens, all through the shared limiter.
 *
 * A lens failure loses exactly that lens. It is recorded as a coverage gap and
 * never silently becomes "this lens found nothing" — pitfall #2 and #3.
 *
 * @module dsh-review-kit/dispatch
 */

import { buildFinderPrompt } from './prompt.js'
import { FINDINGS_SCHEMA } from './schema.js'

/**
 * Run every finder lens.
 *
 * @param {object} options dispatch options.
 * @param {object[]} options.lenses lens definitions.
 * @param {string} options.targetDescription scope line.
 * @param {string} options.root repository root.
 * @param {{blocks: string[], reviewed: string[], skipped: Array<{path: string, reason: string}>}} options.fileSection prompt file section.
 * @param {object} options.config resolved config.
 * @param {Function} options.runChild child runner.
 * @param {{run: Function}} options.limiter shared limiter.
 * @param {AbortSignal} options.signal cancellation.
 * @param {() => boolean} [options.timedOut] live check: the review clock has expired.
 * @returns {Promise<{candidates: Array<{raw: unknown, lens: string}>, failed: Array<{lens: string, reason: string}>, childRuns: number}>} finder outcome.
 */
export async function dispatchFinders({
  lenses,
  targetDescription,
  root,
  fileSection,
  config,
  runChild,
  limiter,
  signal,
  timedOut = () => false,
}) {
  let childRuns = 0

  const results = await Promise.all(lenses.map((lens) => limiter.run(async () => {
    if (signal.aborted) return { lens: lens.key, error: timedOut() ? '整轮超时，未开始' : '已中断，未开始' }
    const prompt = buildFinderPrompt({
      lens,
      targetDescription,
      root,
      blocks: fileSection.blocks,
      reviewed: fileSection.reviewed,
      skipped: fileSection.skipped,
      config,
    })
    childRuns += 1
    try {
      const out = await runChild({ label: `review:find:${lens.key}`, prompt, outputSchema: FINDINGS_SCHEMA, role: 'finder' })
      if (out.stopReason !== 'completed') {
        throw new Error(`子代理未完成（stopReason=${String(out.stopReason)}）${out.diagnostic ? `：${out.diagnostic}` : ''}`)
      }
      const findings = out.structured?.findings
      if (!Array.isArray(findings)) throw new Error('子代理没有返回结构化的 findings 数组')
      return { lens: lens.key, findings: findings.slice(0, config.maxCandidatesPerLens) }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { lens: lens.key, error: timedOut() ? `整轮超时，未完成：${reason}` : reason }
    }
  })))

  const candidates = []
  const failed = []
  for (const result of results) {
    if (result.error !== undefined) {
      failed.push({ lens: result.lens, reason: result.error })
      continue
    }
    for (const raw of result.findings) candidates.push({ raw, lens: result.lens })
  }

  return { candidates, failed, childRuns }
}
