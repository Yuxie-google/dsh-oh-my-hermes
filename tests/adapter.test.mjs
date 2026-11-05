import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HermesAdapter,
  apply,
  buildPrompt,
  normalizeHosts,
  normalizeModels,
  selectTurns,
  textOf,
  explain,
} from '../lib/index.js'

// ── helpers ──────────────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  constructor({ lines = [], stderr = '', code = 0, hang = false } = {}) {
    super()
    this.killed = false
    this.hang = hang
    this.stdout = new EventEmitter()
    this.stdout.setEncoding = () => {}
    this.stderr = new EventEmitter()
    this.stderr.setEncoding = () => {}
    this.stdin = new EventEmitter()
    this.stdin.end = (text) => {
      this.stdinText = text
    }
    setImmediate(() => {
      for (const line of lines) this.stdout.emit('data', `${line}\n`)
      if (stderr) this.stderr.emit('data', stderr)
      if (!hang) this.emit('close', code)
    })
  }

  kill() {
    this.killed = true
    if (this.hang) {
      this.hang = false
      this.emit('close', null)
    }
  }
}

const frame = (value) => JSON.stringify(value)

const makeAdapter = (config = {}, { lines = [], stderr = '', code = 0, hang = false } = {}) => {
  const child = new FakeChild({ lines, stderr, code, hang })
  const spawns = []
  const ctx = { llm: { registerAdapter: () => {}, registerConfigurableProviders: () => () => {} }, logger: () => undefined }
  const adapter = new HermesAdapter(ctx, {
    // Isolate the plugin state dir: the real one holds the user's saved config, which
    // would otherwise override the hosts these tests declare.
    stateDir: mkdtempSync(join(tmpdir(), 'oh-my-hermes-adapter-')),
    hosts: [{ id: 'hermes-remote', name: 'Test box', sshHost: 'example.test', sshUser: 'ubuntu' }],
    command: '/home/ubuntu/.local/bin/hermes',
    remoteCwd: '/home/ubuntu',
    persistSessions: false,
    ...config,
    spawnProcess: (command, args, options) => {
      spawns.push({ command, args, options })
      return child
    },
  })
  return { adapter, child, spawns }
}

const drain = async (iterator) => {
  const chunks = []
  for await (const chunk of iterator) chunks.push(chunk)
  return chunks
}

const textOfChunks = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const kinds = (chunks) => chunks.map((c) => c.type)

// ── prompt building ──────────────────────────────────────────────────────────

test('textOf flattens text blocks and marks attachments', () => {
  assert.equal(textOf('hi'), 'hi')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a[image]b')
  assert.equal(textOf(undefined), '')
})

test('fresh prompt carries the whole transcript, resume carries only the new turn', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Remember PLUM' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
    { role: 'user', content: [{ type: 'text', text: 'Which word?' }] },
  ]
  assert.equal(selectTurns(messages, false).length, 3)
  assert.equal(selectTurns(messages, true).length, 1)
  assert.equal(buildPrompt(messages, true), 'Which word?')
  assert.equal(buildPrompt(messages, false), '[user]\nRemember PLUM\n\n[assistant]\nOK\n\n[user]\nWhich word?')
})

test('a resumed turn with no new user text falls back to the last turn', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'first' }] }]
  assert.equal(buildPrompt(messages, true), 'first')
})

test('an empty turn is refused', () => {
  assert.throws(() => buildPrompt([{ role: 'user', content: [{ type: 'text', text: '' }] }], false), /no text/)
  assert.throws(() => buildPrompt([], false), /no text/)
})

// ── configuration ────────────────────────────────────────────────────────────

test('a bare sshHost is accepted as a single host', () => {
  const hosts = normalizeHosts({ sshHost: '10.0.0.5', sshUser: 'ubuntu', providerId: 'hermes-remote', command: '/opt/hermes' })
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].id, 'hermes-remote')
  assert.equal(hosts[0].target, 'ubuntu@10.0.0.5')
  assert.equal(hosts[0].command, '/opt/hermes')
  assert.equal(hosts[0].models[0].id, 'hermes')
})

test('hosts get ids, names and duplicate ids are refused', () => {
  const hosts = normalizeHosts({
    models: [{ id: 'm', name: 'M', contextWindow: 300000 }],
    hosts: [{ sshHost: 'a.test' }, { sshHost: 'b.test', name: 'B' }],
  })
  assert.deepEqual(hosts.map((h) => h.id), ['hermes-remote', 'hermes-remote-2'])
  assert.equal(hosts[1].name, 'B')
  assert.equal(hosts[0].models[0].contextWindow, 300000)
  assert.throws(() => normalizeHosts({ hosts: [{ sshHost: 'a' }, { sshHost: 'b', id: 'hermes-remote' }] }), /duplicate/)
})

