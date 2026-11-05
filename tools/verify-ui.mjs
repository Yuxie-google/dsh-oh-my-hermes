/** Isolated browser regression check. Uses local React UMD files; never contacts a real SSH host. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { apply } from '../lib/index.js'
import { formatToolCall, formatToolResult } from '../lib/tool-display.js'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.HERMES_PLAYWRIGHT_PATH || 'playwright')
const { marked } = require(process.env.HERMES_MARKED_PATH || 'marked')
const renderMarkdown = (text) => marked.parse(text).replaceAll('<pre>', '<div class="md-code-block"><pre>').replaceAll('</pre>', '</pre></div>')
let handler, adapter, dispose
const remoteProfiles = ['default', 'researcher']
const remoteCommands = []
const dir = mkdtempSync(join(tmpdir(), 'hermes-ui-'))
const ctx = {
  llm: {
    registerAdapter: (_, instance) => { adapter = instance; const stop = () => {}; stop.replace = () => {}; return stop },
    registerConfigurableProviders: () => () => {},
  },
  inject: (_, callback) => callback({ webServer: { register: (route) => { handler = route.handler; return () => {} } }, connection: { requestRejection: () => undefined } }),
  on: (_, callback) => { dispose = callback },
}
apply(ctx, {
  stateDir: dir,
  hosts: [{ id: 'demo', name: '开发服务器', sshHost: 'example.test', sshUser: 'ubuntu', remoteCwd: '/srv/work', models: [{ id: 'hermes', name: '远端默认模型' }, { id: 'model-a', name: '模型 A', hermesModel: 'model-a' }] }],
  spawnProcess: (_, args) => {
    const command = args.at(-1)
    remoteCommands.push(command)
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => child.emit('close', -1)
    setImmediate(() => {
      let output = 'Hermes 1.0.0\n'
      let code = 0
      if (command.includes('profile create')) {
        const name = /profile create '([^']+)'/.exec(command)?.[1]
        if (remoteProfiles.includes(name)) { code = 1; child.stderr.emit('data', 'Profile already exists') }
        else { remoteProfiles.push(name); output = `Created profile ${name}` }
      } else if (command.includes('dsh:skills-catalog')) output = JSON.stringify({ success: true, skills: command.endsWith("'coder'") ? [{ name: 'debugging', description: 'Find the root cause', category: 'development' }, { name: 'code-review', description: 'Review changes', category: 'development' }] : command.endsWith("'researcher'") ? [{ name: 'research-only', description: 'Find research', category: 'research' }] : [] })
      else if (command.startsWith('python3 -c')) output = JSON.stringify({ profiles: remoteProfiles.map((name) => ({ name, active: name === 'default' })) })
      else if (command.startsWith('cat ')) output = JSON.stringify({ 'provider#cache': { models: ['model-b', 'model-c'] } })
      child.stdout.emit('data', output); child.emit('close', code)
    })
    return child
  },
})
adapter.storeFor('demo').set('demo:conversation-123', { session: 'remote-123', model: '', scope: adapter.scopeOf(adapter.hosts[0]) })
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;background:#fafafa;color:#202327;font:14px system-ui,sans-serif}main{max-width:960px;margin:32px auto;padding:16px;box-sizing:border-box}*{box-sizing:border-box}
@media(prefers-color-scheme:dark){body{background:#191b1f;color:#e7e9ed;--dsw-alias-bg-base:#191b1f;--dsw-alias-bg-layer-1:#212429;--dsw-alias-label-primary:#e7e9ed;--dsw-alias-label-secondary:#b0b4be;--dsw-alias-label-tertiary:#a3a9b3;--dsw-alias-border-l2:#40454e}}
.fixture-composer{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);width:min(900px,calc(100% - 32px));background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#e6e8eb);border-radius:24px;padding:14px 16px;box-shadow:0 4px 24px rgba(0,0,0,.05)}.fixture-draft{height:58px;color:#8b919b;font-size:15px}.fixture-controls{display:flex;align-items:center;gap:10px;min-width:0}.fixture-mode{font-size:13px;color:#626972;white-space:nowrap}.fixture-model{margin-left:auto;font-size:12px;color:#626972}@media(max-width:500px){.fixture-model{display:none}}main{padding-bottom:180px}.fixture_markdown{font-size:15px;line-height:1.7;min-width:0}.fixture_markdown .md-code-block{background:var(--dsw-alias-bg-layer-1,#f1f3f5);border-radius:8px;padding:12px;max-width:100%;overflow:auto}.fixture_markdown pre{margin:0;white-space:pre;font-size:12px}.fixture_markdown table{border-collapse:collapse;width:100%}.fixture_markdown th,.fixture_markdown td{border-bottom:1px solid var(--dsw-alias-border-l2,#ddd);padding:6px;text-align:left}</style><main><div id="reading-flow" data-chat-flow-kind="assistant-step"><article id="tool-fixture" class="fixture_markdown" hidden></article></div><div id="reading-user" data-chat-flow-kind="user" hidden><article class="fixture_markdown"><p>用户消息保持宿主样式。</p></article></div><div id="hermes-feedback"></div><div id="root"></div></main><div class="fixture-composer"><div class="fixture-draft">发消息或创建任务，调用指令，@ 文件或对话</div><div class="fixture-controls"><span class="fixture-mode">＋</span><span class="fixture-mode">工作区内修改</span><div id="hermes-toolbar"></div><span class="fixture-model">coder · deepseek-v4.1-flash-1017</span></div></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>window.__ModuleLoader__={load(spec){const plugin=spec.factory(id=>{if(id==='react')return React;throw Error(id)});window.__hermesEvents={};window.__hermesRoute={provider:'deepseek',model:'chat'};window.__hermesSubscribers=new Set();window.__hermesDraft='已有任务';window.__selectHermesRoute=(route)=>{window.__hermesRoute=route;for(const fn of window.__hermesSubscribers)fn()};window.__hermesDisposers=[];plugin.apply({effect(fn){const stop=fn();if(typeof stop==='function')window.__hermesDisposers.push(stop)},modelDirectories:{directoryFor(){return {store:{getSnapshot:()=>({current:window.__hermesRoute}),subscribe(fn){window.__hermesSubscribers.add(fn);return ()=>window.__hermesSubscribers.delete(fn)}}}}},on(name,fn){(window.__hermesEvents[name]??=[]).push(fn)},slots:{inject(_,fn){fn()},register(spec,Component){const dock=spec.name==='conversation.input.dock';const toolbar=spec.name==='conversation.input.left';const root=ReactDOM.createRoot(document.getElementById(toolbar?'hermes-toolbar':dock?'hermes-feedback':'root'));if(dock||toolbar){window.__hermesRoots??=[];window.__hermesRoots.push({root,Component});window.__renderHermesDock=(sessionId)=>{window.__dockSession=sessionId;for(const {root,Component}of window.__hermesRoots)root.render(React.createElement(Component,{sessionId,useInput:selector=>selector({draft:window.__hermesDraft}),inputActions:{setDraft(value){window.__hermesDraft=value;window.__renderHermesDock(window.__dockSession)}}}))};window.__renderHermesDock('ui-chat')}else root.render(React.createElement(Component,{}))}}})}};</script><script src="/client.js"></script></html>`
const server = createServer((req, res) => {
  if (req.url.startsWith('/dsh-oh-my-hermes/')) return handler(req, res)
  const paths = { '/react.js': '.preview/react.js', '/react-dom.js': '.preview/react-dom.js', '/client.js': 'lib/client.js' }
  if (paths[req.url]) { res.setHeader('content-type', 'application/javascript'); res.end(readFileSync(paths[req.url])); return }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html)
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({ headless: true, ...(process.env.HERMES_CHROMIUM_PATH ? { executablePath: process.env.HERMES_CHROMIUM_PATH } : {}) })
let page
try {
  page = await browser.newPage({ viewport: { width: 1100, height: 1000 } })
  page.setDefaultTimeout(10000)
  const errors = []; page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByText('配置已保存', { exact: true }).waitFor()
  const acknowledge = (sessionId, name, result) => page.evaluate(({ sessionId, name, result }) => {
    for (const listener of window.__hermesEvents['command/executed'] ?? []) listener(sessionId, name, result)
  }, { sessionId, name, result })
  const feedback = page.getByRole('region', { name: 'Hermes 命令结果' })
  // Native DSH event shape: the command acknowledgment must be visible even without a chat flow.
  await acknowledge('ui-chat', 'hermes-profiles', { kind: 'success', text: '可用身份：default、coder' })
  await page.getByRole('status').filter({ hasText: '可用身份：default、coder' }).waitFor()
  await acknowledge('other-chat', 'hermes-status', { kind: 'error', text: 'Other session private output' })
  assert.equal(await page.getByText('Other session private output', { exact: true }).count(), 0)
  await acknowledge('ui-chat', 'unrelated-command', { kind: 'success', text: 'Unrelated output' })
  assert.equal(await page.getByText('Unrelated output', { exact: true }).count(), 0)
  await acknowledge('ui-chat', 'hermes-status', { kind: 'error', text: '找不到指定主机，请检查主机 id。' })
  await page.getByRole('alert').filter({ hasText: '找不到指定主机' }).waitFor()
  await page.getByRole('button', { name: '关闭 Hermes 命令结果', exact: true }).click()
  assert.equal(await page.locator('.hermes-command-feedback').count(), 0)
  await page.evaluate(() => window.__renderHermesDock('other-chat'))
  await page.getByRole('alert').filter({ hasText: 'Other session private output' }).waitFor()
  await page.evaluate(() => window.__renderHermesDock('ui-chat'))
  assert.equal(await page.getByText('Other session private output', { exact: true }).count(), 0)
  const firstEditor = page.locator('.hermes-model-editor').first()
  assert.equal(await firstEditor.getByLabel('本地模型 id', { exact: true }).isVisible(), false, 'route identifiers stay in advanced settings')
  await firstEditor.getByText('高级设置', { exact: true }).click()
  const input = firstEditor.getByLabel('本地模型 id', { exact: true })
  await input.fill('renamed')
  assert.equal(await input.evaluate((el) => el === document.activeElement), true, 'editing model id keeps keyboard focus')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存并即时生效' }).waitFor()
  assert.equal(adapter.hosts[0].models[0].id, 'renamed')
  await firstEditor.getByText('高级设置', { exact: true }).click()
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await page.getByText('✓ Hermes 1.0.0', { exact: true }).waitFor()
  await page.getByRole('button', { name: '重置续接', exact: true }).click()
  await page.getByText('暂无续接记录。', { exact: false }).waitFor()
  assert.equal(adapter.sessionsView().length, 0)
  await page.getByRole('button', { name: '读取 profiles', exact: true }).click()
  await page.getByRole('button', { name: '添加 researcher 为模型行', exact: true }).click()
  await page.getByRole('button', { name: '创建 profile', exact: true }).click()
  await page.getByLabel('Profile 名称', { exact: true }).fill('coder')
  await page.getByLabel('用途简介', { exact: true }).fill('代码实现与测试')
  await page.getByLabel('长期指令（可选）', { exact: true }).fill('You are a careful coding assistant.')
  mkdirSync('.preview', { recursive: true })
  await page.getByRole('form', { name: '创建 Hermes profile' }).screenshot({ path: '.preview/profile-create-desktop.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByRole('form', { name: '创建 Hermes profile' }).screenshot({ path: '.preview/profile-create-dark.png' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'profile creation form fits mobile')
  await page.getByRole('form', { name: '创建 Hermes profile' }).screenshot({ path: '.preview/profile-create-mobile.png' })
  await page.setViewportSize({ width: 1100, height: 1000 })
  await page.getByRole('button', { name: '在远端创建并添加', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已在远端创建 coder' }).waitFor()
  assert.ok(remoteCommands.some((command) => command.includes("--clone-from 'default'") && command.includes('--no-alias') && command.includes('You are a careful coding assistant.')))
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存并即时生效' }).waitFor()
  assert.ok(adapter.hosts[0].models.some((row) => row.hermesProfile === 'coder' && row.hermesModel === ''))
  assert.ok(adapter.hosts[0].models.some((row) => row.hermesProfile === 'researcher'))
  await page.getByText('批量添加远端模型', { exact: true }).click()
  await page.getByLabel('批量添加的身份', { exact: true }).selectOption('coder')
  await page.getByRole('button', { name: '读取远端模型', exact: true }).click()
  await page.getByRole('button', { name: 'model-b', exact: true }).click()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存并即时生效' }).waitFor()
  assert.ok(adapter.hosts[0].models.some((row) => row.hermesProfile === 'coder' && row.hermesModel === 'model-b'))
  assert.ok(remoteCommands.some((command) => command.includes("profiles/'coder'/provider_models_cache.json")))
  await page.getByText('批量添加远端模型', { exact: true }).click()
  await page.getByRole('button', { name: '添加模型', exact: true }).click()
  const editor = page.locator('.hermes-model-editor').last()
  const routeId = await editor.getByLabel('本地模型 id', { exact: true }).inputValue()
  assert.ok(routeId)
  await editor.getByLabel('使用身份', { exact: true }).selectOption('coder')
  assert.equal(await editor.getByLabel('远端模型', { exact: true }).inputValue(), '')
  await editor.getByLabel('远端模型', { exact: true }).selectOption('model-c')
  assert.equal(await editor.getByLabel('显示名称', { exact: true }).inputValue(), 'coder · model-c')
  await editor.getByLabel('显示名称', { exact: true }).fill('专用编程助手')
  await editor.getByLabel('使用身份', { exact: true }).selectOption('researcher')
  assert.equal(await editor.getByLabel('远端模型', { exact: true }).inputValue(), '', 'switching identity clears the preceding model override')
  assert.equal(await editor.getByLabel('显示名称', { exact: true }).inputValue(), '专用编程助手')
  await editor.getByLabel('使用身份', { exact: true }).selectOption('coder')
  await editor.getByLabel('远端模型', { exact: true }).selectOption('model-c')
  await editor.getByLabel('远端模型', { exact: true }).focus()
  await editor.getByLabel('远端模型', { exact: true }).press('Home')
  await editor.getByLabel('远端模型', { exact: true }).press('ArrowDown')
  assert.equal(await editor.getByLabel('远端模型', { exact: true }).inputValue(), 'model-b', 'model dropdown supports keyboard selection')
  await editor.getByLabel('远端模型', { exact: true }).selectOption('model-c')
  assert.equal(await editor.getByLabel('本地模型 id', { exact: true }).inputValue(), routeId, 'model route id is stable across dropdown changes')
  await page.route('**/dsh-oh-my-hermes/models?**', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary model discovery failure' }) }))
  await editor.getByRole('button', { name: '刷新可选模型', exact: true }).click()
  await editor.getByRole('alert').filter({ hasText: 'Temporary model discovery failure' }).waitFor()
  assert.equal(await editor.getByLabel('远端模型', { exact: true }).inputValue(), 'model-c')
  await page.unroute('**/dsh-oh-my-hermes/models?**')
  await editor.getByRole('button', { name: '刷新可选模型', exact: true }).click()
  await editor.getByText('可选模型 2 个', { exact: false }).waitFor()
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '已保存并即时生效' }).waitFor()
  assert.ok(adapter.hosts[0].models.some((row) => row.id === routeId && row.hermesProfile === 'coder' && row.hermesModel === 'model-c' && row.name === '专用编程助手'))
  // Duplicate creation surfaces the server error and offers a list refresh.
  await page.getByRole('button', { name: '创建 profile', exact: true }).click()
  await page.getByLabel('Profile 名称', { exact: true }).fill('coder')
  await page.getByRole('button', { name: '在远端创建并添加', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'already exists' }).waitFor()
  assert.equal(remoteProfiles.filter((name) => name === 'coder').length, 1)
  await page.getByRole('button', { name: '读取 profiles', exact: true }).click()
  await page.getByRole('button', { name: '收起创建表单', exact: true }).click()
  // Live conversation skill discovery uses the selected model, including blank chats.
  assert.equal(await page.locator('.hermes-skills').count(), 0, 'other providers have no Hermes skill panel')
  const coderModel = adapter.hosts[0].models.find((m) => m.hermesProfile === 'coder' && !m.hermesModel).id
  const researcherModel = adapter.hosts[0].models.find((m) => m.hermesProfile === 'researcher').id
  const selectRoute = (model, provider = 'demo') => page.evaluate(({ model, provider }) => window.__selectHermesRoute({ provider, model }), { model, provider })
  await selectRoute(coderModel)
  const skillsTrigger = page.getByRole('button', { name: '打开 coder 技能', exact: true })
  await skillsTrigger.focus()
  await skillsTrigger.press('Enter')
  const skillsPanel = page.getByRole('dialog', { name: 'coder 的可用技能' })
  await skillsPanel.getByRole('button', { name: '将 debugging 加入输入框', exact: true }).waitFor()
  assert.equal(await skillsTrigger.getAttribute('aria-expanded'), 'true')
  assert.equal(await page.getByLabel('搜索 Hermes 技能').evaluate((el) => el === document.activeElement), true)
  assert.equal(await skillsTrigger.evaluate((el) => !!el.closest('#hermes-toolbar')), true)
  const desktopAnchor = await skillsTrigger.boundingBox()
  const desktopPopover = await skillsPanel.boundingBox()
  assert.ok(desktopPopover.y + desktopPopover.height <= desktopAnchor.y - 6, 'popover opens above its toolbar anchor')
  await page.keyboard.press('Escape')
  await skillsPanel.waitFor({ state: 'hidden' })
  await skillsTrigger.click()
  await skillsPanel.waitFor()
  await skillsTrigger.click()
  await skillsPanel.waitFor({ state: 'hidden' })
  await skillsTrigger.click()
  await skillsPanel.waitFor()
  await page.locator('.fixture-draft').click({ position: { x: 10, y: 10 } })
  await skillsPanel.waitFor({ state: 'hidden' })
  await skillsTrigger.click()
  await skillsPanel.waitFor()
  await skillsPanel.getByLabel('搜索 Hermes 技能').fill('root cause')
  assert.equal(await skillsPanel.getByRole('button', { name: '将 code-review 加入输入框', exact: true }).count(), 0)
  await skillsPanel.getByRole('button', { name: '将 debugging 加入输入框', exact: true }).click()
  const skillDraft = await page.evaluate(() => window.__hermesDraft)
  assert.match(skillDraft, /^已有任务/)
  assert.match(skillDraft, /skill_view.*"debugging"/)
  await skillsPanel.getByLabel('搜索 Hermes 技能').fill('no-match')
  await skillsPanel.getByText('没有匹配的技能，请换个关键词。').waitFor()
  await skillsPanel.getByLabel('搜索 Hermes 技能').fill('')
  await page.route('**/dsh-oh-my-hermes/skills?**', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'SSH unavailable' }) }))
  await skillsPanel.getByRole('button', { name: '刷新技能', exact: true }).click()
  await skillsPanel.getByRole('alert').filter({ hasText: 'SSH unavailable' }).waitFor()
  assert.equal(await skillsPanel.getByRole('button', { name: '将 debugging 加入输入框', exact: true }).count(), 1)
  await page.unroute('**/dsh-oh-my-hermes/skills?**')
  await skillsPanel.getByRole('button', { name: '重试读取技能', exact: true }).click()
  await skillsPanel.getByRole('button', { name: '刷新技能', exact: true }).waitFor()
  await page.locator('.hermes-skills-popover').screenshot({ path: '.preview/skills-desktop.png' })
  const capturePlacement = async (path) => {
    await page.evaluate(() => { document.getElementById('root').style.visibility = 'hidden'; document.getElementById('hermes-feedback').style.visibility = 'hidden' })
    await page.screenshot({ path, clip: { x: 0, y: Math.max(0, page.viewportSize().height - 520), width: page.viewportSize().width, height: Math.min(520, page.viewportSize().height) } })
    await page.evaluate(() => { document.getElementById('root').style.visibility = ''; document.getElementById('hermes-feedback').style.visibility = '' })
  }
  await capturePlacement('.preview/skills-placement-desktop.png')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.locator('.hermes-skills-popover').screenshot({ path: '.preview/skills-dark.png' })
  await capturePlacement('.preview/skills-placement-dark.png')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(() => { const rect = document.querySelector('.hermes-skills-popover:popover-open')?.getBoundingClientRect(); return rect && rect.left >= 12 && rect.right <= innerWidth - 12 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.locator('.hermes-skills-popover').screenshot({ path: '.preview/skills-mobile.png' })
  await capturePlacement('.preview/skills-placement-mobile.png')
  await page.setViewportSize({ width: 1100, height: 1000 })
  let receiveHeldRequest
  const heldRequest = new Promise((resolve) => { receiveHeldRequest = resolve })
  let releaseHeldRequest, holding = false
  const hold = new Promise((resolve) => { releaseHeldRequest = resolve })
  await page.route('**/dsh-oh-my-hermes/skills?**', async (route) => {
    if (holding) return route.continue()
    holding = true
    receiveHeldRequest(route)
    await hold
  })
  await skillsPanel.getByRole('button', { name: '刷新技能', exact: true }).click()
  const heldRoute = await heldRequest
  await selectRoute(researcherModel)
  await page.getByRole('button', { name: '打开 researcher 技能', exact: true }).click()
  await page.getByRole('button', { name: '将 research-only 加入输入框', exact: true }).waitFor()
  await heldRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profile: 'coder', skills: [{ name: 'stale-coder', description: 'Old response' }] }) })
  releaseHeldRequest()
  await page.unroute('**/dsh-oh-my-hermes/skills?**')
  assert.equal(await page.getByRole('button', { name: '将 stale-coder 加入输入框', exact: true }).count(), 0, 'a late response cannot overwrite a new identity')
  assert.equal(await page.getByRole('button', { name: '将 debugging 加入输入框', exact: true }).count(), 0)
  await selectRoute('renamed')
  await page.getByRole('button', { name: '打开 default 技能', exact: true }).click()
  await page.getByText('此身份没有可用技能，请在远端检查技能安装及启用设置，然后刷新。').waitFor()
  await selectRoute('chat', 'deepseek')
  await page.waitForFunction(() => !document.querySelector('.hermes-skills'))
  await acknowledge('ui-chat', 'hermes-skills', { kind: 'success', text: 'coder · 可用技能 2 个' })
  await page.getByText('coder · 可用技能 2 个', { exact: true }).waitFor()
  // Unsaved edits, server validation, and recovery.
  await page.getByLabel('路由 id', { exact: true }).fill('../invalid')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('alert').waitFor()
  await page.getByRole('button', { name: '撤销未保存修改', exact: true }).click()
  await page.getByText('配置已保存', { exact: true }).waitFor()
  mkdirSync('.preview', { recursive: true })
  await acknowledge('ui-chat', 'hermes-profiles', { kind: 'success', text: '开发服务器已接入的 Hermes 身份：\ndefault → 默认模型\ncoder → coder · 默认模型\n创建、复制或接入其它身份：设置 → 远程 Hermes → Hermes 身份 / Profiles。' })
  await page.locator('.hermes-command-feedback').waitFor()
  await page.locator('.hermes-command-feedback').screenshot({ path: '.preview/command-result-desktop.png' })
  await page.screenshot({ path: '.preview/settings-desktop.png', fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.locator('.hermes-command-feedback').screenshot({ path: '.preview/command-result-dark.png' })
  await page.screenshot({ path: '.preview/settings-dark.png', fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.hermes-command-feedback').screenshot({ path: '.preview/command-result-mobile.png' })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile has no horizontal overflow')
  await page.screenshot({ path: '.preview/settings-mobile.png', fullPage: true })
  // Structured tool Markdown persists as ordinary text; only signed tool headers fold.
  const toolMarkdown = [
    '## 展示回归示例\n\n以下为工具事件生成的展示，正文保留 Markdown。',
    formatToolCall({ name: 'terminal', input: { command: 'printf "service status"\ncurl http://127.0.0.1:8000/health', description: '检查服务状态' } }),
    formatToolResult({ name: 'terminal', duration_ms: 2340, output: JSON.stringify({ output: 'API 200\n  database: healthy\n  cache: healthy', exit_code: 0 }) }),
    formatToolCall({ name: 'read_file', input: { path: '/srv/app/config.yaml' } }),
    formatToolResult({ name: 'read_file', is_error: true, output: 'Permission denied\nCheck file permissions' }),
    '## 检查结果\n\n| 服务 | 状态 |\n|---|---|\n| API | 200 |\n| 数据库 | healthy |\n\n- 日志换行保留\n- 工具详情默认收起\n\n普通引用：远端工具 · 完成，不应成为折叠按钮。\n\n~~~bash\necho normal_body\n~~~',
    formatToolResult({ name: 'terminal', output: '<script>window.__toolXss=true</script>\n' + '\x60'.repeat(3) + '\n# not a heading' }),
  ].join('\n\n')
  const renderedTools = renderMarkdown(toolMarkdown)
  await page.evaluate((html) => { document.getElementById('root').hidden=true;document.getElementById('hermes-feedback').hidden=true;document.querySelector('.fixture-composer').hidden=true;const area=document.getElementById('tool-fixture');area.hidden=false;area.innerHTML=html;window.scrollTo(0,0) }, renderedTools)
  const toolArea = page.locator('#tool-fixture')
  await page.waitForFunction(() => document.querySelectorAll('p[data-hermes-tool]').length === 5)
  const toolHeaders = toolArea.locator('p[data-hermes-tool]')
  assert.equal(await toolHeaders.count(), 5)
  for (const header of await toolHeaders.all()) {
    assert.equal(await header.getAttribute('aria-expanded'), 'false')
    assert.equal(await header.evaluate((el) => getComputedStyle(el.nextElementSibling).display), 'none')
  }
  assert.equal(await toolArea.getByText('普通引用：远端工具 · 完成，不应成为折叠按钮。', { exact: true }).getAttribute('role'), null)
  assert.equal(await toolArea.getByRole('table').count(), 1)
  assert.equal(await toolArea.getByRole('heading', { name: 'not a heading', exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => window.__toolXss === true), false)
  await toolHeaders.nth(0).focus()
  await toolHeaders.nth(0).press('Enter')
  assert.equal(await toolHeaders.nth(0).getAttribute('aria-expanded'), 'true')
  assert.equal(await toolHeaders.nth(0).evaluate((el) => getComputedStyle(el.nextElementSibling).display), 'block')
  await toolHeaders.nth(0).press(' ')
  assert.equal(await toolHeaders.nth(0).getAttribute('aria-expanded'), 'false')
  await toolHeaders.nth(1).click()
  assert.equal(await toolHeaders.nth(1).getAttribute('aria-expanded'), 'true')
  const output = await toolHeaders.nth(1).evaluate((el) => el.nextElementSibling.textContent)
  assert.ok(output.includes('API 200\n  database: healthy\n  cache: healthy'))
  assert.equal(await toolHeaders.nth(3).getAttribute('data-hermes-tool-failed'), '')
  await page.setViewportSize({ width: 1100, height: 1000 })
  await toolArea.screenshot({ path: '.preview/tool-display-desktop.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await toolArea.screenshot({ path: '.preview/tool-display-dark.png' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await toolArea.screenshot({ path: '.preview/tool-display-mobile.png' })
  // History remount: metadata survives storage; default folding is reconstructed.
  await page.evaluate((html) => { document.getElementById('tool-fixture').innerHTML=html }, renderedTools)
  await page.waitForFunction(() => document.querySelectorAll('p[data-hermes-tool="closed"]').length === 5)
  // A streamed header is not interactive until its matching code block exists.
  const partialHtml = renderMarkdown(formatToolCall({ name: 'terminal', input: { command: 'echo partial' } }))
  await page.evaluate((html) => { const area=document.getElementById('tool-fixture');area.innerHTML=html;area.querySelector('.md-code-block').remove() }, partialHtml)
  assert.equal(await toolArea.locator('[data-hermes-tool]').count(), 0)
  await page.evaluate((html) => {document.getElementById('tool-fixture').innerHTML=html}, partialHtml)
  await toolArea.locator('[data-hermes-tool="closed"]').waitFor()
  // Reading layout applies only while a Hermes model is selected, to assistant content.
  await page.setViewportSize({ width: 1100, height: 1000 })
  const readingMarkdown = [
    '## 服务检查结果\n\n项目已在运行，服务检查完成。下面是本次检查的结果和访问方式。',
    '前端服务、后端接口、数据库、缓存和后台任务均已检查。访问前请建立本地连接，然后打开浏览器。这里保留一段较长的普通正文，用于验证没有 Markdown 列表时的字体、行宽与段落间距。优化只改变阅读样式，原始文字与标点保持不变。',
    '### 服务状态\n\n| 服务 | 地址 | 状态 |\n|---|---|---|\n| 前端 | \x60http://localhost:5173\x60 | 正常 |\n| API | \x60http://localhost:8000/health\x60 | 200 |\n| 数据库 | \x60127.0.0.1:5432\x60 | healthy |',
    '### 访问步骤\n\n1. 在终端建立 SSH 隧道。\n2. 在浏览器打开本地地址。\n3. 使用自己的账户登录。',
    '~~~bash\nssh -N -L 5173:127.0.0.1:5173 user@example.test\nprintf "line 1\\n  line 2\\n"\n~~~',
    '配置路径为 \x60/srv/example/config.yaml\x60。更长的路径也应在窄屏中保持可读：\x60/srv/example/projects/long-project-name/configuration/development/settings.yaml\x60。',
    '> 补充说明：已经运行的服务无需重复启动。',
    formatToolResult({ name: 'terminal', duration_ms: 2340, output: 'API 200\n  database: healthy\n  cache: healthy' }),
  ].join('\n\n').replaceAll('\x60', String.fromCharCode(96))
  await page.addStyleTag({ content: '.fixture_markdown{font-family:"Times New Roman",serif}' })
  await page.evaluate((html) => { document.getElementById('tool-fixture').innerHTML=html;document.getElementById('reading-user').hidden=false;window.scrollTo(0,0) }, renderMarkdown(readingMarkdown))
  const prose = toolArea.locator('p').nth(1)
  const originalText = await prose.textContent()
  const originalFont = await prose.evaluate((el) => getComputedStyle(el).fontFamily)
  assert.match(originalFont, /Times New Roman/)
  const readingCommand = await toolArea.locator('pre code').first().textContent()
  await selectRoute(coderModel)
  await page.waitForFunction(() => document.body.hasAttribute('data-hermes-reading'))
  const appearance = await prose.evaluate((el) => { const s=getComputedStyle(el),root=el.closest('[class*="_markdown"]');return {font:s.fontFamily,line:parseFloat(s.lineHeight),fontSize:parseFloat(s.fontSize),margin:parseFloat(s.marginBottom),width:root.getBoundingClientRect().width} })
  assert.match(appearance.font, /Segoe UI/)
  assert.ok(appearance.line >= appearance.fontSize * 1.8)
  assert.ok(appearance.margin >= appearance.fontSize * .9)
  assert.ok(appearance.width > 900, 'assistant Markdown fills the existing host column instead of a second 84ch cap')
  assert.equal(await prose.textContent(), originalText)
  assert.equal(await toolArea.locator('pre code').first().textContent(), readingCommand)
  assert.equal(await page.locator('#reading-user p').evaluate((el) => getComputedStyle(el).fontFamily), originalFont)
  await toolArea.locator('p[data-hermes-tool]').waitFor()
  await toolArea.locator('p[data-hermes-tool]').click()
  // Reproduce the installed host's column/composer tokens, including its ResizeObserver
  // input and wide-table rules. Check container resizing without changing the viewport.
  await page.addStyleTag({ content: `
    main{max-width:none!important;padding:0!important}
    .fixture-host-frame{width:calc(100% - var(--fixture-side,0px));margin-inline:auto;min-width:0;container-type:inline-size;--dsh-chat-content-width:var(--dsh-chat-user-width,clamp(680px,calc(var(--dsh-conversation-column-width,0px) * .64),920px));--dsh-composer-card-max-width:calc(var(--dsh-chat-content-width) + 32px);--dsh-composer-side-clearance:16px;--dsh-composer-dock-inset:8px}
    .fixture-host-scroll{padding:16px 32px;min-width:0;container-type:inline-size}
    .fixture-host-column{max-width:var(--dsh-chat-content-width);width:100%;margin:0 auto;display:flex;flex-direction:column;min-width:0}
    .fixture-host-column .md-table-wide{--dsh-table-spare:max(0px,calc((100cqw - var(--dsh-chat-content-width)) / 2));--dsh-table-lead:calc(var(--dsh-table-spare) + min(var(--dsh-chat-content-width),100cqw) - 100%);box-sizing:border-box;width:calc(100% + var(--dsh-table-lead) + var(--dsh-table-spare));max-width:none;margin-left:calc(-1 * var(--dsh-table-lead));padding-left:var(--dsh-table-lead)}
    .fixture-host-card{box-sizing:border-box;width:calc(100% - 32px);max-width:var(--dsh-composer-card-max-width);margin:12px auto;padding:16px;border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:24px;background:var(--dsw-alias-bg-base,#fff);font:14px system-ui;color:var(--dsw-alias-label-secondary,#626972)}
    .fixture-host-card p{margin:0 0 36px}.fixture-host-card-footer{display:flex;justify-content:space-between;gap:12px}
    @media(prefers-color-scheme:dark){.fixture-host-card{--dsw-alias-bg-base:#191b1f}}
  ` })
  await page.evaluate(() => {
    const frame=document.createElement('div');frame.className='fixture-host-frame';frame.innerHTML='<div class="fixture-host-scroll"><div class="fixture-host-column"></div></div><div class="fixture-host-dock"></div><div class="fixture-host-card"><p>发消息或创建任务，调用指令，@ 文件或对话</p><div class="fixture-host-card-footer"><span>＋ 工作区内修改 · 技能</span><span>coder · 默认模型</span></div></div>'
    const flow=document.getElementById('reading-flow');flow.before(frame);frame.querySelector('.fixture-host-column').append(flow)
    const feedback=document.getElementById('hermes-feedback');frame.querySelector('.fixture-host-dock').append(feedback);feedback.hidden=false
    const table=flow.querySelector('table'),wide=document.createElement('div');wide.className='md-table-wide';table.before(wide);wide.append(table)
    window.__readingHostObserver=new ResizeObserver(([entry])=>frame.style.setProperty('--dsh-conversation-column-width',entry.contentRect.width+'px'));window.__readingHostObserver.observe(frame)
    const code=flow.querySelector('pre code');code.textContent+='\n'+('very_long_shell_argument_'.repeat(25))
  })
  const hostFrame = page.locator('.fixture-host-frame')
  const assertHostLayout = async () => {
    await page.waitForFunction(() => {const frame=document.querySelector('.fixture-host-frame');return Math.abs(parseFloat(frame.style.getPropertyValue('--dsh-conversation-column-width'))-frame.getBoundingClientRect().width)<1})
    const dimensions = await page.evaluate(() => {
      const frame=document.querySelector('.fixture-host-frame').getBoundingClientRect(),column=document.querySelector('.fixture-host-column').getBoundingClientRect(),text=document.getElementById('tool-fixture').getBoundingClientRect(),card=document.querySelector('.fixture-host-card').getBoundingClientRect(),feedback=document.querySelector('.hermes-command-feedback').getBoundingClientRect(),pre=document.querySelector('#tool-fixture pre')
      const table=document.querySelector('#tool-fixture table')
      return {frame:frame.width,column:column.width,text:text.width,textLeft:text.x,card:card.width,cardLeft:card.x,feedback:feedback.width,feedbackCenter:feedback.x+feedback.width/2,center:frame.x+frame.width/2,bodyOverflow:document.documentElement.scrollWidth>innerWidth,codeScrollable:pre.scrollWidth>pre.clientWidth,tableScrollable:table.scrollWidth>table.clientWidth,wideWidth:document.querySelector('.md-table-wide').getBoundingClientRect().width,wideMargin:getComputedStyle(document.querySelector('.md-table-wide')).marginLeft}
    })
    assert.ok(Math.abs(dimensions.text-dimensions.column)<1, 'assistant content follows the native column width')
    assert.ok(Math.abs(dimensions.card-(dimensions.column+32))<1, 'composer and chat keep the native 16px inset on each side')
    assert.ok(Math.abs(dimensions.textLeft-dimensions.cardLeft-16)<1)
    assert.ok(Math.abs(dimensions.feedbackCenter-dimensions.center)<1, 'command dock is centered on the host composer')
    assert.ok(Math.abs(dimensions.feedback-(dimensions.column+16))<1, 'command dock uses host width tokens')
    assert.equal(dimensions.bodyOverflow,false)
    assert.equal(dimensions.codeScrollable,true, 'long code scrolls inside the code block')
    if(dimensions.frame<400) assert.equal(dimensions.tableScrollable,true, 'narrow tables scroll without squeezing their labels')
    return dimensions
  }
  const widths=[]
  for (const width of [1920,1366,900,390]) {
    await page.setViewportSize({width,height:1000})
    const metrics=await assertHostLayout();widths.push(metrics.text)
    if(width===1920){assert.ok(metrics.text>900);assert.ok(metrics.wideWidth>metrics.text+200,'host wide-table breakout remains available');assert.ok(parseFloat(metrics.wideMargin)<0)}
  }
  assert.ok(widths[0]>widths[1]&&widths[1]>widths[2]&&widths[2]>widths[3], 'window changes produce different content widths')
  await page.setViewportSize({width:1920,height:1000})
  await hostFrame.evaluate(el=>el.style.setProperty('--dsh-chat-user-width','1120px'))
  const customWidth=await assertHostLayout();assert.ok(Math.abs(customWidth.text-1120)<1,'native user width preference is respected')
  await hostFrame.evaluate(el=>el.style.removeProperty('--dsh-chat-user-width'))
  const wideWindow=await assertHostLayout()
  await hostFrame.evaluate(el=>el.style.setProperty('--fixture-side','720px'))
  const withSidebar=await assertHostLayout();assert.ok(withSidebar.text<wideWindow.text-100,'opening a side panel shrinks content without changing the viewport')
  await hostFrame.evaluate(el=>el.style.setProperty('--fixture-side','1530px'))
  const embeddedNarrow=await assertHostLayout();assert.ok(embeddedNarrow.text<350,'narrow embedded pane works inside a wide window')
  await hostFrame.screenshot({path:'.preview/reading-embedded-narrow.png'})
  await hostFrame.evaluate(el=>el.style.removeProperty('--fixture-side'))
  await page.setViewportSize({width:1366,height:1000});await assertHostLayout()
  await page.locator('#hermes-feedback').evaluate(el=>el.hidden=true)
  await hostFrame.screenshot({path:'.preview/reading-responsive-desktop.png'})
  await toolArea.screenshot({ path: '.preview/reading-desktop.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await toolArea.screenshot({ path: '.preview/reading-dark.png' })
  await hostFrame.screenshot({path:'.preview/reading-responsive-dark.png'})
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'reading layout has no narrow-screen overflow')
  await toolArea.screenshot({ path: '.preview/reading-mobile.png' })
  await hostFrame.screenshot({path:'.preview/reading-responsive-mobile.png'})
  await page.evaluate(()=>window.__readingHostObserver.disconnect())
  await selectRoute('chat', 'deepseek')
  await page.waitForFunction(() => !document.body.hasAttribute('data-hermes-reading'))
  assert.equal(await prose.evaluate((el) => getComputedStyle(el).fontFamily), originalFont)
  assert.equal(await prose.textContent(), originalText, 'provider changes never rewrite message text')
  await page.evaluate(() => { for(const stop of window.__hermesDisposers)stop() })
  assert.equal(await page.locator('style[data-hermes-reading-style]').count(), 0)
  assert.equal(await page.evaluate(() => document.body.hasAttribute('data-hermes-reading')), false)
  assert.equal(await toolArea.locator('[data-hermes-tool]').count(), 0, 'unload removes folding and reveals original Markdown')
  assert.deepEqual(errors, [])
  console.log('Browser checks passed: native responsive column/composer alignment at 1920/1366/900/390px, custom host width, sidebar and embedded-pane resizing, wide tables and contained code/table scrolling; scoped reading, provider isolation, tool folding, skill/profile flows and light/dark rendering.')
  console.log(resolve('.preview/settings-desktop.png'))
} catch (error) {
  await page?.screenshot({ path: '.preview/ui-failure.png', fullPage: true })
  throw error
} finally {
  await browser.close(); dispose?.(); await new Promise((done) => server.close(done))
}
