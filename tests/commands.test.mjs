import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { HermesAdapter, apply } from '../lib/index.js'
import { registerCommandDefinitions, registerHermesCommands } from '../lib/commands.js'

function setup(t, hosts = [{ id: 'box', name: '测试主机', sshHost: 'example.test', models: [{ id: 'hermes', name: '默认模型' }, { id: 'a', hermesModel: 'remote-a' }] }]) {
  const adapter = new HermesAdapter({}, {
    hosts, persistSessions: false, stateDir: mkdtempSync(join(tmpdir(), 'hermes-commands-')),
    spawnProcess: () => { throw new Error('slash commands must never spawn') },
  })
  t.after(() => adapter.dispose())
  const definitions = new Map()
  let removed = 0
  const commands = { register: (def) => { definitions.set(def.name, def); return () => { removed++; definitions.delete(def.name) } } }
  const dispose = registerCommandDefinitions(commands, adapter)
  t.after(dispose)
  const invoke = (name, rawInput = '', provider = 'box', extra = {}) => definitions.get(name).handler({
    rawInput, attachments: [], agent: { id: 'chat', session: { id: 'chat', requestContext: () => provider ? { provider, model: 'hermes' } : undefined } }, ...extra,
  })
  return { adapter, definitions, commands, invoke, dispose, removed: () => removed }
}

test('seven native slash menu definitions register and dispose exactly once', (t) => {
  const { definitions, dispose, removed } = setup(t)
  assert.deepEqual([...definitions.keys()], ['hermes', 'hermes-status', 'hermes-models', 'hermes-profiles', 'hermes-hosts', 'hermes-reset', 'hermes-skills'])
  for (const definition of definitions.values()) assert.equal(typeof definition.description, 'string')
  dispose(); dispose()
  assert.equal(removed(), 7)
})

test('/hermes explains shortcuts, with matching subcommand aliases', (t) => {
  const { invoke } = setup(t)
  assert.match(invoke('hermes').text, /hermes-reset/)
  assert.equal(invoke('hermes', ' help ').kind, 'success')
  assert.deepEqual(invoke('hermes', ' models '), invoke('hermes-models'))
  assert.deepEqual(invoke('hermes', 'hosts'), invoke('hermes-hosts'))
})

test('skills commands resolve current identity, support explicit profiles and report SSH failure without model calls', async (t) => {
  const { adapter, invoke } = setup(t, [{ id: 'box', sshHost: 'example.test', models: [{ id: 'hermes', hermesProfile: 'coder' }, { id: 'other', hermesProfile: 'researcher' }] }])
  const calls = []
  let fail = false
  adapter.spawner = (_, args) => {
    calls.push(args.at(-1))
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}
    setImmediate(() => { (fail ? child.stderr : child.stdout).emit('data', fail ? 'Skill discovery failed' : '{"success":true,"skills":[{"name":"debugging","description":"Find bugs"}]}'); child.emit('close', fail ? 1 : 0) })
    return child
  }
  const result = await invoke('hermes-skills')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /coder · 可用技能 1 个/)
  assert.match(result.text, /debugging — Find bugs/)
  assert.ok(calls[0].endsWith("'hermes' 'coder'"))
  assert.equal((await invoke('hermes-skills', '', 'deepseek')).kind, 'error')
  assert.equal(calls.length, 1, 'ambiguous identity must not silently use default')
  assert.equal((await invoke('hermes', 'skills box researcher')).kind, 'success')
  assert.ok(calls[1].endsWith("'hermes' 'researcher'"))
  assert.equal((await invoke('hermes-skills', 'box ../bad')).kind, 'error')
  fail = true
  assert.equal((await invoke('hermes-skills')).kind, 'error')
  const signal = AbortSignal.abort()
  const count = calls.length
  assert.equal((await invoke('hermes-skills', '', 'box', { signal })).kind, 'error')
  assert.equal(calls.length, count)
})

test('status reads the invoking DSH session and reports mapping compatibility', (t) => {
  const { adapter, invoke } = setup(t)
  const store = adapter.storeFor('box')
  store.set('box:chat', { session: 'remote-chat', model: 'remote-a', scope: adapter.scopeOf(adapter.hosts[0]) })
  const result = invoke('hermes-status')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /remote-chat/)
  assert.match(result.text, /remote-a/)
  assert.match(result.text, /可续接/)
  adapter.applyDraft({ hosts: [{ id: 'box', sshHost: 'new.test' }] })
  assert.match(invoke('hermes-status').text, /目标配置已变化/)
})

test('model and host lists use the live catalog without an SSH or model request', (t) => {
  const { invoke } = setup(t)
  assert.match(invoke('hermes-models').text, /remote-a/)
  assert.match(invoke('hermes-hosts').text, /box · 测试主机 · 2 个模型/)
  assert.match(invoke('hermes-models').text, /模型选择器/)
})

