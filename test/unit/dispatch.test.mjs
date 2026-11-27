/**
 * Finder fan-out tests.
 *
 * The per-lens candidate ceiling used to truncate silently: a lens could return
 * nine candidates, the plugin keep six, and the report never mention the other
 * three. Truncation is a coverage fact and has to reach the report (design
 * invariant #5), so this returns the counts and the orchestrator writes a note.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createLimiter } from '../../lib/concurrency.js'
import { resolveConfig } from '../../lib/config.js'
import { dispatchFinders } from '../../lib/dispatch.js'
import { lensList } from '../../lib/lenses.js'

/**
 * @param {number} count number of candidates one lens returns.
 * @returns {object[]} raw candidate objects.
 */
function candidates(count) {
  return Array.from({ length: count }, (_, index) => ({
    file: 'src/a.js',
    anchor: `const value${index} = ${index}`,
    kind: 'correctness',
    title: `问题 ${index}`,
    detail: '细节',
    failureScenario: '输入 → 结果',
    severity: 'major',
  }))
}

/**
 * @param {object} options dispatch options.
 * @param {number} options.returned candidates per lens.
 * @param {number} options.maxCandidatesPerLens per-lens ceiling.
 * @returns {Promise<object>} dispatch outcome.
 */
function dispatch({ returned, maxCandidatesPerLens }) {
  const config = resolveConfig({ maxCandidatesPerLens })
  return dispatchFinders({
    lenses: lensList(['correctness', 'lifecycle']),
    targetDescription: '指定文件',
    root: 'C:/repo',
    fileSection: { blocks: ['### src/a.js\n'], reviewed: ['src/a.js'], skipped: [] },
    config,
    runChild: async ({ label }) => ({
      stopReason: 'completed',
      structured: { findings: candidates(label.endsWith('correctness') ? returned : 1) },
    }),
    limiter: createLimiter(2),
    signal: new AbortController().signal,
  })
}

test('超出每视角上限时记录截断事实', async () => {
  const outcome = await dispatch({ returned: 9, maxCandidatesPerLens: 6 })

  assert.equal(outcome.candidates.length, 6 + 1, '正确性 6 条 + 生命周期 1 条')
  assert.deepEqual(outcome.truncated, [{ lens: 'correctness', returned: 9, kept: 6 }])
})

test('没有超出上限时不产生截断记录', async () => {
  const outcome = await dispatch({ returned: 6, maxCandidatesPerLens: 6 })

  assert.equal(outcome.candidates.length, 6 + 1)
  assert.deepEqual(outcome.truncated, [])
})

/**
 * @param {Function} runChild child runner.
 * @returns {Promise<object>} dispatch outcome.
 */
function dispatchWith(runChild) {
  return dispatchFinders({
    lenses: lensList(['correctness']),
    targetDescription: '指定文件',
    root: 'C:/repo',
    fileSection: { blocks: ['### src/a.js\n'], reviewed: ['src/a.js'], skipped: [] },
    config: resolveConfig({}),
    runChild,
    limiter: createLimiter(1),
    signal: new AbortController().signal,
  })
}

test('视角因一次临时错误失败时会重试并记录', async () => {
  let calls = 0
  const outcome = await dispatchWith(async () => {
    calls += 1
    if (calls === 1) return { stopReason: 'error', structured: undefined, diagnostic: 'tool input is invalid JSON' }
    return { stopReason: 'completed', structured: { findings: candidates(1) } }
  })

  assert.equal(calls, 2, '失败后应重试一次')
  assert.equal(outcome.candidates.length, 1)
  assert.equal(outcome.failed.length, 0)
  assert.equal(outcome.retried.length, 1)
  assert.equal(outcome.retried[0].lens, 'correctness')
  assert.equal(outcome.retried[0].attempts, 2)
  assert.match(outcome.retried[0].firstError, /子代理未完成/)
  assert.equal(outcome.retried[0].ok, true, '重试成功要标明')
})

test('超时不重试，避免把预算花在一个卡住的子代理上', async () => {
  let calls = 0
  const outcome = await dispatchWith(async () => {
    calls += 1
    throw new Error('子代理超时（420s）')
  })

  assert.equal(calls, 1, '超时不应重试')
  assert.equal(outcome.failed.length, 1)
  assert.equal(outcome.retried.length, 0)
})

test('重试仍失败时保留两次的失败事实', async () => {
  let calls = 0
  const outcome = await dispatchWith(async () => {
    calls += 1
    return { stopReason: 'error', structured: undefined }
  })

  assert.equal(calls, 2)
  assert.equal(outcome.failed.length, 1)
  assert.equal(outcome.retried.length, 1)
  assert.equal(outcome.retried[0].ok, false)
  assert.match(outcome.failed[0].reason, /子代理未完成/)
})
