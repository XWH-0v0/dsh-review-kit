/**
 * Read-only git access.
 *
 * Review Kit never spawns a shell for git: by default it asks the *calling
 * agent's* executor to run the command through its own shell tool, so the
 * deployment's permission, sandbox and audit path stays in charge. Only the
 * explicit `gitMode: 'process'` fallback (or a composition with no shell tool)
 * runs `git` directly, and even then only the read-only plumbing commands this
 * module exposes.
 *
 * @module dsh-review-kit/git
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { textOfContent } from './text.js'

/** stdout/stderr ceiling for one git command. */
const MAX_BUFFER = 64 * 1024 * 1024

/** A git invocation that did not succeed. */
export class GitError extends Error {
  /**
   * @param {string} message readable failure.
   * @param {{stderr?: string, code?: string}} [details] process details.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'GitError'
    this.stderr = details.stderr ?? ''
    this.code = details.code ?? ''
  }
}

/**
 * Quote one argv element for PowerShell.
 *
 * @param {unknown} value raw argument.
 * @returns {string} a single-quoted PowerShell literal.
 */
function pwshQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Quote one argv element for a POSIX shell.
 *
 * @param {unknown} value raw argument.
 * @returns {string} a single-quoted POSIX literal.
 */
function posixQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

/**
 * The shell tools append presentation markers to their content. A trailing
 * `[exit code: N]` and a `[stderr]` section are not command output, so they are
 * stripped before the text is parsed as git data.
 *
 * @param {unknown} value raw shell-tool text.
 * @returns {string} the command's stdout.
 */
function cleanShellOutput(value) {
  let text = String(value ?? '')
  text = text.replace(/\n?\[exit code: -?\d+\]\s*$/g, '')
  const stderrAt = text.indexOf('\n[stderr]')
  if (text.startsWith('[stderr]')) return ''
  if (stderrAt !== -1) return text.slice(0, stderrAt)
  return text
}

/**
 * @param {unknown} value raw shell-tool text.
 * @returns {number} the reported exit code, or 0 when absent.
 */
function exitCodeOf(value) {
  const matches = [...String(value ?? '').matchAll(/\[exit code: (-?\d+)\]/g)]
  if (matches.length === 0) return 0
  return Number.parseInt(matches[matches.length - 1][1], 10)
}

/**
 * @param {string} text raw failure text.
 * @returns {string} a single-line, bounded failure summary.
 */
function summarizeFailure(text) {
  const lines = String(text ?? '')
    .replace(/\[(?:stderr|stdout|exit code: -?\d+)\]/g, ' ')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('usage:'))
    .slice(0, 2)
    .join(' ')
  return lines.slice(0, 300)
}

/**
 * Extract the model-facing text and error flag from a tool batch result,
 * tolerating the executor envelope shapes this plugin can observe.
 *
 * @param {unknown} batch `ctx.tools.execute` result.
 * @returns {{isError: boolean, text: string}} the extracted outcome.
 */
function readToolBatch(batch) {
  if (typeof batch === 'string') {
    return { isError: exitCodeOf(batch) !== 0, text: cleanShellOutput(batch) }
  }
  const entry = Array.isArray(batch?.results) ? batch.results[0] : undefined
  const result = entry?.result ?? entry
  if (result === undefined || result === null) return { isError: true, text: '工具执行没有返回结果' }
  if (typeof result === 'string') {
    return { isError: exitCodeOf(result) !== 0, text: cleanShellOutput(result) }
  }
  const raw = textOfContent(result.content)
  const exitCode = exitCodeOf(raw)
  const isError = result.isError === true
    || entry?.isError === true
    || exitCode !== 0
    || /^Error:/.test(raw)
  const cleaned = cleanShellOutput(raw)
  if (!isError) return { isError: false, text: cleaned }
  const message = cleaned.length > 0 ? cleaned : raw
  return { isError: true, text: message.length > 0 ? message : (result.error?.message ?? '未知工具错误') }
}

/**
 * @param {unknown} error a failure thrown by the shell-tool path.
 * @returns {boolean} whether the shell path was simply unavailable.
 */
function isInfrastructureFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /UNKNOWN_TOOL|no executor|executor[^\n]*unavailable|not registered|工具执行没有返回结果/i.test(message)
}

