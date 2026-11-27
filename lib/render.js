/**
 * Markdown report rendering.
 *
 * The report is what the model reads and what the user pastes into a PR
 * comment, so it must stay honest about silence: a clean run states what it
 * covered, and a partial run states what it missed.
 *
 * @module dsh-review-kit/render
 */

import { SEVERITY_ICON } from './config.js'
import { excerpt, formatDuration, normalizeLine } from './text.js'
import { lensLabel } from './lenses.js'

const ORIGIN_LABEL = Object.freeze({
  introduced: '本次改动引入',
  preexisting: '基线中原本存在',
  unknown: '无法判定',
  maybe: '可能原本存在',
})

const STATUS_LABEL = Object.freeze({
  completed: '完成',
  partial: '部分完成（存在覆盖缺口）',
  aborted: '已中断（结果不完整）',
  failed: '失败',
})

/**
 * Group confirmed claims that quote the same line of the same file.
 *
 * Claim identity is `(kind, file, anchor)`: two lenses may legitimately produce
 * two different claims about one line, and each gets its own verifier. Printing
 * both as top-level sections reads like a duplicate report, so the first claim
 * keeps the section and the others are listed underneath it as independent
 * conclusions — never merged, never dropped.
 *
 * @param {object[]} findings confirmed findings in report order.
 * @returns {object[][]} location groups, each in report order.
 */
function groupByLocation(findings) {
  const groups = new Map()
  for (const finding of findings) {
    const key = `${finding.file}\u0000${finding.line ?? 0}\u0000${normalizeLine(finding.anchor)}`
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, [finding])
    else existing.push(finding)
  }
  return [...groups.values()]
}

/**
 * @param {object} finding confirmed finding.
 * @returns {string[]} report lines for one finding.
 */
function renderConfirmed(finding) {
  const lines = []
  const icon = SEVERITY_ICON[finding.severity] ?? '⚪'
  const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file
  lines.push(`### ${icon} ${finding.severity} · ${location} — ${finding.title}`)
  lines.push('')
  lines.push(`\`${excerpt(finding.anchor, 300)}\``)
  lines.push('')
  lines.push(finding.detail)
  lines.push('')
  lines.push(`- **失败场景**：${finding.failureScenario}`)
  const verdict = finding.verifications[0]
  if (verdict !== undefined) {
    const reproduced = finding.reproduced === true || finding.verifications.some((item) => item.reproduced === true)
    lines.push(`- **复核**：✓ 无法推翻 · 置信度 ${finding.confidence.toFixed(2)} · 复现：${reproduced ? '是' : '否'}${verdict.reasoning ? ` — ${excerpt(verdict.reasoning, 500)}` : ''}`)
  }
  const origin = finding.originHint === 'possibly-preexisting' && finding.origin === 'unknown'
    ? ORIGIN_LABEL.maybe
    : ORIGIN_LABEL[finding.origin] ?? ORIGIN_LABEL.unknown
  lines.push(`- **归属**：${origin}`)
  if (typeof finding.suggestedFix === 'string' && finding.suggestedFix.length > 0) {
    lines.push(`- **建议**：${finding.suggestedFix}`)
  }
  if (finding.lenses.length > 1) {
    lines.push(`- **佐证**：${finding.lenses.map((key) => lensLabel(key)).join(' + ')} 双视角`)
  }
  lines.push('')
  return lines
}

/**
 * @param {object[]} findings rejected findings.
 * @param {string} title summary label.
 * @param {string} emptyLabel fallback line.
 * @returns {string[]} a collapsible section.
 */
function renderRejected(findings, title, emptyLabel) {
  if (findings.length === 0) return []
  const lines = ['<details>', `<summary>${title}：${findings.length} 条</summary>`, '']
  for (const finding of findings) {
    const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file
    const reason = excerpt(finding.reason ?? finding.refutation ?? '', 400)
    lines.push(`- \`${location}\` · ${finding.severity} · ${finding.title} — ${reason || emptyLabel}`)
  }
  lines.push('')
  lines.push('</details>')
  lines.push('')
  return lines
}

/**
 * Render the whole report.
 *
 * @param {object} report report data.
 * @param {string} report.status run status.
 * @param {string} report.targetDescription scope line.
 * @param {object[]} report.confirmed confirmed findings.
 * @param {object[]} report.refuted refuted findings.
 * @param {object[]} report.unverified unverified findings.
 * @param {object} report.coverage coverage record.
 * @param {object} report.stats counters.
 * @returns {string} markdown.
 */
