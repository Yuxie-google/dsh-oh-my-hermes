import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HermesAdapter, runRemote, normalizeHosts, validateDraft, writeConfigFile, configView } from '../lib/index.js'
import { buildRedactor } from '../lib/redact.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const drain = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
const options = (extra = {}) => ({ sessionId: 'chat', model: 'hermes', messages: [{ role: 'user', content: 'hello' }], ...extra })
class Child extends EventEmitter {
  constructor() {
    super()
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.stdin = new EventEmitter()
    this.stdin.end = (text) => { this.prompt = text }
    this.signals = []
  }
  kill(signal) { this.signals.push(signal); this.emit('close', -1) }
  complete(id = 'remote', code = 0) {
    this.stdout.emit('data', `${JSON.stringify({ type: 'result', session_id: id, exit_code: code, text: 'OK' })}\n`)
    this.emit('close', code)
  }
}
function fixture(t, config = {}) {
  const calls = []
  const adapter = new HermesAdapter({}, {
    stateDir: mkdtempSync(join(tmpdir(), 'hermes-regression-')), persistSessions: false,
    hosts: [{ id: 'box', sshHost: 'example.test', command: '/opt/hermes', remoteCwd: '/work' }],
    spawnProcess: (command, args) => { const child = new Child(); calls.push({ command, args, child }); return child }, ...config,
  })
  t.after(() => adapter.dispose())
  return { adapter, calls }
}

test('a queued turn reads the preceding turn’s committed resume id', async (t) => {
  const { adapter, calls } = fixture(t)
  const first = drain(adapter.stream('box', options()))
  await tick()
  const second = drain(adapter.stream('box', options({ messages: [{ role: 'assistant', content: 'OK' }, { role: 'user', content: 'next' }] })))
  await tick()
  assert.equal(calls.length, 1)
  calls[0].child.complete('committed')
  await first; await tick()
  assert.match(calls[1].args.at(-1), /--resume 'committed'/)
  assert.equal(calls[1].child.prompt, 'next')
  calls[1].child.complete('committed')
  await second
  assert.equal(adapter.locks.size, 0)
})

test('disabling persistence still resumes during this process', async (t) => {
  const { adapter, calls } = fixture(t)
  const first = drain(adapter.stream('box', options()))
  await tick(); calls[0].child.complete('memory'); await first
  const second = drain(adapter.stream('box', options()))
  await tick()
  assert.match(calls[1].args.at(-1), /--resume 'memory'/)
  calls[1].child.complete('memory'); await second
  assert.equal(adapter.storeFor('box').file, '')
})

test('already cancelled requests spawn nothing', async (t) => {
  const { adapter, calls } = fixture(t)
  const controller = new AbortController(); controller.abort()
  const chunks = await drain(adapter.stream('box', options({ signal: controller.signal })))
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
  assert.equal(calls.length, 0)
})

test('cancelling a queued request returns immediately without bypassing the running turn', async (t) => {
  const { adapter, calls } = fixture(t)
  const first = drain(adapter.stream('box', options()))
  await tick()
  const controller = new AbortController()
  const second = drain(adapter.stream('box', options({ signal: controller.signal })))
  await tick(); controller.abort()
  assert.equal((await second).at(-1).reason.kind, 'aborted')
  const third = drain(adapter.stream('box', options()))
  await tick(); assert.equal(calls.length, 1)
  calls[0].child.complete('first'); await first; await tick()
  assert.equal(calls.length, 2)
  calls[1].child.complete('third'); await third
  assert.equal(adapter.locks.size, 0)
})

test('endpoint and cwd changes rebuild the remote session with the transcript', async (t) => {
  const { adapter, calls } = fixture(t)
  const first = drain(adapter.stream('box', options()))
  await tick(); calls[0].child.complete('old-box'); await first
  adapter.applyDraft(validateDraft({ hosts: [{ id: 'box', sshHost: 'other.test', command: '/opt/hermes', remoteCwd: '/new' }] }))
  const second = drain(adapter.stream('box', options({ messages: [{ role: 'user', content: 'old text' }, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'next' }] })))
  await tick()
  assert.doesNotMatch(calls[1].args.at(-1), /--resume/)
  assert.match(calls[1].child.prompt, /old text/)
  calls[1].child.complete('new-box'); await second
})

test('interrupted sessions drop the resume mapping and can be reset after stopping', async (t) => {
  const { adapter, calls } = fixture(t)
  const first = drain(adapter.stream('box', options()))
  await tick(); calls[0].child.complete('old'); await first
  const controller = new AbortController()
  const second = drain(adapter.stream('box', options({ signal: controller.signal })))
  await tick()
  assert.throws(() => adapter.resetSession('box', 'chat'), /运行或排队/)
  controller.abort(); await second
  assert.equal(adapter.sessionsView().length, 0)
  adapter.resetSession('box', 'chat')
})

