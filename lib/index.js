/**
 * dsh-oh-my-hermes — turn a remote Hermes Agent into a dsh (DeepSeek Harness)
 * model provider.
 *
 * One model call becomes one SSH invocation:
 *
 *   ssh <user>@<host> "cd '<cwd>' && '<hermes>' chat --query-file - -Q \
 *        --format stream-json [--resume <id>] [-m <model>] [--reasoning <e>]"
 *
 * The prompt travels on stdin (`--query-file -`), so user text never reaches a
 * shell. Hermes' stream-json frames are translated into dsh StreamChunks:
 * text deltas, tool activity as display-only reasoning blocks, usage, finish.
 * The remote session id is remembered per dsh session and reused with
 * `--resume`, so the remote agent keeps its own conversation state.
 *
 * Design rules:
 *  - No third-party or `@deepseek-ai/*` imports: the adapter is a plain object
 *    duck-typed to the seven methods `@deepseek-ai/dsh-llm` calls, so the
 *    plugin loads on any host layout and needs no dependency install.
 *  - Remote tools are shown, never executed locally: they arrive as reasoning
 *    blocks, so dsh never sees a `tool-call` it would try to run itself.
 *  - Every spawn is bounded by a total and an idle timeout and is killed on
 *    abort; the child is always reaped.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildRedactor } from './redact.js'
import { registerHermesCommands } from './commands.js'
import { skillsCommand, parseSkills } from './skills.js'
import { formatToolCall, formatToolResult } from './tool-display.js'
import { profileName, listProfilesCommand, parseProfiles, validateProfileCreate, createProfileCommand, modelCacheCommand, modelCacheFallbackCommand } from './profiles.js'

export const name = 'dsh-oh-my-hermes'
export const inject = ['llm']

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const aborted = () => ({ type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } })

// A route id is also a state filename. Keep it a single portable path component.
const routeId = (value) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error('host id must contain 1–80 letters, digits, underscores or hyphens')
  return value
}

const sshTarget = (host) => {
  const address = String(host.sshHost ?? '').trim()
  const user = String(host.sshUser ?? '').trim()
  if (!address || address.startsWith('-') || /[\s\x00-\x1f]/.test(address)) throw new Error('sshHost must be a host or SSH alias, without spaces or options')
  if (user && (!/^[a-zA-Z0-9_.-]+$/.test(user) || user.startsWith('-') || address.includes('@'))) throw new Error('sshUser is invalid or already included in sshHost')
  return user ? `${user}@${address}` : address
}

const DEFAULTS = {
  hosts: [],
  models: [],
  providerId: 'hermes-remote',
  providerName: '',
  command: 'hermes',
  remoteCwd: '',
  sshArgs: [],
  extraArgs: [],
  maxTurns: 0,
  turnTimeoutMs: 30 * 60 * 1000,
  idleTimeoutMs: 10 * 60 * 1000,
  stateDir: '',
  persistSessions: true,
  debug: false,
  env: {},
  toolActivity: true,
  maxToolText: 2000,
}

const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const REASONING_ALIASES = {
  minimal: 'low',
  min: 'low',
  low: 'low',
  medium: 'medium',
  mid: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

// ── text helpers ─────────────────────────────────────────────────────────────

/** Flatten the text of a dsh message, ignoring non-text blocks. */
export const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
    else if (block.type === 'image') out += '[image]'
    else if (block.type === 'file') out += '[file]'
  }
  return out
}

const isTurn = (m) => m && (m.role === 'user' || m.role === 'assistant')

/**
 * Fresh call: the whole transcript. Resumed call: only what came after the last
 * assistant turn, because the remote agent still holds everything before it.
 */
export function selectTurns(messages, resuming) {
  const turns = (messages ?? []).filter(isTurn)
  if (!resuming) return turns
  let last = -1
  for (let i = 0; i < turns.length; i++) if (turns[i].role === 'assistant') last = i
  const tail = turns.slice(last + 1)
  return tail.length > 0 ? tail : turns.slice(-1)
}

/** The turn as one prompt; role-labelled when the transcript has assistant turns. */
export function buildPrompt(messages, resuming) {
  const parts = selectTurns(messages, resuming)
    .map((m) => ({ role: m.role, text: textOf(m.content) }))
    .filter((p) => p.text !== '')
  if (parts.length === 0) throw new Error('dsh-oh-my-hermes: the turn has no text to send')
  const labelled = parts.some((p) => p.role === 'assistant')
  return parts.map((p) => (labelled ? `[${p.role}]\n${p.text}` : p.text)).join('\n\n')
}

// ── config normalisation ─────────────────────────────────────────────────────

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

const resolveSsh = (configured) => {
  if (configured) return configured
  const root = process.env.SystemRoot || process.env.windir
  if (root) {
    const exe = join(root, 'System32', 'OpenSSH', 'ssh.exe')
    if (existsSync(exe)) return exe
  }
  return 'ssh'
}

const positiveInt = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** One provider route per host; a bare `sshHost` is accepted as a single host. */
export function normalizeHosts(config) {
  const raw = Array.isArray(config.hosts) && config.hosts.length > 0
    ? config.hosts
    : config.sshHost
      ? [{ ...config, id: config.providerId, name: config.providerName }]
      : []
  const seen = new Set()
  const baseId = config.providerId ? String(config.providerId) : DEFAULTS.providerId
  return raw.map((host, index) => {
    if (!host || typeof host !== 'object') throw new Error(`dsh-oh-my-hermes: hosts[${index}] must be an object`)
    if (!host.sshHost) throw new Error(`dsh-oh-my-hermes: hosts[${index}].sshHost is required`)
    const id = routeId(String(host.id || (index === 0 ? baseId : `${baseId}-${index + 1}`)))
    if (seen.has(id)) throw new Error(`dsh-oh-my-hermes: duplicate host id "${id}"`)
    seen.add(id)
    return {
      id,
      name: String(host.name || host.sshHost),
      sshHost: String(host.sshHost),
      sshUser: host.sshUser ? String(host.sshUser) : '',
      target: sshTarget(host),
      command: String(host.command || config.command || DEFAULTS.command),
      remoteCwd: String(host.remoteCwd ?? config.remoteCwd ?? ''),
      models: normalizeModels(host.models && host.models.length > 0 ? host.models : config.models),
    }
  })
}

