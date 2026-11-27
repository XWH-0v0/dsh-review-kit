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
