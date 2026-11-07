/**
 * Skill registration.
 *
 * The skill body lives in `skills/review-kit/SKILL.md` and is loaded on demand:
 * only its short description enters the catalog every turn, so the detailed
 * "when to call / how to read the report" text costs nothing until the model
 * actually asks for it.
 *
 * @module dsh-review-kit/skill
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_NAME = 'review-kit'
const SKILL_SOURCE = 'custom'
/** Rank below the bundled root (600) and user skills (400/500), like other packaged skills. */
const SKILL_RANK = 550

const SKILL_DESCRIPTION = '对一次代码改动做证据门禁型只读评审：每条发现必须逐字引用真实代码行并经独立复核者尝试推翻，报告显式给出覆盖缺口。'
const SKILL_WHEN_TO_USE = '用户要求「审一下这次改动」「review 一下」「提交/合并前检查」，或刚完成一处修改需要独立验证正确性时。'

const INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: true })

/**
 * Drop a leading YAML frontmatter block.
 *
 * @param {string} text raw SKILL.md.
 * @returns {string} the body.
 */
function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end === -1) return text
  const after = text.indexOf('\n', end + 4)
  return after === -1 ? '' : text.slice(after + 1)
}

/**
 * Register the `review-kit` skill when the skills service is composed.
 *
 * @param {object} ctx host plugin context.
 * @param {object} config resolved config.
 * @returns {void}
 */
export function registerSkill(ctx, config) {
  if (config.registerSkill !== true) return
  if (typeof ctx.inject !== 'function') return

  const skillFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', SKILL_NAME, 'SKILL.md')

  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.skills.registerProvider(() => ({
      name: SKILL_NAME,
      async list() {
        return [{
          name: SKILL_NAME,
          description: SKILL_DESCRIPTION,
          whenToUse: SKILL_WHEN_TO_USE,
          invocation: { ...INVOCATION },
          source: SKILL_SOURCE,
          provider: SKILL_NAME,
          rank: SKILL_RANK,
          locator: skillFile,
          path: skillFile,
        }]
      },
      async get(candidate) {
        let text
        try {
          text = await readFile(candidate?.path ?? skillFile, 'utf8')
        } catch {
          return undefined
        }
        return {
          name: SKILL_NAME,
          description: SKILL_DESCRIPTION,
          whenToUse: SKILL_WHEN_TO_USE,
          invocation: { ...INVOCATION },
          source: SKILL_SOURCE,
          provider: SKILL_NAME,
          path: skillFile,
          resourceBase: { kind: 'directory', path: dirname(skillFile) },
          content: stripFrontmatter(text),
        }
      },
    }))
  })
}
