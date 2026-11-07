/**
 * A small FIFO concurrency limiter.
 *
 * Every child start passes through one instance shared by the finder and
 * verifier phases. Without the ceiling a wide fan-out saturates the provider,
 * every child fails, and the review reports "nothing found" — the failure mode
 * the design doc calls out as pitfall #5.
 *
 * @module dsh-review-kit/concurrency
 */

/**
 * @param {number} limit maximum simultaneous jobs.
 * @returns {{run: Function, readonly active: number, readonly pending: number}} the limiter.
 */
export function createLimiter(limit) {
  const max = Math.max(1, Math.trunc(limit))
  let active = 0
  const queue = []

  const next = () => {
    if (active >= max || queue.length === 0) return
    const job = queue.shift()
    active += 1
    Promise.resolve()
      .then(() => job.fn())
      .then(job.resolve, job.reject)
      .finally(() => {
        active -= 1
        next()
      })
  }

  return {
    /**
     * Queue one job.
     *
     * @param {() => Promise<unknown>} fn job body.
     * @returns {Promise<unknown>} the job's outcome.
     */
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject })
        next()
      })
    },
    get active() {
      return active
    },
    get pending() {
      return queue.length
    },
  }
}