test('model rows get defaults and a fallback row', () => {
  assert.equal(normalizeModels([])[0].id, 'hermes')
  const [row] = normalizeModels([{ id: 'sonnet', hermesModel: 'anthropic/claude-sonnet-4' }])
  assert.equal(row.name, 'sonnet')
  assert.equal(row.contextWindow, 200000)
  assert.equal(row.hermesModel, 'anthropic/claude-sonnet-4')
})

// ── catalogue ────────────────────────────────────────────────────────────────

test('catalogue exposes the configured rows per provider', async () => {
  const { adapter } = makeAdapter({ models: [{ id: 'hermes', name: 'Remote default' }] })
  assert.equal(adapter.providerInfo('hermes-remote').name, 'Test box')
  const models = await adapter.listModels('hermes-remote')
  assert.deepEqual(models.map((m) => m.id), ['hermes'])
  const resolved = await adapter.resolveModel('hermes-remote', 'hermes')
  assert.equal(resolved.context.contextWindow, 200000)
  assert.equal(resolved.reasoning.defaultEffort, 'medium')
  await assert.rejects(adapter.listModels('nope'), /unknown provider/)
})

// ── streaming ────────────────────────────────────────────────────────────────

test('text frames become one text block, then usage and finish', async () => {
  const { adapter, spawns } = makeAdapter({}, {
    lines: [
      frame({ type: 'system', subtype: 'init' }),
      'Session: local-abc',
      frame({ type: 'text', text: 'OK' }),
      frame({ type: 'text', text: '1' }),
      frame({ type: 'result', session_id: 'local-abc', exit_code: 0, text: 'OK1', tokens: { input: 100, output: 2, cache_read: 40 } }),
    ],
  })

  const chunks = await drain(adapter.stream('hermes-remote', {
    sessionId: 's1',
    model: 'hermes',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'say OK1' }] }],
  }))

  assert.deepEqual(kinds(chunks), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(textOfChunks(chunks), 'OK1')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(chunks.at(-2).usage, {
    inputTokens: 100,
    outputTokens: 2,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    totalTokens: 142,
  })
  assert.equal(spawns[0].args.includes('--resume'), false)
  assert.equal(spawns[0].args.at(-1), "cd '/home/ubuntu' && '/home/ubuntu/.local/bin/hermes' -p 'default' chat --query-file - -Q --format stream-json")
  assert.equal(spawns[0].options.stdio[0], 'pipe')
})

