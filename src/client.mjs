/**
 * 最小 OpenAI 兼容客户端。
 *
 * 只依赖内置 fetch，不引第三方包 —— 这个工具的读者需要能一眼看懂它到底发了什么，
 * 任何隐藏的 SDK 行为都会破坏「我在测别人有没有隐藏行为」这件事的可信度。
 *
 * 同时支持 stream / 非流式：很多中转只实现了其中一种，探针必须两种都能读。
 *
 * @module client
 */

/**
 * @typedef {object} ProbeConfig
 * @property {string} baseUrl   例如 https://api.example.com/v1（末尾斜杠会被去掉）
 * @property {string} apiKey
 * @property {string} model
 * @property {Record<string,string>} [headers] 额外请求头
 * @property {number} [timeoutMs]
 * @property {number} [maxTokens]
 * @property {typeof fetch} [fetchImpl] 测试注入用
 */

/**
 * @typedef {object} Usage
 * @property {number|null} promptTokens
 * @property {number|null} completionTokens
 * @property {number|null} cacheReadTokens
 * @property {number|null} cacheWriteTokens
 * @property {object|null} raw  上游原始 usage 对象（用于展示它到底回了什么字段）
 */

const DEFAULT_TIMEOUT = 90_000

export class ProbeClient {
  /** @param {ProbeConfig} config */
  constructor(config) {
    if (!config?.baseUrl) throw new Error('baseUrl 必填')
    if (!config?.model) throw new Error('model 必填')
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey ?? ''
    this.model = config.model
    this.extraHeaders = config.headers ?? {}
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT
    this.maxTokens = config.maxTokens ?? 8
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
    if (typeof this.fetchImpl !== 'function') throw new Error('当前环境没有 fetch，需要 Node >= 18')
    this.requestCount = 0
  }

  /** @returns {Promise<{text:string, usage:Usage, finishReason:string|null}>} */
  async chat(messages, { maxTokens, temperature = 0, stream = true } = {}) {
    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens ?? this.maxTokens,
      temperature,
      stream,
    }
    const headers = {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...(stream ? { Accept: 'text/event-stream' } : {}),
      ...this.extraHeaders,
    }

    this.requestCount += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    let res
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      if (err?.name === 'AbortError') throw new Error(`请求超时（${this.timeoutMs}ms）`)
      throw err
    }

    if (!res.ok) {
      clearTimeout(timer)
      const detail = await res.text().catch(() => '')
      const err = new Error(`HTTP ${res.status}: ${detail.slice(0, 300)}`)
      /** @type {any} */ (err).status = res.status
      throw err
    }

    try {
      return stream ? await readStream(res, this.timeoutMs) : await readJson(res)
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 非流式：一次性 JSON。 */
async function readJson(res) {
  const data = await res.json()
  const choice = data.choices?.[0]
  return {
    text: choice?.message?.content ?? '',
    usage: normalizeUsage(data.usage),
    finishReason: choice?.finish_reason ?? null,
  }
}

/** 流式：读 SSE，累积正文与 usage。 */
async function readStream(res, timeoutMs) {
  if (!res.body) throw new Error('响应没有 body，无法读流')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let text = ''
  let usage = null
  let finishReason = null
  const deadline = Date.now() + timeoutMs

  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        let obj
        try {
          obj = JSON.parse(payload)
        } catch {
          continue
        }
        const delta = obj.choices?.[0]?.delta?.content
        if (typeof delta === 'string') text += delta
        if (obj.choices?.[0]?.finish_reason) finishReason = obj.choices[0].finish_reason
        // usage 可能挂在顶层（含 include_usage 时）或作为独立事件
        if (obj.usage) usage = obj.usage
      }

      // 拿到 usage 后即可停止：不再无谓等待
      if (usage) break
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* 取消失败不影响结果 */
    }
  }

  return { text, usage: normalizeUsage(usage), finishReason }
}

/**
 * 把各家五花八门的 usage 字段归一。
 *
 * OpenAI / DeepSeek / 腾讯 / 字节 各有各的写法，探针只关心三件事：
 * 输入多少 token、命中多少缓存、新建多少缓存。
 *
 * @param {object|null|undefined} raw
 * @returns {Usage}
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') {
    return { promptTokens: null, completionTokens: null, cacheReadTokens: null, cacheWriteTokens: null, raw: raw ?? null }
  }

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  const promptRaw = num(raw.prompt_tokens) ?? num(raw.input_tokens) ?? num(raw.promptTokens)
  const completion = num(raw.completion_tokens) ?? num(raw.output_tokens) ?? num(raw.completionTokens)

  // 缓存命中：OpenAI 是 prompt_tokens_details.cached_tokens，
  // DeepSeek 是 prompt_cache_hit_tokens，Anthropic 风格是 cache_read_input_tokens。
  const cacheRead =
    num(raw.prompt_tokens_details?.cached_tokens) ??
    num(raw.cached_tokens) ??
    num(raw.prompt_cache_hit_tokens) ??
    num(raw.cache_read_input_tokens) ??
    num(raw.cache_read_tokens) ??
    null

  const cacheWrite =
    num(raw.prompt_cache_miss_tokens) ??
    num(raw.cache_creation_input_tokens) ??
    num(raw.cache_write_tokens) ??
    null

  // 有的实现把「命中」包含在 prompt_tokens 里，有的分开。这里保留原值，
  // 由调用方决定要不要相减 —— 探针只报告，不猜。
  return {
    promptTokens: promptRaw,
    completionTokens: completion,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    raw,
  }
}

/** 便于脚本化：线性回归。 @param {{x:number,y:number}[]} pts */
export function linearRegression(pts) {
  const n = pts.length
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN, n }
  const sx = pts.reduce((s, p) => s + p.x, 0)
  const sy = pts.reduce((s, p) => s + p.y, 0)
  const sxx = pts.reduce((s, p) => s + p.x * p.x, 0)
  const sxy = pts.reduce((s, p) => s + p.x * p.y, 0)
  const den = n * sxx - sx * sx
  if (den === 0) return { slope: NaN, intercept: NaN, r2: NaN, n }
  const slope = (n * sxy - sx * sy) / den
  const intercept = (sy - slope * sx) / n

  const meanY = sy / n
  const ssTot = pts.reduce((s, p) => s + (p.y - meanY) ** 2, 0)
  const ssRes = pts.reduce((s, p) => s + (p.y - (slope * p.x + intercept)) ** 2, 0)
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot

  return { slope, intercept, r2, n }
}
