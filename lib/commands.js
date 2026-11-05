/** Native DSH commands. Skill discovery uses read-only SSH; none invokes a model. */
import { runRemote } from './index.js'
import { profileName } from './profiles.js'
import { skillsCommand, parseSkills } from './skills.js'
const HELP = [
  'Hermes 快捷指令',
  '/hermes — 显示帮助，也可用 /hermes status、models、profiles、skills、hosts、reset',
  '/hermes-status [主机 id] — 查看当前 DSH 会话的远端续接状态',
  '/hermes-models [主机 id] — 查看已配置模型；切换请用输入框的模型选择器',
  '/hermes-hosts — 列出可用远端主机',
  '/hermes-profiles [主机 id] — 查看已接入的 Hermes 身份；创建和添加请到「设置 → 远程 Hermes」',
  '/hermes-skills [主机 id] [profile] — 通过 SSH 读取当前身份的可用技能，不调用模型',
  '/hermes-reset [主机 id] — 清除当前会话的本地续接关系，下一轮携带 DSH 文本历史重新建立远端会话',
  '这些指令不调用模型。reset 保留 DSH 聊天历史和远端原会话；运行或排队中的会话需先停止。',
].join('\n')

const success = (text) => ({ kind: 'success', text })

function sessionIdOf(agent) {
  const id = agent?.session?.id ?? agent?.id
  if (typeof id !== 'string' || !id) throw new Error('请在 DSH 对话中执行此指令。')
  return id
}

function hostOf(adapter, agent, id, { discovery = false } = {}) {
  if (id) {
    const host = adapter.byId.get(id)
    if (!host) throw new Error(`未知主机「${id}」。输入 /hermes-hosts 查看可用主机。`)
    return host
  }
  const route = agent?.session?.requestContext?.()
  if (route?.provider) {
    const host = adapter.byId.get(route.provider)
    if (host) return host
    if (!discovery) throw new Error('当前会话最近使用的模型不是远程 Hermes。请指定主机 id，或选择 Hermes 模型并完成一轮对话。')
  }
  // Catalog inspection is independent of the chat's selected model and works before its first turn.
  if (discovery && adapter.hosts.length === 1) return adapter.hosts[0]
  if (discovery && !agent?.session?.id && !agent?.id) throw new Error('已配置多个 Hermes 主机，请指定主机 id；输入 /hermes-hosts 查看。')
  const sessionId = sessionIdOf(agent)
  const recorded = adapter.hosts.filter((host) => adapter.storeFor(host.id).get(adapter.keyOf(host.id, sessionId)))
  if (recorded.length === 1) return recorded[0]
  if (recorded.length === 0 && adapter.hosts.length === 1) return adapter.hosts[0]
  throw new Error('当前会话尚未确定 Hermes 主机，请在指令后指定主机 id；可用 /hermes-hosts 查看。')
}

