/**
 * Review-level wall clock.
 *
 * Every child already has its own budget (`childTimeoutMs`), but one review fans
 * out over many children and the tool call must still end. The clock folds the
 * caller's cancellation and one whole-review deadline into a single signal: when
 * either fires, in-flight children are cancelled, queued children never start,
 * and `runReview` settles with a partial, schema-valid report instead of running
 * into the host's tool-level hard timeout.
 *
 * @module dsh-review-kit/clock
 */

/**
 * @param {AbortSignal|undefined} callerSignal tool-call cancellation.
 * @param {number} softTimeoutMs whole-review wall clock.
 * @returns {{signal: AbortSignal, expired: boolean, dispose: () => void}} the clock.
 */
export function createReviewClock(callerSignal, softTimeoutMs) {
  const controller = new AbortController()
  let expired = false

  const forward = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted === true) controller.abort(callerSignal.reason)
  else callerSignal?.addEventListener('abort', forward, { once: true })

  const timer = setTimeout(() => {
    expired = true
    controller.abort(new Error(`评审整体超时（${Math.round(softTimeoutMs / 1_000)}s）`))
  }, softTimeoutMs)
  timer.unref?.()

  return {
    signal: controller.signal,
    get expired() {
      return expired
    },
    dispose() {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', forward)
    },
  }
}
