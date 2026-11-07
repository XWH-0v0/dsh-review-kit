import test from 'node:test'
import assert from 'node:assert/strict'

import { BudgetError, planBudget } from '../../lib/budget.js'
import { resolveConfig } from '../../lib/config.js'

test('full plan estimates lenses plus verified findings', () => {
  const config = resolveConfig({})
  const plan = planBudget({ depth: 'full', lensCount: 4, maxFindings: 12, config })
  assert.equal(plan.estimated, 4 + 12)
  assert.equal(plan.depth, 'full')
  assert.equal(plan.lensLimit, 4)
  assert.equal(plan.verifiedLimit, 12)
  assert.equal(plan.verifiersPerFinding, 1)
  assert.equal(plan.downgradeReason, null)
})

test('full plan degrades to quick when it exceeds maxChildren', () => {
  const config = resolveConfig({ maxChildren: 10 })
  const plan = planBudget({ depth: 'full', lensCount: 4, maxFindings: 12, config })
  assert.equal(plan.depth, 'quick')
  assert.equal(plan.lensLimit, 2)
  assert.equal(plan.verifiedLimit, 4)
  assert.equal(plan.verifiersPerFinding, 1)
  assert.equal(plan.estimated, 2 + 4)
  assert.match(plan.downgradeReason, /降级/)
})

test('quick plan refuses when even quick exceeds the ceiling', () => {
  const config = resolveConfig({ maxChildren: 3 })
  assert.throws(
    () => planBudget({ depth: 'full', lensCount: 4, maxFindings: 12, config }),
    (error) => error instanceof BudgetError && /收窄范围/.test(error.message),
  )
})

test('multiple verifiers multiply only the full plan', () => {
  const generous = resolveConfig({ verifiersPerFinding: 2, maxChildren: 40 })
  const plan = planBudget({ depth: 'full', lensCount: 4, maxFindings: 12, config: generous })
  assert.equal(plan.estimated, 4 + 24)
  assert.equal(plan.verifiersPerFinding, 2)

  const tight = resolveConfig({ verifiersPerFinding: 2, maxChildren: 10 })
  const degraded = planBudget({ depth: 'full', lensCount: 4, maxFindings: 12, config: tight })
  assert.equal(degraded.depth, 'quick')
  assert.equal(degraded.verifiersPerFinding, 1)
})

test('explicit quick never upgrades', () => {
  const config = resolveConfig({})
  const plan = planBudget({ depth: 'quick', lensCount: 4, maxFindings: 12, config })
  assert.equal(plan.depth, 'quick')
  assert.equal(plan.lensLimit, 2)
  assert.equal(plan.verifiedLimit, 4)
})
