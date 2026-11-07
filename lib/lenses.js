/**
 * The four review lenses.
 *
 * A lens is a *constraint on what may be reported*, not a persona. Each one
 * states its focus, what it must not report, and the questions that force a
 * concrete failure chain. Orthogonality is the only reason to fan out at all:
 * four agents repeating "you are a senior engineer" just produce four noisy
 * copies of the same review.
 *
 * @module dsh-review-kit/lenses
 */

/** @type {Record<string, {key: string, label: string, focus: string, forbid: string, questions: string[]}>} */
export const LENSES = Object.freeze({
  correctness: {
    key: 'correctness',
    label: '正确性',
    focus: '逻辑错误、边界条件、空值/异常路径、错误的返回值、off-by-one、写反的条件判断',
    forbid: '代码风格、命名、性能、可读性、“建议补测试”',
    questions: [
      '这个分支在什么输入下会给出错误结果？',
      '空值、空数组、0、负数、超长输入分别会怎样？',
      '错误路径（抛异常、超时、失败返回）被正确处理了吗？',
    ],
  },
  lifecycle: {
    key: 'lifecycle',
    label: '生命周期与并发',
    focus: '资源释放、并发/竞态、异步顺序、订阅与监听泄漏、状态残留、清理遗漏',
    forbid: '一般性的逻辑错误（交给 correctness 视角）、性能、风格',
    questions: [
      '谁先谁后？写出会触发错误的时序。',
      '创建的资源在每条路径上都被释放了吗（含异常与取消路径）？',
      '回调/订阅在组件或会话结束后还会触发吗？',
      '共享状态在并发下会被交错修改吗？',
    ],
  },
  contract: {
    key: 'contract',
    label: '契约与接口',
    focus: '接口契约、类型不变量、调用方假设、错误码/异常语义、序列化格式、返回值形状',
    forbid: '内部实现细节偏好、性能、风格',
    questions: [
      '被违反的契约原文或调用点在哪里？',
      '调用方假设了什么，实现真的保证了吗？',
      '错误码/异常语义变了，谁会被破坏？',
      '返回值在两个版本之间形状一致吗？',
    ],
  },
  security: {
    key: 'security',
    label: '安全',
    focus: '注入、越权、路径穿越、密钥泄漏、TOCTOU、反序列化、危险默认值、SSRF',
    forbid: '一般性错误、性能、风格',
    questions: [
      '攻击者可控的输入从哪里进入？',
      '这个默认值在“字段缺失”时会放行还是拒绝？',
      '路径/命令/查询是否由不可信输入拼接？',
      '权限检查可以绕过吗？',
    ],
  },
})

/**
 * @param {readonly string[]} keys lens keys, already normalized.
 * @returns {Array<typeof LENSES[keyof typeof LENSES]>} lens definitions in canonical order.
 */
export function lensList(keys) {
  const out = []
  for (const key of keys) {
    const lens = LENSES[key]
    if (lens !== undefined) out.push(lens)
  }
  return out
}

/**
 * @param {string} key lens key.
 * @returns {string} human label.
 */
export function lensLabel(key) {
  return LENSES[key]?.label ?? String(key)
}
