/**
 * Prompt-shape tests.
 *
 * Two properties are load-bearing here:
 *   1. Every finder prompt shares one byte-identical prefix (shared scope and
 *      change blocks first, lens-specific text last), so the provider's prefix
 *      cache can serve later finders from the first child's prefill.
 *   2. Children are told their tool budget and what not to run. The measured
 *      baseline was a finder making 68 tool calls — running the repository test
 *      suite twice, hunting for a node binary and listing node_modules — on a
 *      review whose relevant evidence was provided in the prompt.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig } from '../../lib/config.js'
import { lensList } from '../../lib/lenses.js'
import { buildFileSection, buildFinderPrompt, buildVerifierPrompt } from '../../lib/prompt.js'

const CONFIG = resolveConfig({})

/**
 * @param {Partial<{path: string, diff: string, after: string}>} overrides file fields.
 * @returns {object} a snapshot file entry.
 */
function snapshotFile({ path = 'src/a.js', diff = '', after = 'const a = 1\n' } = {}) {
  return {
    path,
    statusLabel: '已修改',
    newFile: false,
    deleted: false,
    untracked: false,
    changedLines: [{ start: 1, end: 1 }],
    diff,
    before: 'const a = 1\n',
    after,
  }
}

const [CORRECTNESS, SECURITY] = [lensList(['correctness'])[0], lensList(['security'])[0]]

/**
 * @param {object[]} files snapshot entries.
 * @returns {object} the shared prompt arguments.
 */
function promptArgs(files) {
  const section = buildFileSection({ files, skipped: [], truncated: false }, CONFIG)
  return {
    targetDescription: '工作区未提交的改动',
    root: 'C:/repo',
    blocks: section.blocks,
    reviewed: section.reviewed,
    skipped: section.skipped,
    config: CONFIG,
  }
}

test('finder prompts share one prefix across lenses', () => {
  const args = promptArgs([snapshotFile({ diff: '+const b = 2\n' })])
  const first = buildFinderPrompt({ lens: CORRECTNESS, ...args })
  const second = buildFinderPrompt({ lens: SECURITY, ...args })

  const marker = '\n## 你的视角'
  const splitAt = (text) => {
    const index = text.indexOf(marker)
    assert.ok(index > 0, '每个 prompt 都必须有视角小节')
    return { prefix: text.slice(0, index), rest: text.slice(index) }
  }
  const one = splitAt(first)
  const two = splitAt(second)

  assert.equal(one.prefix, two.prefix, '视角之前的内容必须逐字相同（前缀缓存）')
  assert.match(one.prefix, /## 改动内容/)
  assert.match(one.prefix, /## 评审对象/)
  // The shared blocks must come before the lens-specific section, not after it.
  assert.ok(one.prefix.indexOf('## 改动内容') < one.prefix.indexOf('## 硬性约束') + one.prefix.length)
  assert.match(one.rest, /只关注：逻辑错误/)
  assert.match(two.rest, /只关注：注入/)
})

test('finder prompt states the tool budget and forbids the wandering commands', () => {
  const args = promptArgs([snapshotFile()])
  const prompt = buildFinderPrompt({ lens: CORRECTNESS, ...args })

  assert.match(prompt, new RegExp(`最多 ${CONFIG.finderToolBudget} 次工具调用`))
  assert.match(prompt, /禁止：跑测试套件、安装依赖、列目录、读 node_modules/)
  assert.match(prompt, /只读/)
  assert.doesNotMatch(prompt, /可以在临时目录里写脚本/, '旧的开放式探索指引必须消失')
})

test('verifier prompt states its own budget and forbids the repository test suite', () => {
  const finding = {
    file: 'src/a.js',
    line: 1,
    anchor: 'const a = 1',
    kind: 'correctness',
    severity: 'major',
    title: '断言',
    detail: '细节',
    failureScenario: '输入 → 结果',
  }
  const prompt = buildVerifierPrompt({
    finding,
    file: snapshotFile(),
    root: 'C:/repo',
    baselineRef: 'HEAD',
    config: CONFIG,
  })

  assert.match(prompt, new RegExp(`最多 ${CONFIG.verifierToolBudget} 次工具调用`))
  assert.match(prompt, /禁止：跑仓库测试套件/)
  assert.match(prompt, /推翻/)
})

test('large files are quoted as a diff only; small files keep their body', () => {
  const bigBody = `${'const big = 1\n'.repeat(Math.ceil(CONFIG.fullFileMaxChars / 12) + 10)}`
  const smallBody = 'const small = 1\n'
  const section = buildFileSection({
    files: [
      snapshotFile({ path: 'src/big.js', diff: '+const changed = 1\n', after: bigBody }),
      snapshotFile({ path: 'src/small.js', diff: '+const changed = 2\n', after: smallBody }),
    ],
    skipped: [],
    truncated: false,
  }, CONFIG)

  const bigBlock = section.blocks.find((block) => block.includes('src/big.js'))
  const smallBlock = section.blocks.find((block) => block.includes('src/small.js'))

  assert.match(bigBlock, /改动（unified diff/, '大文件仍要给出 diff')
  assert.doesNotMatch(bigBlock, /当前完整内容/, '超过 fullFileMaxChars 的文件不再附全文')
  assert.match(bigBlock, /正文未附/)
  assert.match(smallBlock, /当前完整内容/, '小文件保留全文上下文')
})

test('a file with no diff always keeps its body', () => {
  const section = buildFileSection({
    files: [snapshotFile({ path: 'src/nodiff.js', diff: '', after: 'const x = 1\n' })],
    skipped: [],
    truncated: false,
  }, CONFIG)

  assert.match(section.blocks[0], /当前完整内容/)
  assert.doesNotMatch(section.blocks[0], /正文未附/)
})