export function normalizeModels(models) {
  const rows = (Array.isArray(models) ? models : [])
    .map((m) => {
      const id = typeof m === 'string' ? m : m && m.id
      if (!id) return undefined
      const row = typeof m === 'string' ? { id } : m
      return {
        id: String(id),
        name: String(row.name || row.id),
        description: typeof row.description === 'string' ? row.description : undefined,
        contextWindow: positiveInt(row.contextWindow, 200000),
        maxTokens: positiveInt(row.maxTokens, 32000),
        hermesModel: typeof row.hermesModel === 'string' && row.hermesModel ? row.hermesModel : '',
        ...(row.hermesProfile ? { hermesProfile: profileName(row.hermesProfile) } : {}),
      }
    })
    .filter(Boolean)
  return rows.length > 0
    ? rows
    : [{ id: 'hermes', name: 'Remote default', contextWindow: 200000, maxTokens: 32000, hermesModel: '' }]
}

// ── config file (what the settings page edits) ──────────────────────────────

export const configFileOf = (stateDir) => join(stateDir, 'config.json')

/** The JSON the settings page wrote, or undefined when there is none yet. */
export function readConfigFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** A file written by the settings page wins over the bundle patch for hosts/models. */
export function mergeConfig(base, file) {
  if (!file) return base
  const merged = { ...base, ...file }
  if (!Array.isArray(file.hosts) || file.hosts.length === 0) merged.hosts = base.hosts
  if (!Array.isArray(file.models) || file.models.length === 0) merged.models = base.models
  return merged
}

/** Turn a settings-page draft into a config this plugin can boot, or throw with a readable message. */
export function validateDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('config must be an object')
  }
  const hosts = Array.isArray(draft.hosts) ? draft.hosts : []
  if (hosts.length === 0) throw new Error('at least one host is required')
  const shared = Array.isArray(draft.models) ? draft.models : []
  const out = hosts.map((host, index) => {
    if (!host || typeof host !== 'object') throw new Error(`hosts[${index}] must be an object`)
    const declared = Array.isArray(host.models) && host.models.length > 0 ? host.models : shared
    const label = String(host.id || host.sshHost || `hosts[${index}]`)
    const seen = new Set()
    // A brand-new host with no rows yet still needs a usable default row.
    const rows = declared.length > 0
      ? declared
      : [{ id: 'hermes', name: '远端默认模型', hermesModel: '', contextWindow: 200000, maxTokens: 32000 }]
    const models = rows.map((model, at) => {
      const row = model && typeof model === 'object' ? model : {}
      const id = String(row.id || '').trim()
      if (!id) throw new Error(`host "${label}": model row ${at + 1} needs an id`)
      if (seen.has(id)) throw new Error(`host "${label}": duplicate model id "${id}"`)
      seen.add(id)
      return {
        id,
        name: String(row.name || id).trim(),
        hermesModel: String(row.hermesModel || '').trim(),
        ...(row.hermesProfile ? { hermesProfile: profileName(row.hermesProfile) } : {}),
        contextWindow: positiveInt(row.contextWindow, 200000),
        maxTokens: positiveInt(row.maxTokens, 32000),
      }
    })
    return {
      id: String(host.id || '').trim(),
      name: String(host.name || '').trim(),
      sshHost: String(host.sshHost || '').trim(),
      sshUser: String(host.sshUser || '').trim(),
      command: String(host.command || '').trim(),
      remoteCwd: String(host.remoteCwd || '').trim(),
      models,
    }
  })
  // normalizeHosts enforces ids, sshHost and uniqueness; run it to surface those errors here.
  const normalized = normalizeHosts({ ...draft, hosts: out })
  out.forEach((host, index) => { host.id = normalized[index].id })
  return { hosts: out }
}

/** The models a remote box advertises: hermes caches its provider /v1/models list on disk. */
export function parseRemoteModels(text) {
  const parsed = JSON.parse(text)
  const ids = new Set()
  let provider = ''
  for (const [key, value] of Object.entries(parsed ?? {})) {
    if (!provider) provider = String(key).split('#')[0]
    for (const model of value?.models ?? []) {
      if (typeof model === 'string' && model) ids.add(model)
    }
  }
  return { provider, models: [...ids].sort() }
}

/** The row the settings page creates for a model the remote box advertises. */
export function modelRowFor(id) {
  return { id, name: id, hermesModel: id, contextWindow: 200000, maxTokens: 32000 }
}

/** Preserve route ids while making the remote identity visible in DSH's model picker. */
export function modelDisplayName(row) {
  const profile = row.hermesProfile || 'default'
  if (profile === 'default') return row.name
  const named = row.name === profile || row.name.startsWith(`${profile} · `) || row.name.startsWith(`${profile} / `)
  return named ? row.name : `${profile} · ${row.name}`
}

export function writeConfigFile(file, config) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

// ── session persistence ──────────────────────────────────────────────────────

/** dsh session id → remote Hermes session id, persisted across restarts. */
export class SessionStore {
  constructor(file, { read = readFileSync, write = writeFileSync } = {}) {
    this.file = file
    this.read = read
    this.write = write
    this.map = new Map()
    this.timer = undefined
    this.load()
  }