test('SSH exit zero without a completion frame reports a protocol error', async (t) => {
  const { adapter, calls } = fixture(t)
  const task = drain(adapter.stream('box', options()))
  await tick(); calls[0].child.emit('close', 0)
  const chunks = await task
  assert.equal(chunks.at(-1).reason.failure.code, 'HERMES_PROTOCOL')
  assert.equal(adapter.sessionsView().length, 0)
})

test('SSH failure after a successful frame never commits its session', async (t) => {
  const { adapter, calls } = fixture(t)
  const task = drain(adapter.stream('box', options()))
  await tick()
  calls[0].child.stdout.emit('data', '{"type":"result","session_id":"bad","exit_code":0}\n')
  calls[0].child.emit('close', 255)
  assert.equal((await task).at(-1).reason.kind, 'error')
  assert.equal(adapter.sessionsView().length, 0)
})

test('a synchronous spawn failure finishes cleanly and releases its lock', async (t) => {
  const { adapter } = fixture(t, { spawnProcess: () => { throw new Error('spawn EPERM') } })
  assert.equal((await drain(adapter.stream('box', options()))).at(-1).reason.kind, 'error')
  assert.equal(adapter.locks.size, 0)
})

test('connection and model probes use the same SSH key, port and jump host options', async (t) => {
  const { adapter, calls } = fixture(t, { sshArgs: ['-p', '2222', '-i', 'C:/key', '-J', 'jump'] })
  const task = runRemote(adapter, adapter.hosts[0], 'hermes --version')
  assert.deepEqual(calls[0].args.slice(-8), ['-p', '2222', '-i', 'C:/key', '-J', 'jump', 'example.test', 'hermes --version'])
  calls[0].child.stdout.emit('data', 'Hermes 1.0'); calls[0].child.emit('close', 0)
  assert.equal((await task).stdout, 'Hermes 1.0')
  assert.equal(adapter.children.size, 0)
})

test('session reset removes only the local mapping and persists the change', async (t) => {
  const { adapter, calls } = fixture(t, { persistSessions: true })
  const task = drain(adapter.stream('box', options()))
  await tick(); calls[0].child.complete('retained-remotely'); await task
  assert.equal(adapter.sessionsView()[0].remoteSession, 'retained-remotely')
  adapter.resetSession('box', 'chat')
  assert.equal(adapter.sessionsView().length, 0)
  assert.equal(calls.length, 1)
})

test('saved host changes remain visible until DSH restarts', (t) => {
  const { adapter } = fixture(t)
  const draft = validateDraft({ hosts: [{ id: 'new-box', sshHost: 'new.test' }] })
  writeConfigFile(adapter.configFile, draft)
  assert.equal(adapter.applyDraft(draft).live, false)
  const view = configView(adapter)
  assert.equal(view.restartRequired, true)
  assert.equal(view.hosts[0].id, 'new-box')
  assert.deepEqual(view.providerIds, ['box'])
})

test('unsafe route filenames and SSH option injection are rejected', () => {
  for (const id of ['../config', '..\\config', 'a/b', 'C:temp']) assert.throws(() => normalizeHosts({ hosts: [{ id, sshHost: 'x' }] }), /host id/)
  for (const sshHost of ['-oProxyCommand=bad', 'x y', 'x\ny']) assert.throws(() => normalizeHosts({ hosts: [{ sshHost }] }), /sshHost/)
})

test('activity masks inherited and remote credentials', () => {
  const redact = buildRedactor({ API_KEY: 'local-secret-123', SECRETARY: 'not-a-secret' })
  const text = redact('local-secret-123 not-a-secret {"api_key":"remote-secret"} Bearer tok123 https://user:pass@host')
  assert.doesNotMatch(text, /local-secret-123|remote-secret|tok123|user:pass/)
  assert.match(text, /not-a-secret/)
})

test('closing the consumer early invalidates the preceding persisted resume id', async (t) => {
  const { adapter, calls } = fixture(t, { persistSessions: true })
  const first = drain(adapter.stream('box', options()))
  await tick(); calls[0].child.complete('old'); await first
  const iterator = adapter.stream('box', options())
  const next = iterator.next()
  await tick()
  calls[1].child.stdout.emit('data', '{"type":"text","text":"partial"}\n')
  // The child can finish before DSH stops consuming its queued blocks.
  calls[1].child.emit('close', 0)
  await next
  await iterator.return()
  assert.equal(adapter.storeFor('box').get('box:chat'), undefined)
  assert.equal(adapter.locks.size, 0)
})

test('a child ignoring termination cannot keep a timed-out turn locked', async (t) => {
  const { adapter, calls } = fixture(t, { turnTimeoutMs: 10, idleTimeoutMs: 0 })
  const task = drain(adapter.stream('box', options()))
  await tick()
  const child = calls[0].child
  child.kill = (signal) => { child.signals.push(signal) } // no close event, including after SIGKILL
  const keepAlive = setTimeout(() => {}, 2500)
  t.after(() => clearTimeout(keepAlive))
  assert.equal((await task).at(-1).reason.failure.code, 'TIMEOUT')
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(adapter.locks.size, 0)
})