test('reset clears only this host and this chat, with active-turn protection', (t) => {
  const { adapter, invoke } = setup(t)
  const store = adapter.storeFor('box')
  store.set('box:chat', { session: 'current', model: '' })
  store.set('box:other', { session: 'other', model: '' })
  adapter.locks.set('box:chat', Promise.resolve())
  assert.equal(invoke('hermes-reset').kind, 'error')
  assert.equal(store.get('box:chat').session, 'current')
  adapter.locks.clear()
  assert.match(invoke('hermes-reset').text, /已重置/)
  assert.equal(store.get('box:chat'), undefined)
  assert.equal(store.get('box:other').session, 'other')
  assert.match(invoke('hermes-reset').text, /无需重置/)
})

test('commands never reset a Hermes mapping implicitly while a different provider is selected', (t) => {
  const { adapter, invoke } = setup(t)
  adapter.storeFor('box').set('box:chat', { session: 'keep', model: '' })
  assert.equal(invoke('hermes-reset', '', 'deepseek').kind, 'error')
  assert.equal(adapter.storeFor('box').get('box:chat').session, 'keep')
  assert.equal(invoke('hermes-reset', 'box', 'deepseek').kind, 'success')
})

test('new single-host chats can use shortcuts before the first model turn', (t) => {
  const { invoke } = setup(t)
  assert.equal(invoke('hermes-status', '', undefined).kind, 'success')
  assert.match(invoke('hermes-status', '', null).text, /暂无/)
})

test('read-only model and profile lists work while DeepSeek is selected, before the first turn', (t) => {
  const { invoke, definitions } = setup(t)
  for (const name of ['hermes-profiles', 'hermes-models']) {
    assert.equal(invoke(name, '', 'deepseek').kind, 'success')
    assert.equal(definitions.get(name).handler({ rawInput: '' }).kind, 'success')
  }
})

test('read-only lists still require a host when multiple hosts are ambiguous', (t) => {
  const { invoke, definitions } = setup(t, [{ id: 'a', sshHost: 'a.test' }, { id: 'b', sshHost: 'b.test' }])
  assert.equal(invoke('hermes-profiles', '', 'deepseek').kind, 'error')
  assert.equal(definitions.get('hermes-models').handler({ rawInput: '' }).kind, 'error')
  assert.equal(invoke('hermes-profiles', 'b', 'deepseek').kind, 'success')
})

test('multi-host chats use their own route or an explicit host instead of guessing', (t) => {
  const { adapter, invoke } = setup(t, [{ id: 'a', sshHost: 'a.test' }, { id: 'b', sshHost: 'b.test' }])
  assert.equal(invoke('hermes-status', '', null).kind, 'error')
  assert.match(invoke('hermes-status', 'b', null).text, /（b）/)
  adapter.storeFor('a').set('a:chat', { session: 'only-a', model: '', scope: adapter.scopeOf(adapter.hosts[0]) })
  assert.match(invoke('hermes-status', '', null).text, /only-a/)
})

test('unknown actions, extra arguments and cancelled invocations return native command errors', (t) => {
  const { invoke } = setup(t)
  assert.equal(invoke('hermes', 'unknown').kind, 'error')
  assert.equal(invoke('hermes', 'help extra').kind, 'error')
  assert.equal(invoke('hermes-models', 'missing').kind, 'error')
  assert.equal(invoke('hermes-status', 'box extra').kind, 'error')
  const signal = AbortSignal.abort()
  assert.match(invoke('hermes-reset', '', 'box', { signal }).text, /已取消/)
})

test('late commands injection registers the menu and attaches lifecycle disposal', (t) => {
  const { adapter } = setup(t)
  const definitions = []
  let late, cleanup, disposed = 0
  registerHermesCommands({ inject: (deps, fn) => { assert.deepEqual(deps, ['commands']); late = fn } }, adapter)
  assert.equal(definitions.length, 0)
  late({ commands: { register: (def) => { definitions.push(def); return () => { disposed++ } } }, effect: (fn) => { cleanup = fn() } })
  assert.equal(definitions.length, 7)
  cleanup()
  assert.equal(disposed, 7)
})

test('a command name collision does not prevent the remaining shortcuts from registering', (t) => {
  const { adapter } = setup(t)
  const names = []
  const logs = []
  adapter.log = (text) => logs.push(text)
  const cleanup = registerCommandDefinitions({ register: (def) => {
    if (def.name === 'hermes') throw new Error('already registered')
    names.push(def.name); return () => {}
  } }, adapter)
  assert.equal(names.length, 6)
  assert.match(logs[0], /hermes not registered/)
  cleanup()
})

test('plugin entry mounts commands while keeping hosts without the commands service compatible', (t) => {
  let injected = false
  let cleanup
  const defs = []
  apply({
    llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => () => {} },
    inject: (deps, fn) => {
      if (deps[0] !== 'commands') return
      injected = true
      cleanup = fn({ commands: { register: (def) => { defs.push(def); return () => {} } } })
    },
    on: () => {},
  }, { hosts: [{ id: 'box', sshHost: 'x' }], stateDir: mkdtempSync(join(tmpdir(), 'hermes-command-entry-')) })
  assert.equal(injected, true)
  assert.equal(defs.length, 7)
  t.after(() => cleanup?.())
})
