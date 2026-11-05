// Persist ordinary Markdown in DSH's text lane. No tool-call blocks: Hermes already ran it.
// The client only folds paragraphs carrying this exact marker next to a code block.
export const TOOL_MARK = '远端工具\u2060 · '
const LABELS = { terminal: '运行命令', read_file: '读取文件', write_file: '写入文件', patch: '修改文件', search_files: '搜索文件', skill_view: '加载技能', skills_list: '查看技能', web_search: '搜索网页', web_extract: '读取网页' }
const short = (value, max = 80) => {
  const text = String(value ?? '').replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}
const escape = (value) => short(value).replace(/[\\`*_{}\[\]()<>#!|~]/g, '\\$&')

export function capToolBody(value, maxChars = 2000, maxLines = 18) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const lines = text.split('\n')
  let body = lines.slice(0, maxLines).join('\n')
  const notes = []
  if (lines.length > maxLines) notes.push(`另有 ${lines.length - maxLines} 行未显示`)
  if (body.length > maxChars) { body = body.slice(0, maxChars); notes.push('内容已截断') }
  return `${body}${notes.length ? `\n…（${notes.join('；')}）` : ''}`
}

function fence(body, lang) {
  let ticks = '```'
  while (body.includes(ticks)) ticks += '`'
  return `${ticks}${lang}\n${body}\n${ticks}`
}
const language = (name, input) => name === 'terminal' ? 'bash' : /\.(js|ts|tsx|jsx|py|json|yaml|yml|css|html|sh|sql|md)$/i.exec(input?.path || input?.file_path || '')?.[1]?.toLowerCase() || ''
function packet(title, body, lang) { return `\n\n${TOOL_MARK}${title}\n\n${fence(body, lang)}\n\n` }

export function formatToolCall(frame, { limit = 2000, redact = (s) => s } = {}) {
  const name = typeof frame.name === 'string' ? frame.name : 'tool'
  const input = frame.input && typeof frame.input === 'object' ? frame.input : {}
  const summary = input.description || input.command || input.file_path || input.path || input.skill || input.name || input.query || input.url
  const title = `执行 · ${escape(LABELS[name] || name)}${summary ? ` · ${escape(redact(String(summary)))}` : ''}`
  const command = typeof input.command === 'string' ? input.command : undefined
  // Keep full command newlines in the body; only the clickable summary is flattened.
  const rest = { ...input }; if (command !== undefined) delete rest.command
  const body = command !== undefined ? command + (Object.keys(rest).length ? `\n\n参数：\n${JSON.stringify(rest, null, 2)}` : '') : JSON.stringify(input, null, 2)
  return packet(title, capToolBody(redact(body), limit), command !== undefined ? 'bash' : 'json')
}

export function formatToolResult(frame, { limit = 2000, redact = (s) => s } = {}) {
  const name = typeof frame.name === 'string' ? frame.name : 'tool'
  const raw = typeof frame.output === 'string' ? frame.output : JSON.stringify(frame.output ?? '')
  let body = raw, failed = frame.is_error === true
  try {
    const data = JSON.parse(raw)
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const output = typeof data.output === 'string' ? data.output : typeof data.text === 'string' ? data.text : undefined
      const error = typeof data.error === 'string' && data.error ? data.error : undefined
      if (output !== undefined || error || typeof data.exit_code === 'number') {
        body = [output, error && error !== output ? error : undefined].filter((v) => v !== undefined && v !== '').join('\n')
        failed ||= Boolean(error) || (typeof data.exit_code === 'number' && data.exit_code !== 0)
      }
    }
  } catch {}
  const ms = Number(frame.duration_ms)
  const time = Number.isFinite(ms) && ms > 0 ? ` · ${(ms / 1000).toFixed(1)} 秒` : ''
  return packet(`${failed ? '失败' : '完成'} · ${escape(LABELS[name] || name)}${time}`, capToolBody(redact(body.trim() || '(无输出)'), limit), language(name, {}))
}
