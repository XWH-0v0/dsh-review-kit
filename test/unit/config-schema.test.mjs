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
import { DEFAULT_CONFIG } from '../../lib/config.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('Config 声明了 DEFAULT_CONFIG 的每一个字段，默认值逐字段一致', () => {
  const resolved = Config({})
  assert.deepEqual(Object.keys(resolved).sort(), Object.keys(DEFAULT_CONFIG).sort())
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.deepEqual(resolved[key], value, `${key} 的 schema 默认值与 DEFAULT_CONFIG 不一致`)
  }
  assert.deepEqual(Config({ childTimeoutMs: 60_000 }).childTimeoutMs, 60_000, '显式值要保留')
  assert.equal(Config({ unknownKey: 1 }).unknownKey, 1, 'schema 宽松：未声明的键透传，不会丢掉用户的既有配置')
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
