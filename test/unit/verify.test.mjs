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
 * @param {boolean|Function} timedOut whether the review clock expired, or a live check.
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
    timedOut: typeof timedOut === 'function' ? timedOut : () => timedOut === true,
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
test('复核运行中时钟才到期时也会判为未验证（实时判断）', async () => {
  const controller = new AbortController()
  let expired = false
  const outcome = await verify(async () => {
    expired = true
    controller.abort(new Error('评审整体超时'))
    throw new Error('已中断')
  }, controller.signal, () => expired)

  const [finding] = outcome.findings
  assert.equal(finding.status, 'unverified')
  assert.match(finding.refutation, /整轮超时/)
})


test('非超时的复核失败仍按 refute 策略处理', async () => {
  const outcome = await verify(async () => {
    throw new Error('复核者挂了')
  }, new AbortController().signal, false)

  const [finding] = outcome.findings
  assert.equal(finding.status, 'refuted')
  assert.match(finding.refutation, /复核者不可用/)
})

test('调用方中断且未超时时，早退分支写已中断而不是整轮超时', async () => {
  const controller = new AbortController()
  controller.abort()
  const outcome = await verify(async () => {
    throw new Error('中断后不应启动复核者')
  }, controller.signal, () => false)

  const [finding] = outcome.findings
  assert.equal(finding.status, 'unverified')
  assert.equal(finding.refutation, '已中断，复核未完成')
  assert.deepEqual(finding.verifications, [])
})

test('调用方中断（未超时）时进行中的复核记为未验证，不落入 refute', async () => {
  const controller = new AbortController()
  const outcome = await verify(async () => {
    controller.abort(new Error('用户中断'))
    throw new Error('已中断')
  }, controller.signal, () => false)

  const [finding] = outcome.findings
  assert.equal(finding.status, 'unverified')
  assert.match(finding.refutation, /已中断/)
})

test('中断后不再发起剩余复核尝试，childRuns 与 verifiersFailed 不虚高', async () => {
  const controller = new AbortController()
  let attempts = 0
  const outcome = await verifyFindings({
    findings: [{ ...FINDING, originHint: 'new' }],
    snapshot: SNAPSHOT,
    root: 'C:/repo',
    baselineRef: undefined,
    config: { verifiersPerFinding: 3, onVerifierFailure: 'refute' },
    runChild: async () => {
      attempts += 1
      controller.abort(new Error('用户中断'))
      throw new Error('已中断')
    },
    limiter: createLimiter(1),
    signal: controller.signal,
    timedOut: () => false,
  })

  assert.equal(attempts, 1, '中断后不应再发起复核')
  assert.equal(outcome.childRuns, 1, 'childRuns 只应计入真正发起的尝试')
  assert.equal(outcome.verifiersFailed.length, 1)
  assert.equal(outcome.findings[0].status, 'unverified')
})

test('取消落在已完成的复核之后时，原因不谎称复核者不可用', async () => {
  const controller = new AbortController()
  const outcome = await verifyFindings({
    findings: [{ ...FINDING, originHint: 'new' }],
    snapshot: SNAPSHOT,
    root: 'C:/repo',
    baselineRef: undefined,
    config: { verifiersPerFinding: 3, onVerifierFailure: 'refute' },
    runChild: async () => {
      controller.abort(new Error('用户中断'))
      return { stopReason: 'completed', structured: { confirmed: true, confidence: 0.9, reasoning: 'ok' } }
    },
    limiter: createLimiter(1),
    signal: controller.signal,
    timedOut: () => false,
  })

  const [finding] = outcome.findings
  assert.equal(finding.status, 'unverified')
  assert.match(finding.refutation, /已完成 1\/3/)
  assert.doesNotMatch(finding.refutation, /复核者不可用/)
})
