/**
 * Loader-facing contract tests for the Host config schema and the Web client half.
 *
 * The schema is the loader's validation gate for row config: a field it does not
 * declare is stripped from an existing profile patch, so every `DEFAULT_CONFIG`
 * key must be declared and every default must match. The client half only works
 * if it registers the keyed `plugins.row.config` slot under the row's exact key.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { Config } from '../../lib/index.js'
import { DEFAULT_CONFIG, readConfigValue, resolveConfig } from '../../lib/config.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const VOLATILE_FIELDS = [
  'finderEffort', 'verifierEffort', 'toolBudgetBase', 'finderToolBudget',
  'finderToolBudgetMax', 'verifierToolBudget', 'verifierToolBudgetMax', 'childTimeoutMs',
]

test('Config 声明了 DEFAULT_CONFIG 的每一个字段，默认值逐字段一致', () => {
  const raw = Config({})
  assert.deepEqual(Object.keys(raw).sort(), Object.keys(DEFAULT_CONFIG).sort())
  // Settings only exposes `.volatile()` fields, and this is what the row's
  // configuration page edits; the rest of the config stays YAML-only.
  for (const key of VOLATILE_FIELDS) {
    assert.equal(typeof raw[key].get, 'function', `${key} 必须是 volatile，否则设置表单里看不到它`)
  }
  assert.equal(typeof raw.depth, 'string', '非表单字段保持普通值')
  assert.deepEqual(readConfigValue(Config({ childTimeoutMs: 60_000 }).childTimeoutMs), 60_000, '显式值要保留')
  // `lenses: []` is the stored "all four" marker; the resolved config expands it.
  const expected = { ...DEFAULT_CONFIG, lenses: resolveConfig({}).lenses }
  assert.deepEqual(resolveConfig(raw), expected, 'schema 默认值经 resolveConfig 必须还原成 DEFAULT_CONFIG')
  assert.equal(Config({ unknownKey: 1 }).unknownKey, 1, 'schema 宽松：未声明的键透传，不会丢掉用户的既有配置')
})

test('volatile 字段被原地更新后，重新 resolveConfig 能读到新值', () => {
  const raw = Config({})
  assert.equal(resolveConfig(raw).finderToolBudget, 6)
  const ref = raw.finderToolBudget
  const writer = Object.getOwnPropertySymbols(ref).find((symbol) => typeof ref[symbol] === 'function')
  assert.ok(writer !== undefined, 'volatile 引用必须带写入符号（loader 靠它原地提交新快照）')
  ref[writer](12)
  // The plugin must read the config per call; a snapshot taken in apply() would still say 6.
  assert.equal(resolveConfig(raw).finderToolBudget, 12)
  assert.equal(resolveConfig(raw).finderToolBudgetMax, 18, '其它字段不受影响')
})

test('package.json 暴露 client 半并声明 web 平台', () => {
  assert.equal(PACKAGE.exports['./client'], './lib/client.js')
  assert.equal(PACKAGE.dsh.client.platform, 'web')
  assert.equal(PACKAGE.dsh.client.immediately, true)
  assert.ok(PACKAGE.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'))
  assert.equal(PACKAGE.name, '@local/dsh-review-kit')
})

test('client 产物注册了行配置槽，键与行 id 一致', async () => {
  const captured = []
  const previous = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (spec) => { captured.push(spec) } } }
  try {
    await import(pathToFileURL(join(ROOT, 'lib', 'client.js')).href)
  } finally {
    globalThis.window = previous
  }

  assert.equal(captured.length, 1, 'client.js 必须调用一次 __ModuleLoader__.load')
  const spec = captured[0]
  assert.equal(spec.id, '@local/dsh-review-kit', 'factory id 必须等于包名')

  const fakeReact = {
    createElement: () => null,
    useState: () => [null, () => {}],
    useEffect: () => {},
  }
  const plugin = spec.factory((name) => {
    assert.equal(name, 'react', '只从浏览器模块表取 react')
    return fakeReact
  })
  assert.ok(plugin.inject.includes('slots'))
  assert.equal(typeof plugin.apply, 'function')

  let registered
  let injectedName
  plugin.apply({
    slots: {
      inject(name, callback) {
        injectedName = name
        callback()
      },
      register(options, component) {
        registered = { options, component }
      },
    },
  })

  assert.equal(injectedName, 'plugins.row.config')
  assert.equal(registered.options.name, 'plugins.row.config')
  assert.equal(registered.options.key, `${PACKAGE.name}#review-kit`, '键必须是 <包名>#<行 id>')
  assert.equal(typeof registered.component, 'function', '注册的是 React 组件')
})