  load() {
    if (!this.file) return
    try {
      const parsed = JSON.parse(this.read(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          // Older files stored the bare remote id; treat its model as the remote default.
          if (typeof value === 'string' && value) this.map.set(key, { session: value, model: '' })
          else if (value && typeof value === 'object' && typeof value.session === 'string' && value.session) {
            this.map.set(key, { session: value.session, model: typeof value.model === 'string' ? value.model : '',
              ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
              ...(typeof value.profile === 'string' && value.profile ? { profile: value.profile } : {}) })
          }
        }
      }
    } catch {}
  }

  get(key) {
    return this.map.get(key)
  }

  set(key, value) {
    const current = this.map.get(key)
    if (current && value && current.session === value.session && current.model === value.model && current.scope === value.scope && current.profile === value.profile) return
    this.map.set(key, value)
    this.scheduleFlush()
  }

  delete(key) {
    if (!this.map.delete(key)) return
    this.scheduleFlush()
  }

  scheduleFlush() {
    if (!this.file) return
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, 250)
    this.timer.unref?.()
  }

  flush() {
    if (!this.file) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      this.write(tmp, `${JSON.stringify(Object.fromEntries(this.map), null, 2)}\n`, 'utf8')
      renameSync(tmp, this.file)
    } catch {}
  }
}

// ── SSH failures worth explaining ────────────────────────────────────────────

const FAILURE_HINTS = [
  [/Permission denied \(publickey/i, 'SSH 拒绝了这个密钥：确认主机/用户，或把公钥加到远端 authorized_keys', 'SSH_AUTH'],
  [/Host key verification failed/i, '远端主机指纹变了：先手动 ssh 一次并确认指纹', 'SSH_HOST_KEY'],
  [/Could not resolve hostname/i, '域名解析失败：检查 sshHost 拼写或本机 DNS', 'SSH_DNS'],
  [/Connection timed out|connect to host .* port 22/i, '连不上远端 22 端口：检查网络、安全组或跳板机', 'SSH_UNREACHABLE'],
  [/Connection refused/i, '远端拒绝连接：ssh 服务没开或端口不对', 'SSH_REFUSED'],
  [/command not found|No such file or directory/i, '远端找不到 hermes：把 command 设成绝对路径（如 /home/ubuntu/.local/bin/hermes）', 'HERMES_NOT_FOUND'],
  [/not support for model|unknown model|model .* not found|invalid model/i, '远端不接受这个模型：在设置页「读取远端模型」里挑一个当前可用的，或让远端刷新模型缓存', 'HERMES_MODEL'],
  [/No API key|api key|unauthorized|401/i, '远端 Hermes 的模型凭据不可用：在远端跑一次 hermes 检查登录/API key', 'HERMES_AUTH'],
  [/rate limit|quota|429/i, '远端模型额度或频率受限：换远端模型或稍后再试', 'HERMES_QUOTA'],
]

// Frames that carry no renderable content, so an unknown-type warning stays meaningful
// (the same allow-list discipline oh-my-claude uses for Claude Code's stream-json frames).
const INERT_FRAMES = new Set(['system', 'usage', 'keep_alive', 'heartbeat', 'ping', 'ready'])


export function explain(stderr) {
  const text = (stderr || '').trim()
  for (const [pattern, message, code] of FAILURE_HINTS) {
    if (pattern.test(text)) {
      const tail = text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-1)[0] ?? ''
      return { message: `${message}（${tail.slice(0, 200)}）`, code }
    }
  }
  return undefined
}

// ── the adapter ──────────────────────────────────────────────────────────────

export class HermesAdapter {
  constructor(ctx, config) {
    this.ctx = ctx
    const raw = { ...DEFAULTS, ...(config ?? {}) }
    this.stateDir = raw.stateDir ? String(raw.stateDir) : join(homedir(), '.dsh', 'oh-my-hermes')
    this.configFile = configFileOf(this.stateDir)
    this.config = mergeConfig(raw, readConfigFile(this.configFile))
    this.hosts = normalizeHosts(this.config)
    if (this.hosts.length === 0) throw new Error('dsh-oh-my-hermes: configure hosts[] or sshHost')
    this.byId = new Map(this.hosts.map((host) => [host.id, host]))
    this.ssh = resolveSsh(this.config.sshCommand)
    this.spawner = typeof this.config.spawnProcess === 'function' ? this.config.spawnProcess : spawn
    this.stores = new Map()
    this.locks = new Map()
    this.homeLocks = new Map()
    this.children = new Set()
    this.profileJobs = new Set()
    this.redact = buildRedactor({ ...process.env, ...this.config.env })
    /** Frame types already warned about, so a Hermes schema change warns once, not per turn. */
    this.unknownFrames = new Set()
    /** Set by `apply` once the llm registration exists: republishes the catalog event. */
    this.announce = undefined
  }

  keyOf(provider, sessionId) {
    return `${provider}:${sessionId}`
  }

  storeFor(provider) {
    let store = this.stores.get(provider)
    if (!store) {
      routeId(provider)
      store = new SessionStore(this.config.persistSessions ? join(this.stateDir, `${provider}.json`) : '')
      this.stores.set(provider, store)
    }
    return store
  }

  scopeOf(host) {
    const values = [host.target, host.command, host.remoteCwd, this.ssh, this.config.sshArgs, this.config.extraArgs]
    values.push(profileName(host.hermesProfile || 'default'))
    return createHash('sha256').update(JSON.stringify(values)).digest('hex')
  }

  sessionsView() {
    return this.hosts.flatMap((host) => [...this.storeFor(host.id).map].map(([key, record]) => ({
      provider: host.id, host: host.name, sessionId: key.slice(host.id.length + 1),
      remoteSession: record.session, model: record.model || '远端默认模型',
      profile: record.profile || 'default',
      active: this.locks.has(key), compatible: record.scope === this.scopeOf({ ...host, hermesProfile: record.profile }),
    })))
  }