export function renderMarkdown({ status, targetDescription, confirmed, refuted, unverified, coverage, stats }) {
  const lines = []
  const groups = groupByLocation(confirmed)
  const confirmLabel = groups.length < confirmed.length
    ? `${confirmed.length} 条确认（${groups.length} 处代码位置）`
    : `${confirmed.length} 条确认`
  const header = [`## 代码评审：${confirmLabel}`, `${refuted.length} 条被推翻`]
  if (unverified.length > 0) header.push(`${unverified.length} 条未验证`)
  lines.push(header.join(' / '))
  lines.push('')
  lines.push(`- 范围：${targetDescription}`)
  const statusLabel = status === 'aborted' && coverage.abortedBy === 'timeout'
    ? '已超时（结果不完整）'
    : STATUS_LABEL[status] ?? status
  lines.push(`- 状态：${statusLabel} · 深度 ${coverage.depth} · 用时 ${formatDuration(coverage.durationMs)}`)
  for (const note of coverage.notes) lines.push(`- 说明：${note}`)
  lines.push('')

  if (confirmed.length === 0) {
    lines.push('**没有可确认的问题。** 这不等于「没有问题」：请先看下面的覆盖缺口，再决定能否接受。')
    lines.push('')
  } else {
    for (const group of groups) {
      lines.push(...renderConfirmed(group[0]))
      if (group.length > 1) {
        // Two lenses filed two claims about the same line. Each was verified on
        // its own, so list them instead of merging them into the first claim.
        lines.push('- **同一代码行的其他独立结论（各自复核，未合并）**：')
        for (const extra of group.slice(1)) {
          const icon = SEVERITY_ICON[extra.severity] ?? '⚪'
          const verdict = extra.verifications[0]
          const reproduced = extra.reproduced === true || extra.verifications.some((item) => item.reproduced === true)
          const confidence = Number.isFinite(extra.confidence) ? extra.confidence : 0
          const reasoning = verdict?.reasoning ? ` — ${excerpt(verdict.reasoning, 300)}` : ''
          lines.push(`  - ${icon} ${extra.severity} · ${extra.title} · 复核：✓ 无法推翻 · 置信度 ${confidence.toFixed(2)} · 复现：${reproduced ? '是' : '否'}${reasoning}`)
        }
        lines.push('')
      }
    }
  }

  lines.push(...renderRejected(refuted, '被推翻的发现（复核给出了反证）', '复核未给出理由'))
  lines.push(...renderRejected(unverified, '未验证的发现', '复核不可用'))

  lines.push('---')
  lines.push('')
  lines.push('**覆盖**')
  const failed = new Map(coverage.lensesFailed.map((item) => [item.lens, item.reason]))
  const clean = new Set(coverage.lensesClean)
  for (const lens of coverage.lensesRun) {
    if (failed.has(lens)) {
      lines.push(`- ${lensLabel(lens)} ⚠️ 失败：${failed.get(lens)}`)
    } else if (clean.has(lens)) {
      lines.push(`- ${lensLabel(lens)} ✅ 已跑，无发现`)
    } else {
      lines.push(`- ${lensLabel(lens)} ✔ 已跑，有候选`)
    }
  }
  if (coverage.lensesRun.length === 0) lines.push('- （没有任何视角完成）')

  const reviewedCount = coverage.filesReviewed.length
  const skipText = coverage.filesSkipped.length > 0
    ? `；跳过 ${coverage.filesSkipped.length} 个（${coverage.filesSkipped.slice(0, 6).map((item) => `\`${item.path}\`：${item.reason}`).join('；')}${coverage.filesSkipped.length > 6 ? '；…' : ''}）`
    : ''
  lines.push(`- 文件：${reviewedCount} 个已评审${skipText}`)
  lines.push(`- 统计：发现 ${stats.candidates} → 有效 ${stats.valid} → 无效引用 ${stats.invalid} → 去重 ${stats.deduped} → 预算裁剪 ${stats.dropped} → 复核 ${stats.verified} → 确认 ${stats.confirmed} / 推翻 ${stats.refuted}${stats.unverified > 0 ? ` / 未验证 ${stats.unverified}` : ''}`)
  lines.push(`- 子代理：${coverage.childRuns} 次${coverage.aborted ? (coverage.abortedBy === 'timeout' ? ' · 整体超时' : ' · 用户中断') : ''}`)
  lines.push('')
  lines.push('> 确认 = 独立复核者读过真实代码后仍无法推翻；被推翻 = 复核者给出反证或缺陷不成立；未验证 = 复核者不可用（由配置决定按未通过还是单列）。')
  if (groups.some((group) => group.length > 1)) {
    lines.push('> 「同一代码行的其他独立结论」是另外的结论，各自有复核者；它们与上面那条共用一行代码，不是重复上报。')
  }
  return lines.join('\n')
}
