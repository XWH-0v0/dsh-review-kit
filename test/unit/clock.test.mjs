/**
 * Review-level wall clock tests.
 *
 * The clock folds caller cancellation and the whole-review deadline into one
 * signal. `runReview` only reports `expired`, so the distinction matters: a
 * user abort is not a timeout.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createReviewClock } from '../../lib/clock.js'

test('到期后 signal 中断，expired 为真', async () => {
  const keepAlive = setInterval(() => {}, 1_000)
  const clock = createReviewClock(new AbortController().signal, 20)
  try {
    assert.equal(clock.signal.aborted, false)
    await new Promise((resolve) => clock.signal.addEventListener('abort', resolve, { once: true }))
    assert.equal(clock.expired, true)
    assert.equal(clock.signal.aborted, true)
    assert.match(String(clock.signal.reason), /评审整体超时/)
  } finally {
    clock.dispose()
    clearInterval(keepAlive)
  }
})

test('调用方中断转发到时钟，但不算整体超时', () => {
  const caller = new AbortController()
  const clock = createReviewClock(caller.signal, 60_000)
  try {
    caller.abort(new Error('用户中断'))
    assert.equal(clock.signal.aborted, true)
    assert.equal(clock.expired, false)
  } finally {
    clock.dispose()
  }
})

test('调用方已中断时立即转发', () => {
  const caller = new AbortController()
  caller.abort(new Error('早已中断'))
  const clock = createReviewClock(caller.signal, 60_000)
  try {
    assert.equal(clock.signal.aborted, true)
    assert.equal(clock.expired, false)
  } finally {
    clock.dispose()
  }
})

test('dispose 后到期不再中断', async () => {
  const keepAlive = setInterval(() => {}, 1_000)
  const clock = createReviewClock(new AbortController().signal, 20)
  clock.dispose()
  await new Promise((resolve) => setTimeout(resolve, 60))
  clearInterval(keepAlive)
  assert.equal(clock.signal.aborted, false)
})