  resetSession(provider, sessionId) {
    if (!this.byId.has(provider) || typeof sessionId !== 'string' || !sessionId) throw new Error('unknown host or session')
    const key = this.keyOf(provider, sessionId)
    if (this.locks.has(key)) throw new Error('会话仍在运行或排队，请停止后重试')
    const store = this.storeFor(provider)
    store.delete(key)
    store.flush()
  }

  log(message) {
    message = this.redact(message)
    const logger = this.ctx?.logger?.('oh-my-hermes')
    if (logger?.info) logger.info(message)
    else if (this.config.debug) console.error(`[dsh-oh-my-hermes] ${message}`)
  }

  // ── catalogue ─────────────────────────────────────────────────────────────

  providerInfo(provider) {
    return { id: provider, name: this.byId.get(provider)?.name ?? provider, version: VERSION }
  }

  providerRetryPolicy() {
    return undefined
  }

  imageRequestPricing() {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  async listModels(provider) {
    const host = this.byId.get(provider)
    if (!host) throw new Error(`dsh-oh-my-hermes: unknown provider "${provider}"`)
    return host.models.map((m) => ({
      provider,
      id: m.id,
      name: modelDisplayName(m),
      ...(m.description === undefined ? {} : { description: m.description }),
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider, model) {
    const host = this.byId.get(provider)
    if (!host) throw new Error(`dsh-oh-my-hermes: unknown provider "${provider}"`)
    const row = host.models.find((m) => m.id === model)
    if (!row) throw new Error(`模型行「${model}」已不在配置中，请重新选择 Hermes 模型或身份`)
    return {
      provider,
      id: model,
      name: modelDisplayName(row),
      ...(row.description === undefined ? {} : { description: row.description }),
      inputModalities: ['text'],
      context: { contextWindow: row.contextWindow },
      defaultMaxTokens: row.maxTokens,
      reasoning: {
        efforts: REASONING_EFFORTS.map((effort) => ({ id: effort, name: effort })),
        defaultEffort: 'medium',
      },
    }
  }

  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model)
    return {
      model: resolved,
      stream: (options) => this.stream(provider, options),
    }
  }

  dispose() {
    this.disposed = true
    for (const child of this.children) {
      try {
        child.kill('SIGTERM')
      } catch {}
    }
    this.children.clear()
    for (const store of this.stores.values()) store.flush()
  }

  /**
   * Apply a saved draft in place. Provider ids are fixed at registration time, so a
   * draft that adds or removes a host cannot go live; anything else — new model rows,
   * renamed hosts, flipped endpoints — takes effect on the next model list read.
   */
  applyDraft(draft) {
    const next = normalizeHosts({ ...this.config, hosts: draft.hosts, models: draft.models ?? this.config.models })
    const before = this.hosts.map((host) => host.id).sort().join(',')
    const after = next.map((host) => host.id).sort().join(',')
    if (before !== after) return { live: false }
    const previous = new Map(this.hosts.map((host) => [host.id, host]))
    this.hosts = next
    this.byId = new Map(next.map((host) => [host.id, host]))
    this.config = { ...this.config, hosts: draft.hosts, models: draft.models ?? this.config.models }
    // dsh caches the model catalog per browser until `llm/adapters-updated` fires;
    // re-committing the same routes publishes that event (commitRoutes does it).
    try {
      this.announce?.()
    } catch (error) {
      this.log(`catalog announce failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return {
      live: true,
      changed: next
        .filter((host) => JSON.stringify(previous.get(host.id)?.models) !== JSON.stringify(host.models))
        .map((host) => host.id),
    }
  }

  // ── transport ─────────────────────────────────────────────────────────────

  buildRemoteCommand(host, options, hermesSessionId) {
    const row = host.models.find((m) => m.id === options.model)
    if (!row) throw new Error(`模型行「${options.model}」已不在配置中，请重新选择 Hermes 模型或身份`)
    const profile = profileName(row.hermesProfile || host.hermesProfile || 'default')
    const parts = [shq(host.command), ...(profile ? ['-p', shq(profile)] : []), 'chat', '--query-file', '-', '-Q', '--format', 'stream-json']
    if (hermesSessionId) parts.push('--resume', shq(hermesSessionId))
    // hermes rejects -m together with --resume (the session keeps its launch model),
    // so the model flag only rides on a fresh call.
    else if (row.hermesModel) parts.push('-m', shq(row.hermesModel))
    const effort = REASONING_ALIASES[String(options.reasoningEffort ?? '').toLowerCase()]
    if (effort) parts.push('--reasoning', shq(effort))
    if (this.config.maxTurns > 0) parts.push('--max-turns', String(this.config.maxTurns))
    for (const arg of this.config.extraArgs ?? []) parts.push(shq(arg))
    const call = parts.join(' ')
    return host.remoteCwd ? `cd ${shq(host.remoteCwd)} && ${call}` : call
  }

  buildSshArgs(host, remoteCommand) {
    return [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=30',
      ...(this.config.sshArgs ?? []),
      host.target,
      remoteCommand,
    ]
  }

  /** One remote session cannot answer two prompts at once: serialize per dsh session. */
  async acquire(key, signal, locks = this.locks) {
    const previous = locks.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => gate)
    locks.set(key, tail)
    const unlock = () => {
      release()
      if (locks.get(key) === tail) locks.delete(key)
    }
    let onAbort
    const cancelled = signal && new Promise((resolve) => {
      onAbort = () => resolve(false)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    const ready = await Promise.race([previous.then(() => true), ...(cancelled ? [cancelled] : [])])
    signal?.removeEventListener('abort', onAbort)
    if (!ready) {
      // Leave our gate in the chain until the preceding request finishes.
      previous.then(unlock)
      return undefined
    }
    return unlock
  }

  // ── streaming ─────────────────────────────────────────────────────────────

  async *stream(provider, options) {
    const signal = options.signal ?? options.abortSignal
    if (signal?.aborted || this.disposed) { yield aborted(); return }
    const resumable = Boolean(options.sessionId) && !options.purpose
    const key = resumable ? this.keyOf(provider, options.sessionId) : `oneshot:${Date.now()}:${Math.random()}`
    const release = resumable ? await this.acquire(key, signal) : () => {}
    if (!release) { yield aborted(); return }
    let releaseHome
    try {
      // Read state only after the previous turn commits its new remote session.
      if (signal?.aborted || this.disposed) { yield aborted(); return }
      const base = this.byId.get(provider)
      if (!base) throw new Error(`dsh-oh-my-hermes: unknown provider "${provider}"`)
      const row = base.models.find((model) => model.id === options.model)
      if (!row) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: `模型行「${options.model}」已不在配置中，请重新选择 Hermes 模型或身份`, code: 'MODEL_NOT_CONFIGURED' } } }
        return
      }
      const host = { ...base, hermesProfile: row.hermesProfile || 'default' }
      // Named identities share memory on the remote home. Keep only one writer per identity.
      if (host.hermesProfile) {
        releaseHome = await this.acquire(JSON.stringify([host.target, host.hermesProfile]), signal, this.homeLocks)
        if (!releaseHome || this.disposed || signal?.aborted) { yield aborted(); return }
      }
      const desiredModel = row.hermesModel
      const store = resumable ? this.storeFor(provider) : undefined
      const record = store?.get(key)
      // hermes refuses --resume together with a model that differs from the session's
      // launch model, so a switch starts a new remote session carrying the transcript.
      const sameModel = (record?.model ?? '') === desiredModel && record?.scope === this.scopeOf(host)
      const resumeFrom = record?.session && sameModel ? record.session : undefined
      const prompt = buildPrompt(options.messages, Boolean(resumeFrom))
      const remote = this.buildRemoteCommand(host, options, resumeFrom)
      const args = this.buildSshArgs(host, remote)
      this.log(`${host.target}: ${desiredModel || 'remote default'}${resumeFrom ? ` (resume ${resumeFrom})` : record?.session ? ' (model switch: new session)' : ''}`)

      yield* this.runTurn({ host, key, store, resumeFrom, prompt, args, options, desiredModel })
    } finally {
      releaseHome?.()
      release()
    }
  }

  async *runTurn({ host, key, store, resumeFrom, prompt, args, options, desiredModel }) {
    const signal = options.signal ?? options.abortSignal
    // Until completion is consumed, remote history may be ahead of DSH. Never
    // leave the preceding resume id on disk across a crash or early return().
    store?.delete(key)
    if (resumeFrom) store?.flush()
    let child
    try {
      child = this.spawner(this.ssh, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...(this.config.env ?? {}) },
      })
    } catch (spawnError) {
      const reason = this.finishReason({ spawnError, host })
      reason.failure.message = this.redact(reason.failure.message)
      yield { type: 'finish', reason }
      return
    }
    this.children.add(child)

    const queue = []
    let wake = null
    const push = (chunk) => {
      queue.push(chunk)
      if (wake) {
        const resolver = wake
        wake = null
        resolver()
      }
    }

    let stderr = ''
    let pending = ''
    let hermesSession = resumeFrom
    let index = 0
    let open
    let text = ''
    let result
    let exitCode
    let exited = false
    let spawnError
    let timedOut
    let killed = false
    let killedReason = ''
    let killTimer

    const closeBlock = () => {
      if (!open) return
      const block = open.type === 'text'
        ? { type: 'text', text: open.text }
        : { type: 'reasoning', text: open.text }
      push({ type: 'block-end', index: open.index, block })
      open = undefined
    }

    const openBlock = (type) => {
      if (open && open.type === type) return open
      closeBlock()
      open = { index: index++, type, text: '' }
      push({ type: 'block-start', index: open.index, blockType: type })
      return open
    }

    const appendText = (chunkText) => {
      if (!chunkText) return
      const block = openBlock('text')
      block.text += chunkText
      text += chunkText
      push({ type: 'text-delta', index: block.index, text: chunkText })
    }

    const appendActivity = (chunkText) => {
      if (!this.config.toolActivity || !chunkText) return
      const block = openBlock('reasoning')
      chunkText = this.redact(chunkText)
      const delta = block.text === '' ? chunkText : `\n${chunkText}`
      block.text += delta
      push({ type: 'reasoning-delta', index: block.index, text: delta })
    }

    const clip = (value, max) => {
      const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
      return flat.length > max ? `${flat.slice(0, max)}…` : flat
    }

    const appendTool = (markdown) => {
      if (!this.config.toolActivity) return
      closeBlock()
      const block = openBlock('text')
      block.text = markdown
      push({ type: 'text-delta', index: block.index, text: markdown })
      closeBlock()
      // Tool Markdown is display-only; do not count it as the assistant's final prose.
    }
    const displayOptions = { limit: this.config.maxToolText, redact: (value) => this.redact(value) }

    const handleLine = (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      if (trimmed.startsWith('Session: ')) {
        hermesSession = trimmed.slice('Session: '.length).trim()
        return
      }
      let frame
      try {
        frame = JSON.parse(trimmed)
      } catch {
        return // non-protocol chatter on stdout
      }
      if (!frame || typeof frame !== 'object') return
      switch (frame.type) {
        case 'system':
          // `system/init` reports the model the remote actually launched; the line is the
          // ground truth for a local model switch.
          if (frame.subtype === 'init' && typeof frame.model === 'string' && frame.model) {
            this.log(`remote model: ${frame.model}`)
          }
          return
        case 'text':
          if (typeof frame.text === 'string') appendText(frame.text)
          return
        case 'tool_use':
          appendTool(formatToolCall(frame, displayOptions))
          return
        case 'tool_result':
          appendTool(formatToolResult(frame, displayOptions))
          return
        case 'result':
          result = frame
          if (typeof frame.session_id === 'string' && frame.session_id) hermesSession = frame.session_id
          if (typeof frame.text === 'string' && frame.text && text === '') appendText(frame.text)
          return
        default: {
          const kind = typeof frame.type === 'string' ? frame.type : 'unknown'
          if (typeof frame.error === 'string' && frame.error) appendActivity(`⚠ ${clip(frame.error, 400)}`)
          // One warning per unknown type, so a Hermes protocol change shows up instead of
          // silently dropping output. Known-inert frames stay quiet.
          if (!INERT_FRAMES.has(kind) && !this.unknownFrames.has(kind)) {
            this.unknownFrames.add(kind)
            this.log(`unhandled hermes frame "${kind}"; stream-json schema may have changed`)
          }
          return
        }
      }
    }

    const kill = (reason) => {
      if (killed) return
      killed = true
      killedReason = reason
      // A child ignoring SIGTERM must not keep the generator/lock alive forever.
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        exited = true
        push(null)
      }, 1000)
      killTimer.unref?.()
      try {
        child.kill('SIGTERM')
      } catch {}
    }

    const idleMs = positiveInt(this.config.idleTimeoutMs, 0)
    const totalMs = positiveInt(this.config.turnTimeoutMs, 0)
    let idleTimer
    const bumpIdle = () => {
      if (idleMs <= 0) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = 'idle'
        kill('idle')
      }, idleMs)
      idleTimer.unref?.()
    }
    const totalTimer = totalMs > 0
      ? setTimeout(() => {
        timedOut = 'total'
        kill('total')
      }, totalMs)
      : undefined
    totalTimer?.unref?.()

    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => {
      bumpIdle()
      pending += chunk
      let at
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at)
        pending = pending.slice(at + 1)
        handleLine(line)
      }
    })
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on('data', (chunk) => {
      bumpIdle()
      stderr += chunk
      if (stderr.length > 65536) stderr = stderr.slice(-65536)
    })
    child.on('error', (error) => {
      spawnError = error
      exitCode = -1
      exited = true
      push(null)
    })
    child.on('close', (code) => {
      exitCode = code ?? -1
      exited = true
      if (pending.trim()) handleLine(pending)
      pending = ''
      push(null)
    })

    const onAbort = () => kill('abort')
    signal?.addEventListener?.('abort', onAbort)
    child.stdin?.on?.('error', () => {})
    child.stdin?.end?.(prompt, 'utf8')
    bumpIdle()

    try {
      while (true) {
        if (queue.length === 0) {
          if (exited) break
          await new Promise((resolve) => {
            wake = resolve
          })
          continue
        }
        const chunk = queue.shift()
        if (chunk === null || chunk === undefined) break
        yield chunk
      }
    } finally {
      signal?.removeEventListener?.('abort', onAbort)
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      if (exited) clearTimeout(killTimer)
      this.children.delete(child)
      if (!exited) {
        store?.delete(key)
        kill('consumer')
      }
    }

    closeBlock()
    while (queue.length > 0) {
      const chunk = queue.shift()
      if (chunk) yield chunk
    }

    const reason = signal?.aborted || killedReason === 'abort'
      ? aborted().reason
      : this.finishReason({ result, exitCode, stderr, spawnError, timedOut, host })
    if (reason.failure) reason.failure.message = this.redact(reason.failure.message)
    if (store && reason.kind === 'stop' && hermesSession) {
      store.set(key, { session: hermesSession, model: desiredModel ?? '', scope: this.scopeOf(host), ...(host.hermesProfile ? { profile: host.hermesProfile } : {}) })
    } else if (store) {
      // Failed/interrupted turns may have changed remote history. Replay dsh's transcript next time.
      store.delete(key)
    }

    const usage = this.usageOf(result)
    if (usage) yield { type: 'usage', usage }

    yield { type: 'finish', reason }
  }

  usageOf(result) {
    const tokens = result && typeof result === 'object' ? result.tokens : undefined
    if (!tokens || typeof tokens !== 'object') return undefined
    const input = Number(tokens.input) || 0
    const output = Number(tokens.output) || 0
    const cacheRead = Number(tokens.cache_read) || 0
    const cacheWrite = Number(tokens.cache_write) || 0
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined
    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalTokens: input + cacheRead + cacheWrite + output,
    }
  }

  finishReason({ result, exitCode, stderr, spawnError, timedOut, host }) {
    if (timedOut === 'total') {
      return { kind: 'error', failure: { message: 'took longer than turnTimeoutMs; remote turn abandoned', code: 'TIMEOUT' } }
    }
    if (timedOut === 'idle') {
      return { kind: 'error', failure: { message: 'no output for idleTimeoutMs; remote turn abandoned', code: 'TIMEOUT' } }
    }
    if (spawnError) {
      return {
        kind: 'error',
        failure: {
          message: `could not start ssh (${spawnError.message}); install the OpenSSH client or set sshCommand`,
          code: 'PROVIDER_ERROR',
        },
      }
    }
    if (result && Number.isInteger(result.exit_code) && result.exit_code !== 0) {
      const detail = (typeof result.error === 'string' && result.error) || result.text || ''
      const explained = explain(`${stderr}\n${detail}`)
      return {
        kind: 'error',
        failure: {
          message: explained?.message ?? `remote hermes exited ${result.exit_code}: ${String(detail).slice(0, 400) || 'no detail'}`,
          code: explained?.code ?? 'PROVIDER_ERROR',
        },
      }
    }
    if (exitCode !== 0) {
      const explained = explain(stderr)
      const detail = (stderr || '').trim().split('\n').slice(-3).join(' ') || `ssh exited ${exitCode}`
      return {
        kind: 'error',
        failure: {
          message: explained?.message ?? `remote hermes on ${host.target} failed: ${detail}`,
          code: explained?.code ?? 'PROVIDER_ERROR',
        },
      }
    }
    if (!result) return { kind: 'error', failure: { message: '远端输出中没有完成帧，响应可能被截断；请检查 Hermes 版本或重试', code: 'HERMES_PROTOCOL' } }
    if (result.error || result.is_error) return { kind: 'error', failure: { message: String(result.error || result.text || 'Hermes returned an error').slice(0, 400), code: 'PROVIDER_ERROR' } }
    return { kind: 'stop' }
  }
}

// ── settings page transport ─────────────────────────────────────────────────

export const ROUTE = '/dsh-oh-my-hermes'

const sendJson = (res, status, value) => {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  } catch {}
}

const readBody = (req, limit = 1 << 20) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > limit) {
      reject(new Error('request body too large'))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

/** The shape the settings page edits: every host with its own model rows. */
export function configView(adapter) {
  const saved = readConfigFile(adapter.configFile)
  let hosts = adapter.hosts
  try { if (saved?.hosts?.length) hosts = normalizeHosts({ ...adapter.config, ...saved }) } catch {}
  const active = adapter.hosts.map((host) => host.id).sort().join(',')
  return {
    version: VERSION,
    restartRequired: hosts.map((host) => host.id).sort().join(',') !== active,
    file: adapter.configFile,
    exists: existsSync(adapter.configFile),
    providerIds: adapter.hosts.map((host) => host.id),
    hosts: hosts.map((host) => ({
      id: host.id,
      name: host.name,
      sshHost: host.sshHost,
      sshUser: host.sshUser,
      command: host.command,
      remoteCwd: host.remoteCwd,
      models: host.models.map((model) => ({
        id: model.id,
        name: model.name,
        hermesModel: model.hermesModel,
        ...(model.hermesProfile ? { hermesProfile: model.hermesProfile } : {}),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      })),
    })),
  }
}

/** One short remote command over the same ssh settings the model calls use. */
export function runRemote(adapter, host, remoteCommand, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let child
    try {
      child = adapter.spawner(adapter.ssh, adapter.buildSshArgs({ ...host, target: sshTarget(host) }, remoteCommand), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...(adapter.config.env ?? {}) },
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: '', error: error instanceof Error ? error.message : String(error) })
      return
    }
    adapter.children.add(child)
    let out = ''
    let err = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      adapter.children.delete(child)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {}
      finish({ code: -1, stdout: out, stderr: err, error: `timed out after ${Math.round(timeoutMs / 1000)}s` })
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => {
      out += chunk
      if (out.length > 262144) out = out.slice(-262144)
    })
    child.stderr?.on('data', (chunk) => {
      err += chunk
      if (err.length > 8192) err = err.slice(-8192)
    })
    child.on('error', (error) => finish({ code: -1, stdout: out, stderr: err, error: error.message }))
    child.on('close', (code) => {
      const explained = explain(err)
      finish({
        code: code ?? -1,
        stdout: out,
        stderr: err,
        error: code === 0 ? undefined : explained?.message ?? (err.trim() || `ssh exited ${code}`),
      })
    })
  })
}

/** `ssh <target> '<hermes> --version'` proves the box, the key and the path without a model call. */
async function probeHost(adapter, host, timeoutMs = 20000) {
  const command = `${shq(host.command || 'hermes')} --version`
  const result = await runRemote(adapter, host, host.remoteCwd ? `cd ${shq(host.remoteCwd)} && ${command}` : command, timeoutMs)
  return {
    ok: result.code === 0,
    code: result.code,
    version: result.stdout.trim().split('\n').find((line) => /^Hermes(?: Agent)?\s/i.test(line)) ?? result.stdout.trim().split('\n')[0] ?? '',
    error: result.error ? adapter.redact(result.error) : undefined,
  }
}

/**
 * The browser half's only transport: a JSON prefix route under the dsh web server. Mounted
 * optionally, so a dsh that runs no web server still boots the provider.
 */
function registerRoutes(ctx, adapter) {
  try {
    ctx.inject?.(['webServer', 'connection'], (host) => {
      const webServer = host?.webServer
      if (!webServer?.register) return
      const reject = (req) => {
        try {
          return host.connection?.requestRejection?.(req)
        } catch {
          return 403
        }
      }
      const dispose = webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          const rejection = reject(req)
          if (rejection !== undefined) return sendJson(res, rejection, { error: 'forbidden' })
          const url = new URL(req.url ?? '/', 'http://dsh')
          try {
            if (url.pathname === `${ROUTE}/config`) {
              if (req.method === 'GET') return sendJson(res, 200, configView(adapter))
              if (req.method === 'PUT' || req.method === 'POST') {
                const draft = validateDraft(JSON.parse(await readBody(req)))
                writeConfigFile(adapter.configFile, draft)
                const applied = adapter.applyDraft(draft)
                return sendJson(res, 200, {
                  ok: true,
                  live: applied.live,
                  restartRequired: !applied.live,
                  saved: draft,
                })
              }
              return sendJson(res, 405, { error: 'method not allowed' })
            }
            if (url.pathname === `${ROUTE}/skills`) {
              if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
              const target = adapter.byId.get(url.searchParams.get('host') ?? '')
              if (!target) return sendJson(res, 400, { error: 'unknown host' })
              const row = target.models.find((m) => m.id === url.searchParams.get('model'))
              if (!row) return sendJson(res, 400, { error: '请选择当前主机的有效模型行' })
              const profile = row.hermesProfile || 'default'
              const result = await runRemote(adapter, target, skillsCommand(target, profile))
              if (result.error) return sendJson(res, 502, { error: adapter.redact(result.error) })
              try { return sendJson(res, 200, { host: target.id, model: row.id, profile, skills: parseSkills(result.stdout) }) }
              catch { return sendJson(res, 502, { error: '远端技能目录无效，请检查 Hermes 版本及技能配置' }) }
            }
            if (url.pathname === `${ROUTE}/models`) {
              if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
              const known = adapter.byId.get(url.searchParams.get('host') ?? '')
              const target = url.searchParams.has('sshHost') ? {
                sshHost: url.searchParams.get('sshHost') ?? '',
                sshUser: url.searchParams.get('sshUser') ?? '',
                command: url.searchParams.get('command') ?? '',
              } : known
              if (!target?.sshHost) return sendJson(res, 400, { error: 'unknown host' })
              const profile = profileName(url.searchParams.get('profile') || 'default')
              let result = await runRemote(adapter, target, modelCacheCommand(profile))
              let sourceProfile = profile
              if (result.error && profile !== 'default' && /No such file/i.test(result.stderr)) {
                const fallback = await runRemote(adapter, target, modelCacheFallbackCommand(profile))
                if (!fallback.error) { result = fallback; sourceProfile = 'default' }
              }
              if (result.error) return sendJson(res, 502, { error: /No such file/i.test(result.stderr) ? `该身份尚无模型缓存；请在远端运行 hermes ${url.searchParams.get('profile') ? `-p ${profileName(url.searchParams.get('profile'))} ` : ''}model 后重试` : adapter.redact(result.error) })
              try {
                return sendJson(res, 200, { ...parseRemoteModels(result.stdout), sourceProfile })
              } catch {
                return sendJson(res, 502, { error: 'remote model cache is not valid JSON' })
              }
            }
            if (url.pathname === `${ROUTE}/profiles`) {
              if (req.method === 'GET') {
                const known = adapter.byId.get(url.searchParams.get('host') ?? '')
                const target = url.searchParams.has('sshHost') ? { sshHost: url.searchParams.get('sshHost'), sshUser: url.searchParams.get('sshUser') ?? '' } : known
                if (!target?.sshHost) return sendJson(res, 400, { error: 'unknown host' })
                const result = await runRemote(adapter, target, listProfilesCommand())
                if (result.error) return sendJson(res, 502, { error: adapter.redact(result.error) })
                try { return sendJson(res, 200, { profiles: parseProfiles(result.stdout) }) }
                catch { return sendJson(res, 502, { error: '远端 profile 列表格式无效，请检查 Hermes home 目录和 Python3' }) }
              }
              if (req.method === 'POST') {
                const body = JSON.parse(await readBody(req))
                const clean = validateProfileCreate(body)
                const known = adapter.byId.get(body.host?.id)
                const target = body.host?.sshHost ? { ...body.host, command: body.host.command || known?.command || 'hermes' } : known
                if (!target?.sshHost) return sendJson(res, 400, { error: 'unknown host' })
                const job = `${sshTarget(target)}:${clean.name}`
                if (adapter.profileJobs.has(job)) return sendJson(res, 409, { error: '同名 profile 正在创建，请等待完成' })
                adapter.profileJobs.add(job)
                try {
                  const result = await runRemote(adapter, target, createProfileCommand(target, clean), 60000)
                  if (result.error) return sendJson(res, 502, { error: adapter.redact(result.error) })
                  return sendJson(res, 201, { ok: true, profile: { name: clean.name, description: clean.description, cloneFrom: clean.cloneFrom }, output: adapter.redact(result.stdout).slice(-2000) })
                } finally { adapter.profileJobs.delete(job) }
              }
              return sendJson(res, 405, { error: 'method not allowed' })
            }
            if (url.pathname === `${ROUTE}/sessions`) {
              if (req.method === 'GET') return sendJson(res, 200, {
                version: VERSION, activeProcesses: adapter.children.size,
                busySessions: adapter.locks.size, persistent: adapter.config.persistSessions,
                unknownFrames: [...adapter.unknownFrames], sessions: adapter.sessionsView(),
              })
              if (req.method === 'DELETE') {
                const draft = JSON.parse(await readBody(req))
                adapter.resetSession(draft.provider, draft.sessionId)
                return sendJson(res, 200, { ok: true })
              }
              return sendJson(res, 405, { error: 'method not allowed' })
            }
            if (url.pathname === `${ROUTE}/test` && req.method === 'POST') {
              const draft = JSON.parse(await readBody(req))
              if (!draft?.sshHost) return sendJson(res, 400, { error: 'sshHost is required' })
              const result = await probeHost(adapter, draft)
              return sendJson(res, 200, result)
            }
            return sendJson(res, 404, { error: 'not found' })
          } catch (error) {
            return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      })
      if (typeof host.effect === 'function') {
        host.effect(() => () => dispose?.())
        return undefined
      }
      return () => dispose?.()
    })
  } catch (error) {
    adapter.log(`settings routes not registered: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** dsh entry point for this bundle. */
export function apply(ctx, config) {
  const adapter = new HermesAdapter(ctx, config)
  const registration = ctx.llm.registerAdapter(
    adapter.hosts.map((host) => host.id),
    adapter,
  )
  // `replace` re-commits the same routes and publishes `llm/adapters-updated`, which
  // is what makes the browser rebuild its model catalog after a live config save.
  if (typeof registration?.replace === 'function') {
    adapter.announce = () => registration.replace(adapter.hosts.map((host) => host.id))
  }
  let directory
  try {
    directory = ctx.llm.registerConfigurableProviders(
      adapter.hosts.map((host) => ({
        provider: host.id,
        displayName: host.name,
        settingsNs: `llm-${host.id}`,
        settingsPath: [],
      })),
    )
  } catch (error) {
    adapter.log(`configurable provider not registered: ${error instanceof Error ? error.message : String(error)}`)
  }
  registerRoutes(ctx, adapter)
  registerHermesCommands(ctx, adapter)
  try {
    ctx.on?.('dispose', () => {
      adapter.dispose()
      directory?.()
      registration?.()
    })
  } catch {}
  return registration
}