/** Exported for integration tests against the same definitions DSH receives. */
export function registerCommandDefinitions(commands, adapter) {
  const listSkills = async (invocation = {}, argument = '') => {
    try {
      if (invocation.signal?.aborted) throw new Error('指令已取消。')
      const args = argument.trim() ? argument.trim().split(/\s+/) : []
      if (args.length > 2) throw new Error('用法：/hermes-skills [主机 id] [profile]')
      const host = hostOf(adapter, invocation.agent, args[0] || '', { discovery: true })
      const route = invocation.agent?.session?.requestContext?.()
      const row = route?.provider === host.id ? host.models.find((m) => m.id === route.model) : undefined
      const identities = [...new Set(host.models.map((m) => m.hermesProfile || 'default'))]
      const profile = args[1] ? profileName(args[1]) : row ? row.hermesProfile || 'default' : identities.length === 1 ? identities[0] : undefined
      if (!profile) throw new Error(`无法确定当前身份，请使用 /hermes-skills ${host.id} <profile>，或在对话中的技能入口查看当前选择。`)
      const result = await runRemote(adapter, host, skillsCommand(host, profile))
      if (invocation.signal?.aborted) throw new Error('指令已取消。')
      if (result.error) throw new Error(result.error)
      const skills = parseSkills(result.stdout)
      return success([`${host.name} · ${profile} · 可用技能 ${skills.length} 个`, ...skills.map((s) => `${s.name}${s.category ? ` [${s.category}]` : ''}${s.description ? ` — ${s.description}` : ''}`), skills.length ? '在对话技能入口点击「加入输入框」，补充任务后发送。' : '此身份没有可用技能。请在远端检查技能安装及启用设置。'].join('\n'))
    } catch (error) { return { kind: 'error', text: adapter.redact(error instanceof Error ? error.message : String(error)) } }
  }
  const run = (action, invocation = {}, argument = '') => {
    try {
      if (invocation.signal?.aborted) throw new Error('指令已取消。')
      const id = argument.trim()
      if (action === 'help') {
        if (id) throw new Error('用法：/hermes 或 /hermes help')
        return success(HELP)
      }
      if (action === 'hosts') {
        if (id) throw new Error('用法：/hermes-hosts')
        return success(adapter.hosts.map((host) => `${host.id} · ${host.name} · ${host.models.length} 个模型`).join('\n'))
      }
      if (!['status', 'models', 'profiles', 'reset'].includes(action)) throw new Error(`未知操作「${action}」。输入 /hermes 查看帮助。`)
      if (/\s/.test(id)) throw new Error('此指令最多接受一个主机 id；输入 /hermes 查看帮助。')
      const host = hostOf(adapter, invocation.agent, id, { discovery: action === 'profiles' || action === 'models' })
      if (action === 'profiles') {
        return success([
          `${host.name} 已接入的 Hermes 身份：`,
          ...host.models.map((m) => `${m.hermesProfile || 'default'} → 模型行 ${m.id}（${m.name}）`),
          '创建、复制或接入其它身份：设置 → 远程 Hermes → Hermes 身份 / Profiles。',
        ].join('\n'))
      }
      if (action === 'models') {
        return success([
          `${host.name}（${host.id}）的已配置模型：`,
          ...host.models.map((model) => `${model.id} · ${model.name} · 身份：${model.hermesProfile || 'default'} · 远端模型：${model.hermesModel || '远端默认'} · 上下文：${model.contextWindow}`),
          '在输入框的模型选择器中选择对应主机与模型；读取更多远端模型请到「设置 → 远程 Hermes」。',
        ].join('\n'))
      }
      const sessionId = sessionIdOf(invocation.agent)
      const key = adapter.keyOf(host.id, sessionId)
      const record = adapter.storeFor(host.id).get(key)
      if (action === 'reset') {
        adapter.resetSession(host.id, sessionId)
        return success(record
          ? `已重置 ${host.name} 的续接关系。下一轮将携带本会话的 DSH 文本历史建立新远端会话。DSH 历史和远端原会话均保留。`
          : `${host.name} 在当前对话中没有续接记录，无需重置。下一轮会建立新远端会话。`)
      }
      return success([
        `Hermes ${adapter.providerInfo(host.id).version} · ${host.name}（${host.id}）`,
        `DSH 会话：${sessionId}`,
        `状态：${adapter.locks.has(key) ? '运行或排队中' : '空闲'}`,
        record ? `远端会话：${record.session}\n身份：${record.profile || 'default'}\n远端模型：${record.model || '远端默认'}\n续接：${record.scope === adapter.scopeOf({ ...host, hermesProfile: record.profile }) ? '可续接（下轮若换模型或身份将重建）' : '目标配置已变化，下轮重建'}` : '远端会话：暂无已完成的续接记录；活动轮次完成后会更新。',
        `保存方式：${adapter.config.persistSessions ? '磁盘持久保存' : '仅当前进程内存'}`,
      ].join('\n'))
    } catch (error) {
      return { kind: 'error', text: adapter.redact(error instanceof Error ? error.message : String(error)) }
    }
  }
  const definitions = [
    { name: 'hermes', description: 'Hermes 快捷指令帮助：身份、技能、状态、模型、主机和重置续接', input: { hint: '[help|status|models|profiles|skills|hosts|reset] [主机 id]' },
      handler: (invocation) => {
        const input = (invocation.rawInput ?? '').trim()
        const [action = 'help', ...args] = input ? input.split(/\s+/) : []
        return action === 'skills' ? listSkills(invocation, args.join(' ')) : run(action, invocation, args.join(' '))
      } },
    ...[
      ['status', '查看当前会话的 Hermes 续接与运行状态'],
      ['models', '列出 Hermes 已配置的可选模型'],
      ['profiles', '查看已接入的 Hermes 身份及创建入口'],
      ['hosts', '列出已配置的 Hermes 远端主机'],
      ['reset', '重置当前会话的 Hermes 续接关系，保留聊天历史'],
    ].map(([action, description]) => ({
      name: `hermes-${action}`, description,
      ...(action === 'hosts' ? {} : { input: { hint: '[主机 id]' } }),
      handler: (invocation) => run(action, invocation, invocation.rawInput ?? ''),
    })),
    { name: 'hermes-skills', description: '读取当前 Hermes 身份的可用技能', input: { hint: '[主机 id] [profile]' }, handler: (invocation) => listSkills(invocation, invocation.rawInput ?? '') },
  ]
  const disposers = []
  for (const definition of definitions) {
    try { disposers.push(commands.register(definition)) }
    catch (error) { adapter.log(`/${definition.name} not registered: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose?.() } catch {}
    }
  }
}

export function registerHermesCommands(ctx, adapter) {
  // Commands can mount after the provider. Cordis scopes registrations to this injection.
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['commands'], (host) => {
    if (typeof host?.commands?.register !== 'function') return
    const dispose = registerCommandDefinitions(host.commands, adapter)
    if (typeof host.effect === 'function') {
      host.effect(() => dispose)
      return undefined
    }
    return dispose
  })
}
