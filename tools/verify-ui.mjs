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
.fixture-composer{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);width:min(900px,calc(100% - 32px));background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,#e6e8eb);border-radius:24px;padding:14px 16px;box-shadow:0 4px 24px rgba(0,0,0,.05)}.fixture-draft{height:58px;color:#8b919b;font-size:15px}.fixture-controls{display:flex;align-items:center;gap:10px;min-width:0}.fixture-mode{font-size:13px;color:#626972;white-space:nowrap}.fixture-model{margin-left:auto;font-size:12px;color:#626972}@media(max-width:500px){.fixture-model{display:none}}main{padding-bottom:180px}.fixture_markdown{font-size:15px;line-height:1.7;min-width:0}.fixture_markdown .md-code-block{background:var(--dsw-alias-bg-layer-1,#f1f3f5);border-radius:8px;padding:12px;max-width:100%;overflow:auto}.fixture_markdown pre{margin:0;white-space:pre;font-size:12px}.fixture_markdown table{border-collapse:collapse;width:100%}.fixture_markdown th,.fixture_markdown td{border-bottom:1px solid var(--dsw-alias-border-l2,#ddd);padding:6px;text-align:left}</style><main><article id="tool-fixture" class="fixture_markdown" hidden></article><div id="hermes-feedback"></div><div id="root"></div></main><div class="fixture-composer"><div class="fixture-draft">发消息或创建任务，调用指令，@ 文件或对话</div><div class="fixture-controls"><span class="fixture-mode">＋</span><span class="fixture-mode">工作区内修改</span><div id="hermes-toolbar"></div><span class="fixture-model">coder · deepseek-v4.1-flash-1017</span></div></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>window.__ModuleLoader__={load(spec){const plugin=spec.factory(id=>{if(id==='react')return React;throw Error(id)});window.__hermesEvents={};window.__hermesRoute={provider:'deepseek',model:'chat'};window.__hermesSubscribers=new Set();window.__hermesDraft='已有任务';window.__selectHermesRoute=(route)=>{window.__hermesRoute=route;for(const fn of window.__hermesSubscribers)fn()};window.__hermesDisposers=[];plugin.apply({effect(fn){const stop=fn();if(typeof stop==='function')window.__hermesDisposers.push(stop)},modelDirectories:{directoryFor(){return {store:{getSnapshot:()=>({current:window.__hermesRoute}),subscribe(fn){window.__hermesSubscribers.add(fn);return ()=>window.__hermesSubscribers.delete(fn)}}}}},on(name,fn){(window.__hermesEvents[name]??=[]).push(fn)},slots:{inject(_,fn){fn()},register(spec,Component){const dock=spec.name==='conversation.input.dock';const toolbar=spec.name==='conversation.input.left';const root=ReactDOM.createRoot(document.getElementById(toolbar?'hermes-toolbar':dock?'hermes-feedback':'root'));if(dock||toolbar){window.__hermesRoots??=[];window.__hermesRoots.push({root,Component});window.__renderHermesDock=(sessionId)=>{window.__dockSession=sessionId;for(const {root,Component}of window.__hermesRoots)root.render(React.createElement(Component,{sessionId,useInput:selector=>selector({draft:window.__hermesDraft}),inputActions:{setDraft(value){window.__hermesDraft=value;window.__renderHermesDock(window.__dockSession)}}}))};window.__renderHermesDock('ui-chat')}else root.render(React.createElement(Component,{}))}}})}};</script><script src="/client.js"></script></html>`
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
  await page.evaluate(() => { for(const stop of window.__hermesDisposers)stop() })
  assert.equal(await toolArea.locator('[data-hermes-tool]').count(), 0, 'unload removes folding and reveals original Markdown')
  assert.deepEqual(errors, [])
  console.log('Browser checks passed: tool Markdown folding, keyboard, whitespace, prose isolation, history remount and cleanup; live profile skill catalog, search, draft insertion, stale response isolation, empty/error/retry, profile/model dropdowns, stable route ids, command feedback, profile creation, and desktop/mobile/dark rendering.')
  console.log(resolve('.preview/settings-desktop.png'))
} catch (error) {
  await page?.screenshot({ path: '.preview/ui-failure.png', fullPage: true })
  throw error
} finally {
  await browser.close(); dispose?.(); await new Promise((done) => server.close(done))
}
