/**
 * Verifier failure policy tests.
 *
 * A review-clock expiry cancels in-flight verifiers. Those are unfinished, not
 * refuted: reporting them as "复核给出了反证" would turn a timeout into a false
 * negative claim about the finding.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createLimiter } from '../../lib/concurrency.js'
import { verifyFindings } from '../../lib/verify.js'

const FINDING = Object.freeze({
  id: 'F1',
  file: 'src/a.js',
  line: 2,
  anchor: 'const x = 1',
  kind: 'correctness',
  severity: 'major',
  title: '结论',
  detail: '说明',
  failureScenario: '场景',
  lens: 'correctness',
  lenses: ['correctness'],
})

const SNAPSHOT = Object.freeze({
  files: [{ path: 'src/a.js', after: 'const x = 1\nconst y = 2\n', before: null }],
})

/**
 * @param {Function} runChild child runner.
 * @param {AbortSignal} signal review signal.
 * @param {boolean} timedOut whether the review clock expired.
 * @returns {Promise<object>} verification outcome.
 */
function verify(runChild, signal, timedOut) {
  return verifyFindings({
    findings: [{ ...FINDING, originHint: 'new' }],
    snapshot: SNAPSHOT,
    root: 'C:/repo',
    baselineRef: undefined,
    config: { verifiersPerFinding: 1, onVerifierFailure: 'refute' },
    runChild,
    limiter: createLimiter(1),
    signal,
    timedOut,
  })
}

test('整轮超时时，未完成的复核记为未验证，而不是被推翻', async () => {
  const controller = new AbortController()
  const outcome = await verify(async () => {
    controller.abort(new Error('评审整体超时'))
    throw new Error('已中断')
  }, controller.signal, true)

  const [finding] = outcome.findings
  assert.equal(finding.status, 'unverified')
  assert.match(finding.refutation, /整轮超时/)
  assert.equal(outcome.verifiersRun, 0)
  assert.equal(outcome.verifiersFailed.length, 1)
})

test('非超时的复核失败仍按 refute 策略处理', async () => {
  const outcome = await verify(async () => {
    throw new Error('复核者挂了')
  }, new AbortController().signal, false)

  const [finding] = outcome.findings
  assert.equal(finding.status, 'refuted')
  assert.match(finding.refutation, /复核者不可用/)
})