test('remote tool activity uses marked Markdown blocks without local tool calls', async () => {
  const { adapter } = makeAdapter({}, {
    lines: [
      frame({ type: 'tool_use', name: 'terminal', tool_call_id: 'c1', input: { command: 'echo HERMES_TOOL_OK' } }),
      frame({ type: 'tool_result', name: 'terminal', tool_call_id: 'c1', output: '{"output":"HERMES_TOOL_OK"}', is_error: false }),
      frame({ type: 'text', text: 'done' }),
      frame({ type: 'result', session_id: 's1', exit_code: 0, text: 'done', tokens: { input: 10, output: 1 } }),
    ],
  })

  const chunks = await drain(adapter.stream('hermes-remote', {
    sessionId: 's1',
    model: 'hermes',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'run it' }] }],
  }))

  const textBlocks = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(textBlocks.length, 3)
  assert.match(textBlocks[0].block.text, /远端工具\u2060 · 执行 · 运行命令/)
  assert.match(textBlocks[0].block.text, /```bash\necho HERMES_TOOL_OK/)
  assert.match(textBlocks[1].block.text, /远端工具\u2060 · 完成 · 运行命令/)
  assert.equal(textBlocks[2].block.text, 'done')
  assert.equal(chunks.some((c) => c.blockType === 'tool-call'), false)
  assert.equal(chunks.some((c) => c.type === 'reasoning-delta'), false)
})

test('tool activity can be turned off', async () => {
  const { adapter } = makeAdapter({ toolActivity: false }, {
    lines: [frame({ type: 'tool_use', name: 'terminal', input: {} }), frame({ type: 'text', text: 'x' })],
  })
  const chunks = await drain(adapter.stream('hermes-remote', {
    sessionId: 's1',
    model: 'hermes',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  }))
  assert.equal(chunks.some((c) => c.type === 'reasoning-delta'), false)
  assert.equal(textOfChunks(chunks), 'x')
})

test('assistant Markdown is preserved byte for byte around display-only tool blocks', async () => {
  const prose = '## 服务状态\n\n| 服务 | 状态 |\n|---|---|\n| API | 正常 |\n\n```bash\nssh -N -L 5173:127.0.0.1:5173 host\n```\n'
  const { adapter } = makeAdapter({}, { lines: [frame({ type: 'text', text: '检查中。\n' }), frame({ type: 'tool_use', name: 'terminal', input: { command: 'echo ok' } }), frame({ type: 'tool_result', name: 'terminal', output: 'a\n  b\nc' }), frame({ type: 'text', text: prose.slice(0, 20) }), frame({ type: 'text', text: prose.slice(20) }), frame({ type: 'result', exit_code: 0, text: prose, tokens: {} })] })
  const chunks = await drain(adapter.stream('hermes-remote', { sessionId: 'markdown', model: 'hermes', messages: [{ role: 'user', content: 'test' }] }))
  const blocks = chunks.filter((c) => c.type === 'block-end').map((c) => c.block)
  assert.equal(blocks[0].text, '检查中。\n')
  assert.equal(blocks.at(-1).text, prose)
  assert.equal(blocks.length, 4)
  assert.ok(blocks[2].text.includes('a\n  b\nc'))
})

test('tool-only streaming still emits a final result text fallback exactly once', async () => {
  const { adapter } = makeAdapter({}, { lines: [frame({ type: 'tool_use', name: 'terminal', input: { command: 'echo ok' } }), frame({ type: 'result', exit_code: 0, text: '最终回答', tokens: {} })] })
  const chunks = await drain(adapter.stream('hermes-remote', { sessionId: 'fallback', model: 'hermes', messages: [{ role: 'user', content: 'go' }] }))
  assert.equal(textOfChunks(chunks).split('最终回答').length - 1, 1)
  assert.equal(chunks.filter((c) => c.type === 'block-end').at(-1).block.text, '最终回答')
})

test('a tool row leads with a summary, reports its duration and caps a long body', async () => {
  const { adapter } = makeAdapter({}, {
    lines: [
      frame({ type: 'tool_use', name: 'terminal', input: { command: 'npm test', cwd: '/srv' } }),
      frame({
        type: 'tool_result',
        name: 'terminal',
        output: Array.from({ length: 20 }, (_, at) => `line ${at}`).join('\n'),
        is_error: false,
        duration_ms: 2340,
      }),
      frame({ type: 'result', session_id: 's1', exit_code: 0, text: '', tokens: { input: 1, output: 1 } }),
    ],
  })
  const chunks = await drain(adapter.stream('hermes-remote', {
    sessionId: 's1',
    model: 'hermes',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'run it' }] }],
  }))
  const activity = chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.text)
    .join('')

  assert.match(activity, /执行 · 运行命令 · npm test/)
  assert.match(activity, /"cwd": "\/srv"/)
  assert.match(activity, /完成 · 运行命令 · 2\.3 秒/)
  assert.match(activity, /另有 2 行未显示/)
  assert.equal(chunks.some((c) => c.blockType === 'tool-call'), false)
})

test('a tool result envelope is unwrapped and a non-zero exit marks the row failed', async () => {
  const { adapter } = makeAdapter({}, {
    lines: [
      frame({ type: 'tool_use', name: 'terminal', input: { command: 'false' } }),
      frame({ type: 'tool_result', name: 'terminal', output: JSON.stringify({ output: '', exit_code: 3, error: 'boom' }) }),
      frame({ type: 'result', session_id: 's1', exit_code: 1, text: 'failed', error: 'boom', tokens: { input: 1, output: 1 } }),
    ],
  })
  const chunks = await drain(adapter.stream('hermes-remote', {
    sessionId: 's1',
    model: 'hermes',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  }))
  const activity = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.match(activity, /失败 · 运行命令/)
  assert.match(activity, /boom/)
  assert.doesNotMatch(activity, /exit_code/)

  // The result frame's own `error` field is what the failure explains, not its prose.
  const finish = chunks.find((c) => c.type === 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /boom/)
})

test('an unknown frame type warns once instead of vanishing silently', async () => {
  const logs = []
  const { adapter } = makeAdapter({ debug: true }, {
    lines: [
      frame({ type: 'tool_stream', name: 'x' }),
      frame({ type: 'tool_stream', name: 'y' }),
      frame({ type: 'system', subtype: 'init', model: 'glm-5.3' }),
      frame({ type: 'result', session_id: 's1', exit_code: 0, text: 'ok', tokens: { input: 1, output: 1 } }),
    ],
  })
  const original = adapter.log.bind(adapter)
  adapter.log = (message) => {
    logs.push(message)
    original(message)
  }
  await drain(adapter.stream('hermes-remote', {
    sessionId: 's1',
    model: 'hermes',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  }))

  const warnings = logs.filter((line) => line.includes('unhandled hermes frame'))
  assert.deepEqual(warnings, ['unhandled hermes frame "tool_stream"; stream-json schema may have changed'])
  assert.ok(logs.some((line) => line.includes('remote model: glm-5.3')))
  assert.equal(logs.some((line) => line.includes('unhandled hermes frame "system"')), false)
})

test('a second turn resumes the remote session and sends only the new text', async () => {
  const { adapter, spawns } = makeAdapter({
    persistSessions: true,
    stateDir: mkdtempSync(join(tmpdir(), 'oh-my-hermes-resume-')),
  })
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Remember PLUM' }] }]

  // Rebuild the fake child per spawn so both turns can run.
  const children = []
  adapter.spawner = (command, args) => {
    spawns.push({ command, args })
    const child = new FakeChild({
      lines: children.length === 0
        ? [frame({ type: 'text', text: 'R1' }), frame({ type: 'result', session_id: 'local-1', exit_code: 0, text: 'R1', tokens: { input: 5, output: 1 } })]
        : [frame({ type: 'text', text: 'PLUM' }), frame({ type: 'result', session_id: 'local-1', exit_code: 0, text: 'PLUM', tokens: { input: 6, output: 1 } })],
    })
    children.push(child)
    return child
  }

  await drain(adapter.stream('hermes-remote', { sessionId: 's1', model: 'hermes', messages }))
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'R1' }] })
  messages.push({ role: 'user', content: [{ type: 'text', text: 'Which word?' }] })
  const second = await drain(adapter.stream('hermes-remote', { sessionId: 's1', model: 'hermes', messages }))

  assert.equal(textOfChunks(second), 'PLUM')
  assert.match(spawns[1].args.at(-1), /--resume 'local-1'/)
  assert.equal(children[1].stdinText, 'Which word?')
})

test('session ids survive a restart through the state file', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'oh-my-hermes-'))
  const first = makeAdapter({ stateDir, persistSessions: true }, {
    lines: [
      frame({ type: 'text', text: 'hi' }),
      frame({ type: 'result', session_id: 'local-abc', exit_code: 0, text: 'hi', tokens: { input: 5, output: 1 } }),
    ],
  })
  await drain(first.adapter.stream('hermes-remote', {
    sessionId: 's1',
    model: 'hermes',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }))
  first.adapter.dispose()

  const file = join(stateDir, 'hermes-remote.json')
  assert.ok(existsSync(file))
  const saved = { session: 'local-abc', model: '', scope: first.adapter.scopeOf(first.adapter.hosts[0]), profile: 'default' }
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'hermes-remote:s1': saved })

  const second = makeAdapter({ stateDir, persistSessions: true })
  assert.deepEqual(second.adapter.storeFor('hermes-remote').get('hermes-remote:s1'), saved)
})

test('switching the model drops --resume, sends the transcript and pins -m', async () => {
  const { adapter, spawns } = makeAdapter({
    persistSessions: true,
    stateDir: mkdtempSync(join(tmpdir(), 'oh-my-hermes-switch-')),
    hosts: [{
      id: 'hermes-remote',
      name: 'Test box',
      sshHost: 'example.test',
      sshUser: 'ubuntu',
      command: '/opt/hermes',
      models: [
        { id: 'hermes', name: 'remote default' },
        { id: 'glm-5.3', name: 'glm', hermesModel: 'glm-5.3' },
      ],
    }],
  })

  const children = []
  adapter.spawner = (command, args) => {
    spawns.push({ command, args })
    const child = new FakeChild({
      lines: [
        frame({ type: 'text', text: 'ok' }),
        frame({ type: 'result', session_id: `local-${children.length + 1}`, exit_code: 0, text: 'ok', tokens: { input: 5, output: 1 } }),
      ],
    })
    children.push(child)
    return child
  }

  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Remember PLUM' }] }]
  await drain(adapter.stream('hermes-remote', { sessionId: 's1', model: 'hermes', messages }))
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
  messages.push({ role: 'user', content: [{ type: 'text', text: 'Which word?' }] })

  // Same model: resume, and no -m on the resumed call.
  await drain(adapter.stream('hermes-remote', { sessionId: 's1', model: 'hermes', messages }))
  assert.match(spawns[1].args.at(-1), /--resume 'local-1'/)
  assert.doesNotMatch(spawns[1].args.at(-1), /-m /)
  assert.equal(children[1].stdinText, 'Which word?')

  // Different model: a fresh session pinned to that model, carrying the transcript.
  await drain(adapter.stream('hermes-remote', { sessionId: 's1', model: 'glm-5.3', messages }))
  const third = spawns[2].args.at(-1)
  assert.doesNotMatch(third, /--resume/)
  assert.match(third, /-m 'glm-5\.3'/)
  assert.match(children[2].stdinText, /\[user\]\nRemember PLUM/)
  assert.deepEqual(adapter.storeFor('hermes-remote').get('hermes-remote:s1'), { session: 'local-3', model: 'glm-5.3', scope: adapter.scopeOf(adapter.hosts[0]), profile: 'default' })
})

// ── failures ─────────────────────────────────────────────────────────────────

test('a non-zero remote exit becomes an error finish', async () => {
  const { adapter } = makeAdapter({}, {
    lines: [frame({ type: 'result', session_id: 'x', exit_code: 2, text: 'boom', tokens: { input: 3, output: 0 } })],
    code: 1,
  })
  const chunks = await drain(adapter.stream('hermes-remote', {
    sessionId: 's1',
    model: 'hermes',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  }))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'PROVIDER_ERROR')
  assert.match(chunks.at(-1).reason.failure.message, /boom/)
})

test('ssh failures are explained', async () => {
  const { adapter } = makeAdapter({}, { lines: [], stderr: 'ubuntu@example.test: Permission denied (publickey).\n', code: 255 })
  const chunks = await drain(adapter.stream('hermes-remote', {
    sessionId: 's1',
    model: 'hermes',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  }))
  assert.equal(chunks.at(-1).reason.failure.code, 'SSH_AUTH')
  assert.match(chunks.at(-1).reason.failure.message, /SSH 拒绝了/)
})

test('explain covers the usual remote failures', () => {
  assert.equal(explain('hermes: command not found').code, 'HERMES_NOT_FOUND')
  assert.equal(explain('ssh: Could not resolve hostname foo').code, 'SSH_DNS')
  assert.equal(explain('401 unauthorized').code, 'HERMES_AUTH')
  assert.equal(explain('nothing to see'), undefined)
})

test('aborting the stream finishes with aborted', async () => {
  const { adapter } = makeAdapter({}, { hang: true })
  const controller = new AbortController()
  const iterator = adapter.stream('hermes-remote', {
    sessionId: 's1',
    model: 'hermes',
    signal: controller.signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  })
  const pending = drain(iterator)
  setTimeout(() => controller.abort(), 20)
  const chunks = await pending
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
})

test('an idle remote turn times out', async () => {
  const { adapter } = makeAdapter({ idleTimeoutMs: 40 }, { hang: true })
  const chunks = await drain(adapter.stream('hermes-remote', {
    sessionId: 's1',
    model: 'hermes',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  }))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'TIMEOUT')
})

// ── plugin entry ─────────────────────────────────────────────────────────────

test('apply registers every host and can be disposed', () => {
  const registered = []
  const configured = []
  let disposed = 0
  const ctx = {
    llm: {
      registerAdapter: (providers, adapter) => {
        registered.push({ providers, adapter })
        return () => {
          disposed += 1
        }
      },
      registerConfigurableProviders: (entries) => {
        configured.push(...entries)
        return () => {}
      },
    },
    on: () => {},
  }
  apply(ctx, {
    stateDir: mkdtempSync(join(tmpdir(), 'oh-my-hermes-apply-')),
    hosts: [
      { id: 'box-a', sshHost: 'a.test', name: 'A' },
      { id: 'box-b', sshHost: 'b.test', name: 'B' },
    ],
  })
  assert.deepEqual(registered[0].providers, ['box-a', 'box-b'])
  assert.deepEqual(configured.map((e) => e.provider), ['box-a', 'box-b'])
  assert.equal(configured[0].displayName, 'A')
})
