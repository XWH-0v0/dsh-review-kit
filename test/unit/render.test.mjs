import test from 'node:test'
import assert from 'node:assert/strict'

import { renderMarkdown } from '../../lib/render.js'

function coverage(overrides = {}) {
  return {
    target: '未提交改动（工作区相对 HEAD）',
    depth: 'full',
    lensesRun: ['correctness', 'lifecycle', 'contract', 'security'],
    lensesFailed: [],
    lensesClean: ['lifecycle'],
    filesReviewed: ['src/cache.js'],
    filesSkipped: [{ path: 'README.md', reason: '纯文档改动不触发代码审查' }],
    findingsFound: 3,
    findingsInvalid: [],
    findingsDeduped: 0,
    findingsDropped: [],
    verifiersRun: 1,
    verifiersFailed: [],
    aborted: false,
    truncated: false,
    durationMs: 1_500,
    childRuns: 5,
    notes: [],
    ...overrides,
  }
}

function confirmedFinding() {
  return {
    id: 'abc123',
    file: 'src/cache.js',
    line: 6,
    anchor: 'return this.entries.get(key).value',
    kind: 'correctness',
    title: '缺失键会抛 TypeError',
    detail: 'get() 没有检查 Map 是否命中。',
    failureScenario: 'get("absent") → TypeError',
    severity: 'major',
    lens: 'correctness',
    lenses: ['correctness', 'security'],
    origin: 'introduced',
    originHint: 'new',
    confidence: 0.82,
    status: 'confirmed',
    reproduced: true,
    verifications: [{ confirmed: true, confidence: 0.82, reasoning: '读了代码并构造了缺失键。', reproduced: true, origin: 'introduced' }],
  }
}

test('report renders confirmed findings with location, scenario and verdict', () => {
  const markdown = renderMarkdown({
    status: 'completed',
    targetDescription: '未提交改动（工作区相对 HEAD）',
    confirmed: [confirmedFinding()],
    refuted: [],
    unverified: [],
    coverage: coverage(),
    stats: { candidates: 3, valid: 2, invalid: 1, deduped: 1, dropped: 0, verified: 1, confirmed: 1, refuted: 0, unverified: 0 },
  })
  assert.match(markdown, /## 代码评审：1 条确认/)
  assert.match(markdown, /src\/cache\.js:6/)
  assert.match(markdown, /失败场景/)
  assert.match(markdown, /置信度 0\.82/)
  assert.match(markdown, /双视角/)
  assert.match(markdown, /本次改动引入/)
  assert.match(markdown, /覆盖/)
  assert.match(markdown, /生命周期与并发 ✅/)
  assert.match(markdown, /README\.md/)
  assert.match(markdown, /无效引用 1/)
})

test('a clean run still reports coverage instead of claiming success', () => {
  const markdown = renderMarkdown({
    status: 'completed',
    targetDescription: '未提交改动（工作区相对 HEAD）',
    confirmed: [],
    refuted: [],
    unverified: [],
    coverage: coverage({ lensesClean: ['correctness', 'lifecycle', 'contract', 'security'] }),
    stats: { candidates: 0, valid: 0, invalid: 0, deduped: 0, dropped: 0, verified: 0, confirmed: 0, refuted: 0, unverified: 0 },
  })
  assert.match(markdown, /没有可确认的问题/)
  assert.match(markdown, /不等于「没有问题」/)
  assert.match(markdown, /已跑，无发现/)
})

test('failed lenses and refuted findings are explicit', () => {
  const markdown = renderMarkdown({
    status: 'partial',
    targetDescription: '未提交改动（工作区相对 HEAD）',
    confirmed: [],
    refuted: [{
      id: 'x',
      file: 'src/a.js',
      line: 3,
      title: '疑似问题',
      severity: 'major',
      lens: 'correctness',
      lenses: ['correctness'],
      reason: '复核者构造了输入，未复现失败。',
    }],
    unverified: [],
    coverage: coverage({
      lensesFailed: [{ lens: 'contract', reason: '子代理超时' }],
      lensesClean: ['lifecycle'],
      findingsDropped: [{ file: 'src/b.js', title: '被裁掉的发现', reason: '预算' }],
    }),
    stats: { candidates: 4, valid: 3, invalid: 1, deduped: 0, dropped: 1, verified: 1, confirmed: 0, refuted: 1, unverified: 0 },
  })
  assert.match(markdown, /部分完成/)
  assert.match(markdown, /契约与接口 ⚠️ 失败：子代理超时/)
  assert.match(markdown, /被推翻的发现/)
  assert.match(markdown, /复核者构造了输入/)
})
