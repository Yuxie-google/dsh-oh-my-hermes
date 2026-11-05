/** Mask credentials in displayed tool activity and diagnostics, never in the prompt. */
export function buildRedactor(env = {}) {
  const secrets = Object.entries(env)
    .filter(([key, value]) => /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(_|$)/i.test(key) && typeof value === 'string' && value.length >= 8)
    .sort((a, b) => b[1].length - a[1].length)
  return (value) => {
    let text = String(value ?? '')
    for (const [key, secret] of secrets) text = text.split(secret).join(`[redacted:${key}]`)
    return text
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, '$1[redacted]')
      .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1"[redacted]"')
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
  }
}
