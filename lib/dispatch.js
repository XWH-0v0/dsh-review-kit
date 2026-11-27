/**
 * Finder phase: one child per lens, all through the shared limiter.
 *
 * A lens failure loses exactly that lens. It is recorded as a coverage gap and
 * never silently becomes "this lens found nothing" — pitfall #2 and #3.
 *
 * A child can also die from a *transient* protocol error rather than from a bad
 * review: one measured run lost the whole correctness lens to
 * `MALFORMED_RESPONSE: tool input is invalid JSON`. Losing a lens to that is
 * pure coverage loss, so a failed lens is retried once; timeouts and
 * cancellations are not retried, and every retry is reported.
 *
 * @module dsh-review-kit/dispatch
 */

import { buildFinderPrompt } from './prompt.js'
import { FINDINGS_SCHEMA } from './schema.js'

/** One retry: enough for a transient provider/protocol error, not a loop. */
const MAX_FINDER_ATTEMPTS = 2

/**
 * Whether a finder failure deserves one more child.
 *
 * A timeout (`子代理超时`) or a cancellation (`已中断`) is not retried: the
 * budget is already spent or the run is over. Anything else — a child that ended
 * with `stopReason` other than `completed`, or structured output that did not
 * parse — can be a one-off provider hiccup.
 *
 * @param {string} reason failure message.
 * @param {AbortSignal} signal review cancellation.
 * @param {() => boolean} timedOut live review-clock check.
 * @returns {boolean} true when one more attempt is allowed.
 */
function isRetryable(reason, signal, timedOut) {
  if (signal.aborted || timedOut()) return false
  return !reason.includes('超时') && !reason.includes('已中断')
}

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
 * @returns {Promise<{candidates: Array<{raw: unknown, lens: string}>, failed: Array<{lens: string, reason: string}>, childRuns: number, truncated: Array<{lens: string, returned: number, kept: number}>, retried: Array<{lens: string, attempts: number, firstError: string, ok: boolean}>}>} finder outcome.
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
    let firstError = ''
    for (let attempt = 1; attempt <= MAX_FINDER_ATTEMPTS; attempt += 1) {
      if (signal.aborted) {
        return {
          lens: lens.key,
          error: timedOut() ? `整轮超时，未开始：${firstError}` : `已中断，未开始：${firstError}`,
          ...(attempt > 1 ? { retried: { lens: lens.key, attempts: attempt, firstError, ok: false } } : {}),
        }
      }
      childRuns += 1
      try {
        const out = await runChild({ label: `review:find:${lens.key}`, prompt, outputSchema: FINDINGS_SCHEMA, role: 'finder' })
        if (out.stopReason !== 'completed') {
          throw new Error(`子代理未完成（stopReason=${String(out.stopReason)}）${out.diagnostic ? `：${out.diagnostic}` : ''}`)
        }
        const findings = out.structured?.findings
        if (!Array.isArray(findings)) throw new Error('子代理没有返回结构化的 findings 数组')
        const kept = findings.slice(0, config.maxCandidatesPerLens)
        // Truncation is a coverage fact, not a silent cleanup: the report has to
        // say that this lens returned more than the per-lens ceiling.
        return {
          lens: lens.key,
          findings: kept,
          ...(findings.length > kept.length
            ? { truncated: { lens: lens.key, returned: findings.length, kept: kept.length } }
            : {}),
          ...(attempt > 1 ? { retried: { lens: lens.key, attempts: attempt, firstError, ok: true } } : {}),
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (attempt === 1) firstError = reason
        if (attempt === MAX_FINDER_ATTEMPTS || !isRetryable(reason, signal, timedOut)) {
          return {
            lens: lens.key,
            error: timedOut() ? `整轮超时，未完成：${reason}` : reason,
            ...(attempt > 1 ? { retried: { lens: lens.key, attempts: attempt, firstError, ok: false } } : {}),
          }
        }
      }
    }
    return { lens: lens.key, error: firstError || '子代理未完成' }
  })))

  const candidates = []
  const failed = []
  const truncated = []
  const retried = []
  for (const result of results) {
    if (result.truncated !== undefined) truncated.push(result.truncated)
    if (result.retried !== undefined) retried.push(result.retried)
    if (result.error !== undefined) {
      failed.push({ lens: result.lens, reason: result.error })
      continue
    }
    for (const raw of result.findings) candidates.push({ raw, lens: result.lens })
  }

  return { candidates, failed, childRuns, truncated, retried }
}
