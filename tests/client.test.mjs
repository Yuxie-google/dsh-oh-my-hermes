import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/**
 * The browser half is a plain script that hands dsh's module loader a factory.
 * Load it the way the loader does — with `window.__ModuleLoader__` and a
 * `require` for the shared client runtime modules — so a syntax error or a
 * wrong export shape fails here instead of in a browser console.
 */
const loadClient = () => {
  let spec
  globalThis.window = { __ModuleLoader__: { load: (value) => (spec = value) } }
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  vm.runInThisContext(code, { filename: 'lib/client.js' })
  assert.ok(spec, 'the bundle called __ModuleLoader__.load')
  const react = {
    createElement: () => null,
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const module = spec.factory((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require(${id})`)
  })
  return { spec, module }
}

test('the client bundle declares the plugin identity and slots dependency', () => {
  const { spec, module } = loadClient()
  assert.equal(spec.id, 'dsh-oh-my-hermes')
  assert.equal(module.name, 'dsh-oh-my-hermes-client')
  assert.deepEqual(module.inject, ['slots', 'modelDirectories'])
  assert.equal(typeof module.apply, 'function')
})

test('apply registers the settings section and an in-conversation command feedback slot', () => {
  const { module } = loadClient()
  const registered = []
  const ctx = {
    slots: {
      inject: (name, fn) => {
        assert.ok(['settings.section', 'conversation.input.dock', 'conversation.input.left'].includes(name))
        fn()
      },
      register: (spec, component) => {
        registered.push({ spec, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  assert.equal(registered.length, 3)
  const settings = registered.find((r) => r.spec.name === 'settings.section')
  const dock = registered.find((r) => r.spec.name === 'conversation.input.dock')
  assert.equal(settings.spec.id, 'oh-my-hermes')
  assert.equal(settings.spec.label, '远程 Hermes')
  assert.equal(typeof settings.component, 'function')
  const skills = registered.find((r) => r.spec.name === 'conversation.input.left')
  assert.equal(skills.spec.id, 'hermes-skills')
  assert.equal(typeof skills.component, 'function')
  assert.equal(dock.spec.id, 'hermes-command-result')
  assert.equal(typeof dock.component, 'function')
})

test('command feedback subscribes to the native command acknowledgment event', () => {
  const { module } = loadClient()
  const events = new Map()
  const ctx = { on: (name, fn) => events.set(name, fn), slots: { inject: (_, fn) => fn(), register: () => () => {} } }
  module.apply(ctx)
  const receive = events.get('command/executed')
  assert.equal(typeof receive, 'function')
  assert.doesNotThrow(() => receive('chat', 'hermes-profiles', { kind: 'success', text: 'default' }))
  assert.doesNotThrow(() => receive('chat', 'hermes-status', { kind: 'error', text: 'unknown host' }))
})

test('a dsh without the settings slot does not throw', () => {
  const { module } = loadClient()
  const ctx = {
    slots: {
      inject: () => {
        throw new Error('no such slot type')
      },
    },
  }
  const original = console.error
  console.error = () => {}
  try {
    assert.doesNotThrow(() => module.apply(ctx))
  } finally {
    console.error = original
  }
})
