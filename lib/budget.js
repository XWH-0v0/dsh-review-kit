/**
 * Cost estimation and degradation.
 *
 * Fan-out is the expensive part of a review, so the plan is computed *before*
 * any child starts: lenses + (findings × verifiers). When the estimate exceeds
 * `maxChildren` a `full` review degrades to `quick` once; a `quick` review that
 * still exceeds the ceiling is refused with an actionable error rather than
 * quietly burning the user's quota.
 *
 * @module dsh-review-kit/budget
 */

/** The review cannot be run inside the configured child budget. */
export class BudgetError extends Error {
  /**
   * @param {string} message actionable explanation.
   */
  constructor(message) {
    super(message)
    this.name = 'BudgetError'
    this.code = 'REVIEW_BUDGET'
  }
}

/**
 * @param {number} children estimated child-agent count.
 * @returns {number} unchanged value, for readability.
 */
function estimateOf(children) {
  return children
}

/**
 * Plan one review's fan-out.
 *
 * @param {object} options plan options.
 * @param {string} options.depth requested depth (`quick` or `full`).
 * @param {number} options.lensCount number of lenses requested.
 * @param {number} options.maxFindings findings allowed to reach verification.
 * @param {object} options.config resolved config.
 * @returns {{depth: string, lensLimit: number, verifiedLimit: number, verifiersPerFinding: number, estimated: number, downgradeReason: string|null}} the plan.
 * @throws {BudgetError} when even the quick plan exceeds `maxChildren`.
 */
export function planBudget({ depth, lensCount, maxFindings, config }) {
  const requested = depth === 'quick' ? 'quick' : 'full'
  const verifiers = Math.max(1, config.verifiersPerFinding)
  const quickLensLimit = Math.min(2, lensCount)
  const quickVerifiedLimit = Math.min(4, maxFindings)
  const quickVerifiers = 1

  const fullEstimated = estimateOf(lensCount + maxFindings * verifiers)
  const quickEstimated = estimateOf(quickLensLimit + quickVerifiedLimit * quickVerifiers)

  let resolved = requested
  let downgradeReason = null
  if (resolved === 'full' && fullEstimated > config.maxChildren) {
    resolved = 'quick'
    downgradeReason = `预计子代理数 ${fullEstimated} 超过上限 ${config.maxChildren}，已自动降级为 quick`
  }

  const estimated = resolved === 'quick' ? quickEstimated : fullEstimated
  if (estimated > config.maxChildren) {
    throw new BudgetError(
      `预计需要 ${estimated} 个子代理，超过上限 ${config.maxChildren}。`
      + '请收窄范围后重试：减少 lenses、降低 maxFindings，或改用 depth="quick"。',
    )
  }

  return {
    depth: resolved,
    lensLimit: resolved === 'quick' ? quickLensLimit : lensCount,
    verifiedLimit: resolved === 'quick' ? quickVerifiedLimit : maxFindings,
    verifiersPerFinding: resolved === 'quick' ? quickVerifiers : verifiers,
    estimated,
    downgradeReason,
  }
}