/**
 * Create the git runner for one review.
 *
 * @param {object} options runner options.
 * @param {string} options.cwd directory the commands run in.
 * @param {object} [options.ctx] host plugin context (optional in tests).
 * @param {{agent?: object}} [options.exec] current tool execution, for agent scoping.
 * @param {object} options.config resolved plugin config.
 * @param {{warn?: Function}} [options.logger] optional logger.
 * @returns {{run: Function, tryRun: Function, cwd: string, describe: Function}} the runner.
 */
export function createGit({ cwd: initialCwd, ctx, exec, config, logger }) {
  const cwd = initialCwd
  let shellToolChecked = false
  let shellTool = null
  let counter = 0

  const detectShellTool = () => {
    if (shellToolChecked) return shellTool
    shellToolChecked = true
    if (ctx === undefined || ctx === null) return null
    if (typeof ctx.tools?.get !== 'function' || typeof ctx.tools?.execute !== 'function') return null
    const scope = exec?.agent
    for (const candidate of ['pwsh', 'bash']) {
      let found
      try {
        found = scope !== undefined ? ctx.tools.get(candidate, scope) : undefined
      } catch {
        found = undefined
      }
      if (found === undefined) {
        try {
          found = ctx.tools.get(candidate)
        } catch {
          found = undefined
        }
      }
      if (found !== undefined) {
        shellTool = candidate
        break
      }
    }
    return shellTool
  }

  const runViaTool = async (args, { signal }) => {
    const toolName = detectShellTool()
    const quote = toolName === 'pwsh' ? pwshQuote : posixQuote
    const command = `git --no-pager -c core.quotepath=false ${args.map(quote).join(' ')}`
    const payload = toolName === 'pwsh'
      ? { command, description: '只读 git 查询（review-kit）', workdir: cwd }
      : { command: `cd ${quote(cwd)} && ${command}` }
    const callId = `review-git-${(counter += 1)}-${randomUUID().slice(0, 8)}`
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: callId, name: toolName, arguments: JSON.stringify(payload) }],
      ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
      signal,
    })
    const { isError, text } = readToolBatch(batch)
    if (isError) throw new GitError(`git 命令失败：${summarizeFailure(text) || '（无输出）'}`)
    return text
  }

  const runViaProcess = (args, { signal }) => new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['--no-pager', '-c', 'core.quotepath=false', ...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout: config.gitTimeoutMs,
        windowsHide: true,
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout ?? '')
          return
        }
        if (error.name === 'AbortError') {
          reject(error)
          return
        }
        reject(new GitError(
          `git ${args.slice(0, 2).join(' ')} 失败：${summarizeFailure(String(stderr || error.message)) || '（无输出）'}`,
          { code: String(error.code ?? ''), stderr: String(stderr ?? '') },
        ))
      },
    )
    child.on('error', (error) => {
      if (error.name !== 'AbortError') reject(new GitError(`无法启动 git：${error.message}`))
    })
  })

  /**
   * Run one read-only git command.
   *
   * @param {string[]} args git arguments, without the global options.
   * @param {{signal?: AbortSignal, cwd?: string}} [options] execution options.
   * @returns {Promise<string>} stdout.
   */
  const run = async (args, options = {}) => {
    const signal = options.signal
    const useTool = config.gitMode === 'tool'
      || (config.gitMode === 'auto' && detectShellTool() !== null)
    try {
      if (useTool) return await runViaTool(args, { signal })
      return await runViaProcess(args, { signal })
    } catch (error) {
      if (useTool && config.gitMode === 'auto' && isInfrastructureFailure(error)) {
        logger?.warn?.(`[review-kit] shell tool unavailable for git; falling back to a direct process: ${error instanceof Error ? error.message : String(error)}`)
        return runViaProcess(args, { signal })
      }
      throw error
    }
  }

  /**
   * Run one read-only git command and report failure instead of throwing.
   *
   * @param {string[]} args git arguments.
   * @param {{signal?: AbortSignal}} [options] execution options.
   * @returns {Promise<{ok: boolean, stdout: string, error?: Error}>} outcome.
   */
  const tryRun = async (args, options = {}) => {
    try {
      return { ok: true, stdout: await run(args, options) }
    } catch (error) {
      return { ok: false, stdout: '', error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  return {
    cwd,
    run,
    tryRun,
    /**
     * @returns {string} which transport this runner would use.
     */
    describe: () => (config.gitMode === 'tool' || (config.gitMode === 'auto' && detectShellTool() !== null) ? `shell-tool:${detectShellTool()}` : 'process'),
  }
}
