/**
 * dsh-oh-my-hermes — browser half: the "远程 Hermes" settings page.
 *
 * Written as plain JavaScript with no build step: the module loader hands this
 * factory `require` for the shared client runtime modules, so React and the
 * slot registry come from dsh itself. The page is a settings section that reads
 * and writes the plugin's own config file through the host routes it registers
 * (`/dsh-oh-my-hermes/config`, `/dsh-oh-my-hermes/models`, `/dsh-oh-my-hermes/test`).
 *
 * The point of the model list: a remote box advertises its provider's models in
 * `~/.hermes/provider_models_cache.json`. Picking one here creates a dsh model
 * row whose `-m` argument is that model id, so choosing that row in dsh switches
 * the model the remote agent runs — no remote config edit, no restart.
 */
window.__ModuleLoader__.load({
  id: 'dsh-oh-my-hermes',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useCallback, useEffect, useId, useMemo, useRef, useState } = React
    const h = React.createElement

    const ROUTE = '/dsh-oh-my-hermes'

    const T = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, #626972)',
      faint: 'var(--dsw-alias-label-secondary, #626972)',
      border: 'var(--dsw-alias-border-l2, rgba(128,128,128,.22))',
      card: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05))',
      field: 'var(--dsw-alias-bg-base, transparent)',
      brand: 'var(--dsw-alias-brand-primary, #2563eb)',
      ok: 'var(--dsw-alias-state-success-primary, var(--hermes-success, #147d50))',
      err: 'var(--dsw-alias-state-error-primary, var(--hermes-error, #b42318))',
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 12, color: T.text, fontSize: 'var(--hermes-body-size, 14px)', paddingBottom: 24, minWidth: 0, containerType: 'inline-size', containerName: 'hermes-settings' },
      head: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 16, fontWeight: 600 },
      sub: { color: T.faint, fontSize: 12 },
      card: { border: `1px solid ${T.border}`, borderRadius: 10, background: T.card, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 },
      cardHead: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' },
      cardTitle: { margin: 0, fontSize: 13, fontWeight: 600 },
      row: { display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', alignItems: 'end' },
      field: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
      label: { fontSize: 'var(--hermes-note-size, 12px)', color: T.faint },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '5px 7px',
        borderRadius: 6,
        border: `1px solid ${T.border}`,
        background: T.field,
        color: T.text,
        fontSize: 'var(--hermes-field-size, 13px)',
        fontFamily: 'inherit',
      },
      button: {
        padding: '5px 10px',
        borderRadius: 6,
        border: `1px solid ${T.border}`,
        background: 'transparent',
        color: T.text,
        fontSize: 12,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      primary: {
        padding: '5px 12px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: T.brand,
        color: '#fff',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      ghost: { padding: '2px 7px', borderRadius: 6, border: `1px solid ${T.border}`, background: 'transparent', color: T.faint, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' },
      chip: {
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${T.border}`,
        background: 'transparent',
        color: T.muted,
        fontSize: 11,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      chipOn: {
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${T.brand}`,
        background: 'transparent',
        color: T.brand,
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 5, maxHeight: 150, overflowY: 'auto', padding: '2px 0' },
      footer: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      note: { color: T.faint, fontSize: 'var(--hermes-note-size, 12px)', lineHeight: 1.6 },
      ok: { color: T.ok, fontSize: 12 },
      err: { color: T.err, fontSize: 12, whiteSpace: 'pre-wrap' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: T.muted, wordBreak: 'break-all' },
      modelRow: { display: 'grid', gap: 8, alignItems: 'end', paddingBlock: 8, borderTop: `1px solid ${T.border}` },
    }

    let nextKey = 0
    const keyOf = () => `hermes-host-${++nextKey}`
    const request = async (path, options = {}) => {
      const { timeoutMs = 25000, ...fetchOptions } = options
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try { return await readJson(await fetch(`${ROUTE}${path}`, { ...fetchOptions, signal: controller.signal })) }
      catch (error) { throw new Error(error.name === 'AbortError' ? '请求超时，请检查连接后重试。' : error.message) }
      finally { clearTimeout(timer) }
    }

    const emptyHost = () => ({ _key: keyOf(), id: '', name: '', sshHost: '', sshUser: '', command: 'hermes', remoteCwd: '', models: [] })
    const emptyModel = () => ({ id: '', name: '', hermesModel: '', contextWindow: 200000, maxTokens: 32000 })
    const modelRowFor = (id) => ({ id, name: id, hermesModel: id, contextWindow: 200000, maxTokens: 32000 })

    const asDraft = (view) => ({
      hosts: (view?.hosts ?? []).map((host) => ({
        _key: keyOf(),
        id: host.id ?? '',
        name: host.name ?? '',
        sshHost: host.sshHost ?? '',
        sshUser: host.sshUser ?? '',
        command: host.command ?? 'hermes',
        remoteCwd: host.remoteCwd ?? '',
        models: (host.models ?? []).map((model) => ({
          id: model.id ?? '',
          name: model.name ?? '',
          hermesModel: model.hermesModel ?? '',
          ...(model.hermesProfile ? { hermesProfile: model.hermesProfile } : {}),
          contextWindow: Number(model.contextWindow) || 200000,
          maxTokens: Number(model.maxTokens) || 32000,
        })),
      })),
    })

    const payloadOf = (draft) => ({ hosts: draft.hosts.map(({ _key, ...host }) => host) })

    const readJson = async (response) => {
      const text = await response.text()
      let value
      try {
        value = JSON.parse(text)
      } catch {
        throw new Error(text.slice(0, 200) || `HTTP ${response.status}`)
      }
      if (!response.ok) throw new Error(value?.error ?? `HTTP ${response.status}`)
      return value
    }

    function Field(props) {
      return h(
        'label',
        { style: S.field, className: props.className },
        h('span', { style: S.label }, props.label),
        h(props.multiline ? 'textarea' : 'input', {
          style: S.input,
          value: props.value ?? '',
          placeholder: props.placeholder ?? '',
          spellCheck: false,
          inputMode: props.numeric ? 'numeric' : undefined,
          rows: props.multiline ? 4 : undefined,
          onChange: (event) => props.onChange(props.numeric ? Number(event.target.value.replace(/[^\d]/g, '')) || 0 : event.target.value),
        }),
      )
    }

    function SelectField({ label, value, onChange, options, onFocus }) {
      return h('label', { style: S.field }, h('span', { style: S.label }, label),
        h('select', { style: S.input, 'aria-label': label, value, onChange: (event) => onChange(event.target.value), onFocus },
          ...options.map((option) => h('option', { key: option.value, value: option.value }, option.label))))
    }

    function useHostCatalog(host) {
      const connectionKey = JSON.stringify([host.sshHost, host.sshUser, host.command])
      const cacheRef = useRef(null)
      const [, redraw] = useState(0)
      if (cacheRef.current?.connectionKey !== connectionKey) cacheRef.current = { connectionKey, profiles: null, profileLoading: false, profileError: '', models: {}, pending: new Map() }
      const load = useCallback((kind, selectedProfile = 'default', force = false) => {
        const cache = cacheRef.current
        const profile = selectedProfile || 'default'
        const key = kind === 'profiles' ? 'profiles' : `models:${profile}`
        if (cache.pending.has(key)) return cache.pending.get(key)
        if (!force && (kind === 'profiles' ? cache.profiles : cache.models[profile]?.models)) return Promise.resolve(kind === 'profiles' ? cache.profiles : cache.models[profile])
        if (kind === 'profiles') { cache.profileLoading = true; cache.profileError = '' }
        else cache.models[profile] = { ...(cache.models[profile] ?? {}), loading: true, error: '' }
        redraw((n) => n + 1)
        const query = new URLSearchParams({ sshHost: host.sshHost, sshUser: host.sshUser, ...(kind === 'models' ? { profile, command: host.command } : {}) })
        const pending = request(`/${kind}?${query}`).then((data) => {
          if (cacheRef.current !== cache) return data
          if (kind === 'profiles') cache.profiles = data.profiles ?? []
          else cache.models[profile] = { loading: false, models: data.models ?? [], provider: data.provider, profile, sourceProfile: data.sourceProfile }
          return data
        }).catch((error) => {
          if (cacheRef.current === cache) {
            if (kind === 'profiles') cache.profileError = error.message
            else cache.models[profile] = { ...(cache.models[profile] ?? {}), loading: false, error: error.message }
          }
          throw error
        }).finally(() => {
          cache.pending.delete(key)
          if (cacheRef.current === cache) { if (kind === 'profiles') cache.profileLoading = false; redraw((n) => n + 1) }
        })
        cache.pending.set(key, pending)
        return pending
      }, [connectionKey])
      const loadProfiles = useCallback((force = false) => load('profiles', 'default', force), [load])
      const loadModels = useCallback((profile = 'default', force = false) => load('models', profile, force), [load])
      useEffect(() => {
        if (!host.sshHost) return
        const timer = setTimeout(() => loadProfiles().catch(() => {}), 500)
        return () => clearTimeout(timer)
      }, [connectionKey, loadProfiles])
      return { ...cacheRef.current, loadProfiles, loadModels }
    }

    function ModelEditor(props) {
      const model = props.model
      const profile = model.hermesProfile || 'default'
      const catalog = props.catalog
      const remote = catalog.models[profile]
      useEffect(() => {
        if (!props.canLoad) return
        const timer = setTimeout(() => catalog.loadModels(profile).catch(() => {}), 500)
        return () => clearTimeout(timer)
      }, [profile, catalog.connectionKey, props.canLoad, catalog.loadModels])
      const known = [...new Set((remote?.models ?? []))]
      const modelOptions = [{ value: '', label: '身份默认模型' },
        ...(model.hermesModel && !known.includes(model.hermesModel) ? [{ value: model.hermesModel, label: `${model.hermesModel}（当前配置）` }] : []),
        ...known.map((id) => ({ value: id, label: id }))]
      return h(
        'div',
        { style: { ...S.modelRow, display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 10 }, className: 'hermes-model-editor', role: 'group', 'aria-label': `${model.name || '未命名模型'} 的模型设置`, 'aria-busy': remote?.loading || undefined },
        h('div', { className: 'hermes-model-row', style: { display: 'grid', gap: 10 } },
          h(SelectField, { label: '使用身份', value: profile, options: props.profileOptions, onFocus: () => { if (props.canLoad) catalog.loadProfiles().catch(() => {}) }, onChange: (value) => { props.change('hermesProfile')(value === 'default' ? '' : value); if (props.canLoad) catalog.loadModels(value).catch(() => {}) } }),
          h(SelectField, { label: '远端模型', value: model.hermesModel || '', options: modelOptions, onFocus: () => { if (props.canLoad) catalog.loadModels(profile).catch(() => {}) }, onChange: props.change('hermesModel') }),
          h(Field, { label: '显示名称', value: model.name, placeholder: '在对话模型菜单中显示的名称', className: 'hermes-model-name', onChange: props.change('name') })),
        h('div', { style: S.cardHead },
          h('span', { style: S.note }, remote?.loading ? '正在读取此身份的模型…' : remote?.error ? '模型读取失败，当前配置仍保留。' : remote?.models ? `可选模型 ${remote.models.length} 个${remote.sourceProfile && remote.sourceProfile !== profile ? ` · 参考 ${remote.sourceProfile} 的模型缓存` : ''}` : '连接后会自动读取可选模型。'),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', { type: 'button', style: S.ghost, disabled: props.busy || remote?.loading || !props.canLoad, onClick: () => catalog.loadModels(profile, true).catch(() => {}) }, '刷新可选模型'),
            h('button', { type: 'button', style: S.ghost, disabled: props.busy, onClick: props.onRemove }, '删除模型行'))),
        remote?.error ? h('div', { role: 'alert', style: S.err }, remote.error) : null,
        h('details', { className: 'hermes-model-advanced' },
          h('summary', { style: { ...S.note, cursor: 'pointer' } }, '高级设置'),
          h('div', { style: { ...S.row, paddingTop: 10 } },
            h(Field, { label: '本地模型 id', value: model.id, onChange: props.change('id') }),
            h(Field, { label: '上下文', value: model.contextWindow, numeric: true, onChange: props.change('contextWindow') }),
            h(Field, { label: '最大输出', value: model.maxTokens, numeric: true, onChange: props.change('maxTokens') }),
            h(Field, { label: '自定义远端模型', value: model.hermesModel, placeholder: '列表未收录的模型可在此填写', onChange: props.change('hermesModel') }))),
      )
    }

    function ProfileManager({ host, onConnect, onCreating, catalog }) {
      const profiles = catalog.profiles
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [open, setOpen] = useState(false)
      const [draft, setDraft] = useState({ name: '', description: '', cloneFrom: 'default', instructions: '' })
      const load = () => {
        setBusy(true); setError('')
        catalog.loadProfiles(true)
          .catch((e) => setError(e.message)).finally(() => setBusy(false))
      }
      const create = async (event) => {
        event.preventDefault()
        setBusy(true); setError(''); setNotice('')
        onCreating(true)
        try {
          const result = await request('/profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host, ...draft }), timeoutMs: 70000 })
          onConnect(result.profile.name)
          setNotice(`已在远端创建 ${result.profile.name}，并添加到下方模型行。点击「保存配置」后即可在对话中选择。${draft.cloneFrom ? '' : ` 新建的空白身份需先在远端执行 hermes -p ${result.profile.name} setup 配置模型凭据。`}`)
          setDraft({ name: '', description: '', cloneFrom: 'default', instructions: '' })
          setOpen(false)
          try { await catalog.loadProfiles(true) }
          catch (e) { setError(`Profile 已创建；刷新列表失败：${e.message}`) }
        } catch (e) { setError(`${e.message}。若请求中断或超时，请先刷新列表确认是否已创建，再决定是否重试。`) }
        finally { setBusy(false); onCreating(false) }
      }
      return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 10, borderTop: `1px solid ${T.border}`, paddingTop: 12 } },
        h('div', { style: S.cardHead }, h('h4', { style: S.cardTitle }, 'Hermes 身份 / Profiles'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            h('button', { type: 'button', style: S.button, disabled: busy || catalog.profileLoading || !host.sshHost, onClick: load }, busy || catalog.profileLoading ? '读取身份中…' : '读取 profiles'),
            h('button', { type: 'button', style: S.button, disabled: busy || !host.sshHost, 'aria-expanded': open, onClick: () => setOpen(!open) }, open ? '收起创建表单' : '创建 profile'))),
        h('p', { style: { ...S.note, margin: 0 } }, '下方模型行直接选择已有身份和远端模型。新身份请点击「创建 profile」，添加后保存配置；独立身份建议各用一个新对话。'),
        error || catalog.profileError ? h('div', { role: 'alert', style: S.err }, error || catalog.profileError) : null,
        notice ? h('div', { role: 'status', style: S.ok }, notice) : null,
        profiles ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, ...profiles.map((profile) => h('div', { key: profile.name, style: S.cardHead },
          h('span', null, `${profile.name}${profile.active ? ' · 远端当前默认' : ''}`),
          h('button', { type: 'button', style: S.ghost, disabled: busy || host.models.some((m) => (m.hermesProfile || 'default') === profile.name && !m.hermesModel), onClick: () => onConnect(profile.name) }, host.models.some((m) => (m.hermesProfile || 'default') === profile.name && !m.hermesModel) ? '已添加' : `添加 ${profile.name} 为模型行`)))) : null,
        open ? h('form', { onSubmit: create, 'aria-label': '创建 Hermes profile', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('fieldset', { disabled: busy, style: { border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 } },
            h('div', { style: S.row },
              h(Field, { label: 'Profile 名称', value: draft.name, placeholder: 'coder 或 researcher', onChange: (name) => setDraft({ ...draft, name }) }),
              h(Field, { label: '用途简介', value: draft.description, placeholder: '负责代码实现与测试', onChange: (description) => setDraft({ ...draft, description }) }),
              h('label', { style: S.field, className: 'hermes-profile-source' }, h('span', { style: S.label }, '创建方式'),
                h('select', { style: S.input, 'aria-label': '创建方式', value: draft.cloneFrom, onChange: (e) => setDraft({ ...draft, cloneFrom: e.target.value }) },
                  h('option', { value: '' }, '空白身份，稍后配置凭据'),
                  ...[...new Set(['default', ...(profiles ?? []).map((p) => p.name)])].map((name) => h('option', { key: name, value: name }, `复制 ${name} 的配置与身份`))))),
            h(Field, { label: '长期指令（可选）', value: draft.instructions, multiline: true, placeholder: '你是一名专注于实现与测试的编程助手……', onChange: (instructions) => setDraft({ ...draft, instructions }) }),
            h('p', { style: { ...S.note, margin: 0 } }, '名称使用 1–64 位小写字母、数字、连字符或下划线。复制会继承来源的模型凭据、技能和身份资料（可能包含记忆）。填写的长期指令会替换新身份的 SOUL.md；留空则保留原有设置。创建会立即写入远端，撤销本页配置不会删除已创建的身份。'),
            h('div', null, h('button', { type: 'submit', style: S.primary, disabled: !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(draft.name.trim()) || draft.name.trim() === 'default' }, busy ? '创建中…' : '在远端创建并添加')),
          )) : null,
      )
    }

    function HostCard(props) {
      const [modelFilter, setModelFilter] = useState('')
      const [catalogProfile, setCatalogProfile] = useState('default')
      const host = props.host
      const catalog = useHostCatalog(host)
      const remote = catalog.models[catalogProfile]
      const availableProfiles = new Set(['default', ...(catalog.profiles ?? []).map((p) => p.name), ...host.models.map((m) => m.hermesProfile || 'default')])
      const profileOptions = [...availableProfiles].map((name) => ({ value: name, label: name === 'default' ? 'default · 默认身份' : catalog.profiles && !catalog.profiles.some((p) => p.name === name) ? `${name}（远端未找到，请刷新身份）` : name }))
      const picked = new Set(host.models.filter((model) => (model.hermesProfile || 'default') === (remote?.profile || 'default')).map((model) => model.hermesModel || model.id))
      const visible = (remote?.models ?? []).filter((id) => id.toLowerCase().includes(modelFilter.trim().toLowerCase()))

      return h(
        'fieldset',
        { style: { ...S.card, margin: 0, minWidth: 0 }, disabled: props.busy, 'aria-label': host.name || host.sshHost || `主机 ${props.index + 1}` },
        h(
          'div',
          { style: S.cardHead },
          h('h3', { style: S.cardTitle }, host.name || host.sshHost || `主机 ${props.index + 1}`),
          h(
            'div',
            { style: { display: 'flex', gap: 6 } },
            h('button', { type: 'button', style: S.ghost, disabled: props.busy || props.testing || !host.sshHost, onClick: () => props.onTest(host, props.index) }, props.testing ? '测试中…' : '测试连接'),
            h('button', { type: 'button', style: S.ghost, disabled: props.busy, onClick: props.onRemove }, '删除'),
          ),
        ),
        h(
          'div',
          { style: S.row },
          h(Field, { label: '路由 id', value: host.id, placeholder: 'hermes-remote', onChange: props.change('id') }),
          h(Field, { label: '显示名', value: host.name, placeholder: '远程 Hermes', onChange: props.change('name') }),
          h(Field, { label: 'SSH 主机', value: host.sshHost, placeholder: '主机地址或 SSH 别名', onChange: props.change('sshHost') }),
          h(Field, { label: 'SSH 用户', value: host.sshUser, placeholder: 'ubuntu', onChange: props.change('sshUser') }),
          h(Field, { label: 'hermes 路径', value: host.command, placeholder: '/home/ubuntu/.local/bin/hermes', onChange: props.change('command') }),
          h(Field, { label: '远端工作目录', value: host.remoteCwd, placeholder: '/home/ubuntu', onChange: props.change('remoteCwd') }),
        ),
        props.test
          ? h('div', { style: props.test.ok ? S.ok : S.err }, props.test.ok ? `✓ ${props.test.version || 'ssh 与 hermes 可用'}` : `✗ ${props.test.error || '连接失败'}`)
          : null,
        h(ProfileManager, { key: `${host.sshHost}:${host.sshUser}:${host.command}`, host, onConnect: props.onConnectProfile, onCreating: props.onProfileBusy, catalog }),
        h(
          'div',
          { style: S.cardHead },
          h('span', { style: S.label }, `对话中的可选模型（${host.models.length}）`),
          h(
            'div',
            { style: { display: 'flex', gap: 6 } },
            h('button', { type: 'button', style: S.ghost, disabled: props.busy, onClick: props.onAddModel }, '添加模型'),
          ),
        ),
        h('details', null, h('summary', { style: { ...S.note, cursor: 'pointer' } }, '批量添加远端模型'),
        h('div', { style: { ...S.row, marginBlock: 10 } },
          h(SelectField, { label: '批量添加的身份', value: catalogProfile, options: profileOptions, onChange: setCatalogProfile }),
          h('button', { type: 'button', style: S.button, disabled: props.busy || remote?.loading || !host.sshHost, onClick: () => catalog.loadModels(catalogProfile, true).catch(() => {}) }, remote?.loading ? '读取中…' : '读取远端模型')),
        remote?.error ? h('div', { style: S.err }, `读取远端模型失败：${remote.error}`) : null,
        remote?.models?.length
          ? h(
            'div',
            null,
            h(
              'div',
              { style: S.note },
              `远端共 ${visible.length} 个模型${remote.provider ? `（${remote.provider}）` : ''}，点一下加为模型行，再点一下移除。`,
            ),
            h(Field, { label: '筛选远端模型', value: modelFilter, placeholder: '输入模型名称', onChange: setModelFilter }),
            h(
              'div',
              { style: S.chips },
              ...visible.map((id) =>
                h(
                  'button',
                  {
                    key: id,
                    type: 'button',
                    style: picked.has(id) ? S.chipOn : S.chip,
                    title: picked.has(id) ? '点击移除这一行' : '点击加为模型行',
                    'aria-pressed': picked.has(id),
                    onClick: () => props.onToggleModel(id, remote?.profile || ''),
                  },
                  picked.has(id) ? `✓ ${id}` : id,
                ),
              ),
            ),
          )
          : remote && !remote.loading && !remote.error ? h('p', { style: S.note }, '远端缓存中没有模型，可先选择身份默认模型。') : null),
        ...host.models.map((model, at) =>
          h(ModelEditor, {
            key: at,
            model,
            catalog,
            profileOptions,
            canLoad: Boolean(host.sshHost),
            busy: props.busy,
            change: (key) => (value) => props.onChangeModel(at, key, value),
            onRemove: () => props.onRemoveModel(at),
          }),
        ),
      )
    }

    function SessionsPanel() {
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const refresh = useCallback(() => {
        setBusy(true)
        setNotice('')
        request('/sessions').then(setData).catch((error) => setNotice(error.message)).finally(() => setBusy(false))
      }, [])
      useEffect(refresh, [refresh])
      const reset = (session) => {
        setBusy(true)
        setNotice('')
        request('/sessions', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(session) })
          .then(() => request('/sessions')).then(setData)
          .catch((error) => setNotice(error.message)).finally(() => setBusy(false))
      }
      return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 10, borderTop: `1px solid ${T.border}`, paddingTop: 18 } },
        h('div', { style: S.cardHead }, h('h3', { style: S.cardTitle }, '会话续接与诊断'),
          h('button', { type: 'button', style: S.button, disabled: busy, onClick: refresh }, busy ? '读取中…' : '刷新会话')),
        h('p', { style: { ...S.note, margin: 0 } }, '重置续接后，下一轮会携带 DSH 对话重新建立远端会话。DSH 历史和远端原会话都会保留。'),
        notice ? h('div', { role: 'alert', style: S.err }, notice) : null,
        data ? h('div', { style: S.note }, `插件 ${data.version} · 活动进程 ${data.activeProcesses} · 运行或排队会话 ${data.busySessions} · ${data.persistent ? '续接关系已启用持久保存' : '续接关系仅保留在内存'}`) : null,
        data?.unknownFrames?.length ? h('div', { style: S.err }, `收到未知协议帧：${data.unknownFrames.join(', ')}。请核对远端 Hermes 的版本。`) : null,
        data?.sessions?.length === 0 ? h('div', { style: S.note }, '暂无续接记录。使用 Hermes 完成一轮对话后会出现在这里。') : null,
        ...(data?.sessions ?? []).map((session) => h('div', { key: `${session.provider}:${session.sessionId}`, style: { ...S.cardHead, borderTop: `1px solid ${T.border}`, paddingTop: 10 } },
          h('div', { style: { minWidth: 0, flex: '1 1 240px' } },
            h('div', null, `${session.host} · ${session.profile || 'default'} · ${session.model} · ${session.active ? '运行或排队中' : session.compatible ? '可续接' : '下轮重建'}`),
            h('div', { style: S.mono }, `DSH: ${session.sessionId}`),
            h('div', { style: S.mono }, `Hermes: ${session.remoteSession}`)),
          h('button', { type: 'button', style: S.button, disabled: busy || session.active, onClick: () => reset(session) }, '重置续接'))),
      )
    }

    function RemoteHermesSection() {
      const [view, setView] = useState(null)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [tests, setTests] = useState({})
      const [testing, setTesting] = useState({})
      const [filter, setFilter] = useState('')
      const [profileBusy, setProfileBusy] = useState(false)
      const [saved, setSaved] = useState('')

      const load = useCallback(() => {
        setBusy(true)
        setNotice(null)
        request('/config')
          .then((loaded) => {
            setView(loaded)
            const next = asDraft(loaded)
            setDraft(next)
            setSaved(JSON.stringify(payloadOf(next)))
            setTests({}); setTesting({})
            if (loaded.restartRequired) setNotice({ kind: 'ok', text: '已保存的主机变更尚未启用，请重启 DSH。' })
          })
          .catch((error) => setNotice({ kind: 'err', text: error.message }))
          .finally(() => setBusy(false))
      }, [])

      useEffect(load, [load])

      const totalModels = useMemo(
        () => (draft?.hosts ?? []).reduce((sum, host) => sum + host.models.length, 0),
        [draft],
      )
      const dirty = Boolean(draft) && JSON.stringify(payloadOf(draft)) !== saved
      useEffect(() => {
        if (!dirty) return
        const warn = (event) => { event.preventDefault(); event.returnValue = '' }
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
      }, [dirty])

      if (!draft) {
        return h(
          'div',
          { style: S.page },
          h('h2', { style: S.title }, '远程 Hermes'),
          notice ? h('div', { role: 'alert', style: S.err }, notice.text) : h('div', { style: S.note }, busy ? '读取配置…' : '尚无配置'),
          h('button', { type: 'button', style: S.button, disabled: busy, onClick: load }, '重试'),
        )
      }

      const patchHost = (index, update) =>
        setDraft((current) => ({
          ...current,
          hosts: current.hosts.map((host, at) => (at === index ? update(host) : host)),
        }))

      const changeHost = (index) => (key) => (value) => patchHost(index, (host) => ({ ...host, _key: keyOf(), [key]: value }))
      const changeModel = (index) => (at, key, value) => patchHost(index, (host) => ({
        ...host,
        models: host.models.map((model, position) => {
          if (position !== at) return model
          const next = { ...model, [key]: value }
          const profile = model.hermesProfile || 'default'
          const autoNames = ['', model.id, model.hermesModel, '远端默认模型', 'Remote default', `${profile} · 默认模型`, `${profile} · ${model.hermesModel}`, `${profile} / ${model.hermesModel}`]
          if (key === 'hermesProfile') next.hermesModel = ''
          if ((key === 'hermesProfile' || key === 'hermesModel') && autoNames.includes(model.name)) {
            const identity = next.hermesProfile || 'default'
            next.name = next.hermesModel ? (identity === 'default' ? next.hermesModel : `${identity} · ${next.hermesModel}`) : (identity === 'default' ? '远端默认模型' : `${identity} · 默认模型`)
          }
          if (!next.id && (key === 'hermesProfile' || key === 'hermesModel')) {
            const base = next.hermesModel ? `${next.hermesProfile || 'default'}:${next.hermesModel}` : `profile-${next.hermesProfile || 'default'}`
            let id = base, suffix = 2
            while (host.models.some((m, i) => i !== at && m.id === id)) id = `${base}-${suffix++}`
            next.id = id
          }
          return next
        }),
      }))
      const addModel = (index) => () => patchHost(index, (host) => {
        let id = `model-${host.models.length + 1}`, n = 2
        while (host.models.some((m) => m.id === id)) id = `model-${host.models.length + 1}-${n++}`
        return { ...host, models: [...host.models, { ...emptyModel(), id, name: '远端默认模型' }] }
      })
      const removeModel = (index) => (at) => patchHost(index, (host) => ({ ...host, models: host.models.filter((_, position) => position !== at) }))

      const toggleModel = (index) => (id, profile = '') => patchHost(index, (host) => {
        const matches = (model) => (model.hermesModel || model.id) === id && (model.hermesProfile || 'default') === (profile || 'default')
        const present = host.models.some(matches)
        const base = profile ? `${profile}:${id}` : id
        let modelId = base
        let suffix = 2
        while (host.models.some((model) => model.id === modelId)) modelId = `${base}-${suffix++}`
        return {
          ...host,
          models: present
            ? host.models.filter((model) => !matches(model))
            : [...host.models, { ...modelRowFor(id), id: modelId, name: profile ? `${profile} / ${id}` : id, ...(profile ? { hermesProfile: profile } : {}) }],
        }
      })

      const connectProfile = (hostKey, profile) => setDraft((current) => ({
        ...current, hosts: current.hosts.map((host) => {
          if (host._key !== hostKey || host.models.some((m) => (m.hermesProfile || 'default') === profile && !m.hermesModel)) return host
          const base = `profile-${profile}`
          let id = base, n = 2
          while (host.models.some((m) => m.id === id)) id = `${base}-${n++}`
          return { ...host, models: [...host.models, { ...emptyModel(), id, name: `${profile} · 默认模型`, hermesProfile: profile }] }
        }),
      }))

      const save = () => {
        setBusy(true)
        setNotice(null)
        request('/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payloadOf(draft)),
        })
          .then((result) => {
            const next = asDraft(result.saved)
            setDraft(next)
            setSaved(JSON.stringify(payloadOf(next)))
            setNotice({
            kind: 'ok',
            text: result.live
              ? '已保存并即时生效：新建会话或刷新模型列表即可看到新的模型行。'
              : '已保存。因为增删了主机，需要重启 dsh 才能生效。',
          })
          })
          .catch((error) => setNotice({ kind: 'err', text: error.message }))
          .finally(() => setBusy(false))
      }

      const test = (host, index) => {
        index = host._key
        setTesting((current) => ({ ...current, [index]: true }))
        request('/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(host),
        })
          .then((result) => setTests((current) => ({ ...current, [index]: result })))
          .catch((error) => setTests((current) => ({ ...current, [index]: { ok: false, error: error.message } })))
          .finally(() => setTesting((current) => ({ ...current, [index]: false })))
      }

      const visibleHosts = draft.hosts
        .map((host, index) => ({ host, index }))
        .filter(({ host }) => !filter || `${host.id} ${host.name} ${host.sshHost}`.toLowerCase().includes(filter.toLowerCase()))

      return h(
        'div',
        { style: S.page, className: 'hermes-settings' },
        h('style', null, `.hermes-settings :is(input,textarea,select,button,summary):focus-visible{outline:2px solid ${T.brand};outline-offset:2px}.hermes-settings button:disabled{opacity:.5;cursor:not-allowed}.hermes-settings button:not(:disabled):hover{filter:brightness(.92)}.hermes-settings ::selection{background:rgba(37,99,235,.2)}.hermes-model-row{grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) minmax(0,1fr)}@container hermes-settings (max-width:760px){.hermes-model-row{grid-template-columns:repeat(2,minmax(0,1fr))}.hermes-profile-source,.hermes-model-name{grid-column:1/-1}}@media(prefers-color-scheme:dark){.hermes-settings{--hermes-success:#6fdbad;--hermes-error:#ff9b95}}@media(max-width:600px){.hermes-settings{--hermes-field-size:16px;--hermes-note-size:14px;--hermes-body-size:16px}.hermes-settings button{min-height:36px}}`),
        h(
          'div',
          { style: S.head },
          h('h2', { style: S.title }, '远程 Hermes'),
          h('span', { style: S.sub }, '通过 SSH 把远端 Hermes Agent 接成 dsh 的模型提供方'),
        ),
        h(
          'div',
          { style: S.note },
          '每个主机会变成模型选择器里的一组。先选择身份，再选择远端模型，保存后即可在对话中使用。配置写入 ',
          h('span', { style: S.mono }, view?.file ?? ''),
          '；只改模型行时保存即生效，增删主机才需要重启。',
        ),
        h(
          'div',
          { style: S.cardHead },
          h('h3', { style: S.cardTitle }, `主机（${draft.hosts.length}）· 模型行 ${totalModels}`),
          h(
            'button',
            { type: 'button', style: S.ghost, disabled: busy || profileBusy, onClick: () => setDraft((current) => ({ ...current, hosts: [...current.hosts, emptyHost()] })) },
            '+ 添加主机',
          ),
        ),
        ...visibleHosts.map(({ host, index }) =>
          h(HostCard, {
            key: index,
            host,
            index,
            busy: busy || profileBusy,
            test: tests[host._key],
            testing: Boolean(testing[host._key]),
            change: changeHost(index),
            onChangeModel: changeModel(index),
            onAddModel: addModel(index),
            onRemoveModel: removeModel(index),
            onToggleModel: toggleModel(index),
            onConnectProfile: (profile) => connectProfile(host._key, profile),
            onProfileBusy: setProfileBusy,
            onTest: test,
            onRemove: () => setDraft((current) => ({ ...current, hosts: current.hosts.filter((_, at) => at !== index) })),
          }),
        ),
        h(
          'div',
          { style: S.footer },
          h('button', { type: 'button', style: S.primary, disabled: busy || profileBusy || !dirty, onClick: save }, busy ? '保存中…' : '保存配置'),
          h('button', { type: 'button', style: S.button, disabled: busy || profileBusy || !dirty, onClick: load }, '撤销未保存修改'),
          h('span', { style: S.note }, dirty ? '有未保存的修改' : '配置已保存'),
          h('input', {
            style: { ...S.input, width: 180 },
            value: filter,
            placeholder: '筛选主机…',
            'aria-label': '筛选主机',
            onChange: (event) => setFilter(event.target.value),
          }),
          notice ? h('span', { role: notice.kind === 'ok' ? 'status' : 'alert', style: notice.kind === 'ok' ? S.ok : S.err }, notice.text) : null,
        ),
        h(
          'div',
          { style: S.note },
          '模型选项自动读取所选身份的缓存；复制的身份尚无缓存且模型配置相同时，会借用 default 的候选列表。仍无法读取时，可在远端运行 hermes -p <身份名称> model 刷新。',
        ),
        h(SessionsPanel),
      )
    }

    function SkillsPanel({ host, model, profile, inputActions, draft }) {
      const panelId = useId()
      const trigger = useRef(null)
      const popover = useRef(null)
      const search = useRef(null)
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [state, setState] = useState({ loading: false, skills: null, error: '' })
      const [notice, setNotice] = useState('')
      const alive = useRef(true)
      const pending = useRef(false)
      useEffect(() => {
        const panel = popover.current
        const sync = () => setOpen(panel.matches(':popover-open'))
        panel.addEventListener('toggle', sync)
        return () => panel.removeEventListener('toggle', sync)
      }, [])
      const position = useCallback(() => {
        if (!trigger.current || !popover.current) return
        const rect = trigger.current.getBoundingClientRect()
        const width = Math.min(440, window.innerWidth - 24)
        const above = rect.top >= 240
        Object.assign(popover.current.style, {
          width: `${width}px`, left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
          top: above ? 'auto' : `${rect.bottom + 8}px`, bottom: above ? `${window.innerHeight - rect.top + 8}px` : 'auto',
          maxHeight: `${Math.max(120, Math.min(460, above ? rect.top - 20 : window.innerHeight - rect.bottom - 20))}px`,
        })
      }, [])
      useEffect(() => {
        if (!open) return
        window.addEventListener('resize', position)
        window.addEventListener('scroll', position, true)
        return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
      }, [open, position])
      useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
      const load = () => {
        if (pending.current) return
        pending.current = true
        setState((s) => ({ ...s, loading: true, error: '' }))
        request(`/skills?${new URLSearchParams({ host, model })}`).then((data) => {
          if (data.profile !== profile) throw new Error('此模型行的身份已更改，请重新选择模型后读取。')
          if (alive.current) setState({ loading: false, skills: data.skills, error: '' })
        }).catch((error) => { if (alive.current) setState((s) => ({ ...s, loading: false, error: error.message })) })
          .finally(() => { pending.current = false })
      }
      const skills = (state.skills || []).filter((s) => `${s.name} ${s.description} ${s.category}`.toLowerCase().includes(query.trim().toLowerCase()))
      return h('div', { className: 'hermes-skills', style: { display: 'inline-flex', alignItems: 'center', minWidth: 0 } },
        h('style', null, `.hermes-skills-trigger:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08))!important}.hermes-skills-trigger[aria-expanded="true"]{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.08))!important;color:${T.text}!important}.hermes-skills-trigger:focus-visible,.hermes-skills-popover button:focus-visible,.hermes-skills-popover input:focus-visible{outline:2px solid ${T.brand};outline-offset:2px}.hermes-skills-popover{--hermes-pop-bg:#fff;box-sizing:border-box;color-scheme:light dark}.hermes-skills-popover:not(:popover-open){display:none!important}@media(prefers-color-scheme:dark){.hermes-skills-popover{--hermes-pop-bg:#212429;--hermes-success:#70d9a6;--hermes-error:#ffaca4}}`),
        h('button', { ref: trigger, type: 'button', className: 'hermes-skills-trigger', 'aria-label': `打开 ${profile} 技能`, title: `${profile} 的可用技能`, 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-controls': panelId,
          style: { display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 32, padding: '4px 8px', border: 0, borderRadius: 8, background: 'transparent', color: T.muted, font: 'inherit', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' },
          onClick: () => { if (open) popover.current.hidePopover(); else { position(); popover.current.showPopover(); search.current?.focus(); if (state.skills === null && !state.error) load() } },
        }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: 'M12 5.5C9 3.5 5.5 3.5 3 4.5v15c2.5-1 6-1 9 1 3-2 6.5-2 9-1v-15c-2.5-1-6-1-9 1Zm0 0v15' })), '技能', state.skills ? h('span', { style: { fontSize: 11, fontVariantNumeric: 'tabular-nums', color: T.muted } }, state.skills.length) : null),
        h('section', { ref: popover, id: panelId, popover: 'auto', role: 'dialog', className: 'hermes-skills-popover', 'aria-label': `${profile} 的可用技能`,
          style: { position: 'fixed', inset: 'auto', margin: 0, display: 'flex', flexDirection: 'column', gap: 10, padding: 14, border: 0, borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1,var(--hermes-pop-bg,#fff))', color: T.text, fontSize: 13, fontFamily: 'inherit', boxShadow: '0 8px 32px rgba(0,0,0,.18)', overflow: 'auto' } },
          h('div', { style: S.cardHead }, h('strong', { style: { fontSize: 14, minWidth: 0, overflowWrap: 'anywhere' } }, `${profile} · 技能${state.skills ? `（${state.skills.length}）` : ''}`),
            h('button', { type: 'button', style: S.ghost, 'aria-label': '关闭技能面板', onClick: () => { popover.current.hidePopover(); trigger.current?.focus() } }, '关闭')),
          h('div', { style: S.footer },
            h('input', { ref: search, type: 'search', 'aria-label': '搜索 Hermes 技能', placeholder: '搜索名称、简介或分类', value: query, onChange: (e) => setQuery(e.target.value), style: { ...S.input, flex: '1 1 180px', width: 'auto' } }),
            h('button', { type: 'button', style: S.button, disabled: state.loading, onClick: load }, state.loading ? '读取技能中…' : state.error ? '重试读取技能' : '刷新技能')),
          h('div', { style: S.note }, '来自远端当前身份。点击加入输入框，补充任务后发送。'),
          state.loading ? h('div', { role: 'status', style: S.note }, '正在读取此身份的可用技能…') : null,
          state.error ? h('div', { role: 'alert', style: S.err }, `读取技能失败：${state.error}${state.skills ? '；下方为上次读取的列表。' : ''}`) : null,
          state.skills?.length === 0 && !state.loading ? h('p', { style: S.note }, '此身份没有可用技能，请在远端检查技能安装及启用设置，然后刷新。') : null,
          state.skills?.length > 0 && !skills.length ? h('p', { style: S.note }, '没有匹配的技能，请换个关键词。') : null,
          h('div', { style: { maxHeight: 280, overflowY: 'auto', minWidth: 0, minHeight: 0, flex: '1 1 auto' } }, skills.map((skill) => h('div', { key: skill.name, style: { display: 'flex', gap: 10, alignItems: 'start', padding: '9px 0', borderBottom: `1px solid ${T.border}` } },
            h('div', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, h('strong', null, skill.name), skill.category ? h('span', { style: { ...S.note, marginLeft: 8 } }, skill.category) : null, h('div', { style: S.note }, skill.description || '此技能未提供简介。')),
            h('button', { type: 'button', style: { ...S.button, flexShrink: 0 }, disabled: !inputActions?.setDraft, 'aria-label': `将 ${skill.name} 加入输入框`, onClick: () => {
              const prompt = `请先使用 skill_view 加载技能 ${JSON.stringify(skill.name)}，按该技能完成以下任务：`
              inputActions.setDraft(draft?.trim() ? `${draft}\n\n${prompt}\n` : `${prompt}\n`)
              setNotice(`已加入 ${skill.name}，请补充任务后发送。`)
            } }, '加入输入框')))),
          notice ? h('div', { role: 'status', style: S.ok }, notice) : null,
          !inputActions?.setDraft ? h('div', { style: S.note }, '当前宿主不支持写入输入框，可在消息中说明要使用的技能名称。') : null,
        ))
    }

    function ConversationSkills({ sessionId, ctx, useInput, inputActions }) {
      const draft = useInput?.((s) => s.draft) || ''
      const [route, setRoute] = useState('')
      const [revision, setRevision] = useState(0)
      const [selection, setSelection] = useState(null)
      useEffect(() => {
        if (!sessionId) { setRoute(''); return }
        let directory
        try { directory = ctx.modelDirectories?.directoryFor(sessionId) } catch {}
        const update = () => {
          const current = directory?.store.getSnapshot().current
          // Use the input's current selection, never a previous turn's remote mapping.
          setRoute(current?.provider && current?.model ? JSON.stringify([sessionId, current.provider, current.model]) : '')
          setRevision((n) => n + 1)
        }
        update()
        const stop = directory?.store.subscribe(update)
        return () => stop?.()
      }, [ctx, sessionId])
      useEffect(() => {
        let active = true
        setSelection(null)
        if (!route) return
        const [, provider, model] = JSON.parse(route)
        request('/config').then((config) => {
          const host = config.hosts.find((h) => h.id === provider)
          const row = host?.models.find((m) => m.id === model)
          if (active && row) setSelection({ route, host: provider, model, profile: row.hermesProfile || 'default' })
        }).catch(() => {})
        return () => { active = false }
      }, [route, revision])
      useEffect(() => {
        if (typeof document === 'undefined' || !selection || selection.route !== route || JSON.parse(route)[0] !== sessionId) return
        const owner = keyOf()
        document.body.setAttribute('data-hermes-reading', owner)
        return () => { if (document.body.getAttribute('data-hermes-reading') === owner) document.body.removeAttribute('data-hermes-reading') }
      }, [selection, route, sessionId])
      if (!selection || selection.route !== route || JSON.parse(route)[0] !== sessionId) return null
      return h(SkillsPanel, { key: `${route}:${selection.profile}`, ...selection, inputActions, draft })
    }

    function CommandFeedback({ sessionId, feedback }) {
      const [, setVersion] = useState(0)
      useEffect(() => {
        const update = () => setVersion((value) => value + 1)
        feedback.listeners.add(update)
        update()
        return () => feedback.listeners.delete(update)
      }, [feedback])
      const result = feedback.results.get(sessionId)
      if (!sessionId || !result) return null
      return h('section', {
        className: 'hermes-command-feedback', 'aria-label': 'Hermes 命令结果',
        role: result.kind === 'error' ? 'alert' : 'status',
        style: { ...S.card, color: T.text, fontSize: 14, lineHeight: 1.6, minWidth: 0, boxSizing: 'border-box',
          width: 'calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px))',
          maxWidth: 'calc(var(--dsh-composer-card-max-width,calc(var(--dsh-chat-content-width,748px) + 32px)) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px))', marginInline: 'auto' },
      },
      h('style', null, `.hermes-command-feedback button:focus-visible{outline:2px solid ${T.brand};outline-offset:2px}`),
      h('div', { style: S.cardHead },
        h('h3', { style: { ...S.cardTitle, overflowWrap: 'anywhere' } }, `/${result.name} · ${result.kind === 'error' ? '执行失败' : '执行完成'}`),
        h('button', { type: 'button', style: S.button, 'aria-label': '关闭 Hermes 命令结果', onClick: () => {
          feedback.results.delete(sessionId)
          for (const update of feedback.listeners) update()
        } }, '关闭')),
      h('div', { tabIndex: 0, 'aria-label': '命令输出', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflowY: 'auto' } }, result.text),
      )
    }

    function installReadingStyles() {
      if (typeof document === 'undefined') return () => {}
      const style = document.createElement('style')
      style.setAttribute('data-hermes-reading-style', '')
      // Keep the host's responsive column, user width preference and wide-table layout.
      // Only style assistant Markdown; never add a second fixed-width text column.
      const assistant = 'body[data-hermes-reading] [data-chat-flow-kind="assistant-step"]'
      const text = `${assistant} [class*="_markdown"]`
      style.textContent = `
${text}{box-sizing:border-box;width:100%;max-width:100%;min-width:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei",sans-serif;font-size:var(--dsh-content-font-size,15px);line-height:1.85;letter-spacing:normal;overflow-wrap:anywhere;color:${T.text}}
${text} p{margin:0 0 1em;line-height:inherit}
${text}>:first-child{margin-top:0}
${text}>:last-child{margin-bottom:0}
${text} :is(h1,h2,h3,h4,h5,h6){font-family:inherit;font-weight:600;line-height:1.45;margin:1.6em 0 .65em;padding:0;border:0;overflow-wrap:anywhere}
${text} h1{font-size:1.5em}${text} h2{font-size:1.25em}${text} h3{font-size:1.1em}${text} :is(h4,h5,h6){font-size:1em}
${text} strong{font-weight:600}
${text} :is(ul,ol){padding-inline-start:1.5em;margin:0 0 1em}
${text} li{padding-inline-start:.15em}${text} li+li{margin-top:.35em}${text} li>p{margin:.3em 0}
${text} code{font-family:"Cascadia Code","SFMono-Regular",Consolas,"Liberation Mono",monospace;font-size:.9em;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.09));padding:.15em .35em;border-radius:4px;overflow-wrap:anywhere}
${text} .md-code-block{max-width:100%;min-width:0;margin:1em 0;border-radius:8px}
${text} pre{max-width:100%;overflow-x:auto;line-height:1.65;tab-size:2;white-space:pre}
${text} pre code{font-size:inherit;line-height:inherit;background:transparent;padding:0;border-radius:0;overflow-wrap:normal;white-space:inherit}
${text} table{display:block;max-width:100%;overflow-x:auto;overflow-wrap:normal;border-collapse:collapse;margin:1em 0;font-size:.93em;line-height:1.65}
${text} :is(th,td){padding:.55em .8em;border:0;border-bottom:1px solid ${T.border};text-align:start;vertical-align:top}
${text} th{font-weight:600;background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.05))}
${text} blockquote{margin:1em 0;padding:.1em 1em;color:${T.muted};border-inline-start:1px solid ${T.border}}
${text} blockquote p:last-child{margin-bottom:0}
${text} a{text-underline-offset:.18em;overflow-wrap:anywhere}
${text} img{max-width:100%;height:auto}
${text} hr{margin:1.5em 0;border:0;border-top:1px solid ${T.border}}
@media(max-width:600px){${text}{line-height:1.8}${text} :is(th,td){padding:.5em .65em;white-space:nowrap}}
@container (max-width:600px){${text}{line-height:1.8}${text} :is(th,td){padding:.5em .65em;white-space:nowrap}}
`
      document.head.append(style)
      return () => { style.remove(); document.body.removeAttribute('data-hermes-reading') }
    }

    function installToolFolding() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
      const mark = '远端工具\u2060 · '
      const selector = '[class*="_markdown"] p'
      const attr = 'data-hermes-tool'
      const style = document.createElement('style')
      style.textContent = `p[${attr}]{font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6;color:${T.muted};margin:8px 0 4px!important;padding:4px 4px 4px 20px;position:relative;cursor:pointer;overflow-wrap:anywhere}p[${attr}]::before{content:"";position:absolute;left:5px;top:.9em;width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg)}p[${attr}="open"]::before{transform:rotate(45deg)}p[${attr}]:hover{background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.06));border-radius:4px}p[${attr}]:focus-visible{outline:2px solid ${T.brand};outline-offset:2px}p[data-hermes-tool-failed]{color:${T.err}}@media(prefers-color-scheme:dark){p[data-hermes-tool-failed]{--hermes-error:#ffaca4}}p[${attr}="closed"]+.md-code-block{display:none!important}p[${attr}]+.md-code-block{margin-top:4px!important;max-height:360px;overflow:auto}`
      document.head.append(style)
      let nextId = 0, scheduled = 0, stopped = false
      const ownedIds = new Set()
      const dirty = new Set()
      const scan = () => {
        scheduled = 0
        if (stopped) return
        const paragraphs = new Set()
        for (const root of dirty) {
          if (!root.isConnected) continue
          if (root.matches?.(selector)) paragraphs.add(root)
          for (const paragraph of root.querySelectorAll(selector)) paragraphs.add(paragraph)
        }
        dirty.clear()
        for (const paragraph of paragraphs) {
          const first = paragraph.firstChild
          const body = paragraph.nextElementSibling
          const marked = first?.nodeType === Node.TEXT_NODE && first.nodeValue.startsWith(mark)
          if (!marked || !body?.classList.contains('md-code-block')) {
            if (paragraph.hasAttribute(attr)) for (const key of [attr, 'data-hermes-tool-failed', 'role', 'tabindex', 'aria-expanded', 'aria-controls']) paragraph.removeAttribute(key)
            continue
          }
          if (!paragraph.hasAttribute(attr)) paragraph.setAttribute(attr, 'closed')
          if (!body.id) { body.id = `hermes-tool-body-${++nextId}`; ownedIds.add(body.id) }
          paragraph.setAttribute('role', 'button')
          paragraph.setAttribute('tabindex', '0')
          paragraph.setAttribute('aria-expanded', String(paragraph.getAttribute(attr) === 'open'))
          paragraph.setAttribute('aria-controls', body.id)
          if (first.nodeValue.startsWith(`${mark}失败`)) paragraph.setAttribute('data-hermes-tool-failed', '')
        }
      }
      const schedule = () => { if (!scheduled && !stopped) scheduled = requestAnimationFrame(scan) }
      const collect = (node) => {
        const element = node instanceof Element ? node : node.parentElement
        if (!element) return
        const root = element.closest('[class*="_markdown"]')
        if (root) dirty.add(root)
        else for (const child of element.querySelectorAll('[class*="_markdown"]')) dirty.add(child)
      }
      const observer = new MutationObserver((records) => {
        for (const record of records) { collect(record.target); for (const node of record.addedNodes) collect(node) }
        if (dirty.size) schedule()
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      const toggle = (event) => {
        if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return
        const paragraph = event.target instanceof Element ? event.target.closest(`p[${attr}]`) : null
        if (!paragraph) return
        if (event.type === 'keydown') event.preventDefault()
        const open = paragraph.getAttribute(attr) !== 'open'
        paragraph.setAttribute(attr, open ? 'open' : 'closed')
        paragraph.setAttribute('aria-expanded', String(open))
      }
      document.addEventListener('click', toggle)
      document.addEventListener('keydown', toggle)
      dirty.add(document.body)
      scan()
      return () => {
        stopped = true
        dirty.clear()
        observer.disconnect()
        if (scheduled) cancelAnimationFrame(scheduled)
        document.removeEventListener('click', toggle)
        document.removeEventListener('keydown', toggle)
        style.remove()
        for (const paragraph of document.querySelectorAll(`p[${attr}]`)) for (const key of [attr, 'data-hermes-tool-failed', 'role', 'tabindex', 'aria-expanded', 'aria-controls']) paragraph.removeAttribute(key)
        for (const id of ownedIds) document.getElementById(id)?.removeAttribute('id')
      }
    }

    function apply(ctx) {
      const stopReading = installReadingStyles()
      ctx.effect?.(() => stopReading)
      const stopFolding = installToolFolding()
      ctx.effect?.(() => stopFolding)
      const feedback = { results: new Map(), listeners: new Set() }
      // DSH acknowledges execution here even when its blank-chat flow has no visible result node.
      ctx.on?.('command/executed', (sessionId, name, result) => {
        if (typeof sessionId !== 'string' || typeof name !== 'string' || !(name === 'hermes' || /^hermes-(status|models|profiles|hosts|reset|skills)$/.test(name))) return
        if (!result || !['success', 'error'].includes(result.kind)) return
        const text = typeof result.text === 'string' && result.text.trim() ? result.text : '指令已完成，没有文字输出。'
        feedback.results.delete(sessionId)
        feedback.results.set(sessionId, { name, kind: result.kind, text: text.length > 12000 ? `${text.slice(0, 12000)}\n…（输出已截断）` : text })
        while (feedback.results.size > 100) feedback.results.delete(feedback.results.keys().next().value)
        for (const update of feedback.listeners) update()
      })
      ctx.effect?.(() => () => { feedback.results.clear(); feedback.listeners.clear() })
      try {
        ctx.slots.inject('conversation.input.dock', () => {
          ctx.slots.register({ name: 'conversation.input.dock', id: 'hermes-command-result', order: 35 },
            (props) => h(CommandFeedback, { sessionId: props.sessionId, feedback }))
          return null
        })
      } catch (error) {
        console.error('[dsh-oh-my-hermes] command feedback slot not registered', error)
      }
      try {
        ctx.slots.inject('conversation.input.left', () => {
          ctx.slots.register({ name: 'conversation.input.left', id: 'hermes-skills', order: 55 }, (props) => h(ConversationSkills, { ...props, ctx }))
          return null
        })
      } catch (error) { console.error('[dsh-oh-my-hermes] skills toolbar slot not registered', error) }
      try {
        ctx.slots.inject('settings.section', () => {
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'oh-my-hermes',
              order: 21,
              label: '远程 Hermes',
              inject: () => ({}),
            },
            RemoteHermesSection,
          )
          return null
        })
      } catch (error) {
        console.error('[dsh-oh-my-hermes] settings section not registered', error)
      }
      return null
    }

    module.exports = { name: 'dsh-oh-my-hermes-client', inject: ['slots', 'modelDirectories'], apply }
    return module.exports
  },
})
