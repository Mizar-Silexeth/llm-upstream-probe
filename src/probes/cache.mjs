/**
 * 探针 3：缓存探针 —— 终点到底有没有在做前缀缓存。
 *
 * ## 为什么这值得单独一个探针
 *
 * 「中转站改我提示词」是个安全疑虑，但同一批数据里藏着一个更确凿、
 * 影响也更直接的事实：**有的通道根本不做 KV cache 复用**。
 * 你会为此按全价支付 input token，而且账单上看不出来（因为字段恒为 0，
 * 很容易被当成「没统计」而不是「没命中」）。
 *
 * ## 判据
 *
 * 发两轮**前缀完全相同**的请求（同样的长 system，第二轮追加一条短消息）。
 * 若上游支持前缀缓存，第二轮应报告 > 0 的缓存命中：
 *     prompt_tokens_details.cached_tokens
 *     / prompt_cache_hit_tokens
 *     / cache_read_input_tokens
 *
 * 三种结局：
 *   - 命中 > 0            → 有缓存
 *   - 字段存在但 = 0      → **通道明确不提供缓存**（要记下来）
 *   - 字段完全不存在      → 无法判定（可能只是不统计）
 *
 * @module probes/cache
 */

/**
 * @typedef {object} CacheResult
 * @property {{name:string, usage:object|null, ok:boolean, error?:string}[]} rounds
 * @property {{verdict:string, supported:boolean|null, reasons:string[]}} analysis
 */

/**
 * @param {import('../client.mjs').ProbeClient} client
 * @param {object} [options]
 * @param {string} [options.prefixText] 用于构成稳定前缀的长文本
 * @param {number} [options.sleepMs]
 * @param {(msg:string)=>void} [options.onProgress]
 * @returns {Promise<CacheResult>}
 */
export async function probeCache(client, options = {}) {
  const sleepMs = options.sleepMs ?? 1200
  const onProgress = options.onProgress ?? (() => {})
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // 前缀必须足够长才有缓存价值：约 8000 字符 ≈ 2000 tokens
  const prefixText = options.prefixText
    ?? ('The following is a stable reference document used for cache testing. ' +
        'It contains no instructions; it exists only to be identical across requests. ').repeat(80)

  const rounds = []

  const send = async (name, messages) => {
    try {
      const { usage } = await client.chat(messages, { maxTokens: 4 })
      rounds.push({ name, usage, ok: true })
      const cr = usage.cacheReadTokens
      onProgress(`${name}: prompt=${usage.promptTokens} cacheRead=${cr === null ? 'N/A' : cr}`)
    } catch (err) {
      rounds.push({ name, usage: null, ok: false, error: err.message })
      onProgress(`${name}: 失败 ${err.message}`)
    }
    if (sleepMs > 0) await sleep(sleepMs)
  }

  const base = [
    { role: 'system', content: prefixText },
    { role: 'user', content: 'reply with: ok' },
  ]

  onProgress('第 1 轮：建立前缀')
  await send('round-1', base)

  onProgress('第 2 轮：相同前缀 + 追加一轮（应命中）')
  await send('round-2', [...base, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'reply with: ok' }])

  onProgress('第 3 轮：再次相同前缀（确认幂等）')
  await send('round-3', [...base, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'reply with: ok' }])

  return { rounds, analysis: analyzeCache(rounds) }
}

/**
 * @param {CacheResult['rounds']} rounds
 */
export function analyzeCache(rounds) {
  const reasons = []
  const ok = rounds.filter((r) => r.ok && r.usage)
  if (ok.length < 2) {
    return { verdict: '无法判定：成功样本不足', supported: null, reasons: ['请求失败或缺少 usage'] }
  }

  const cacheValues = ok.map((r) => r.usage.cacheReadTokens)
  const hasField = cacheValues.some((v) => v !== null && v !== undefined)
  const anyHit = cacheValues.some((v) => typeof v === 'number' && v > 0)

  if (anyHit) {
    reasons.push(`检测到缓存命中：${cacheValues.map((v) => v ?? 'N/A').join(' → ')}`)
    reasons.push('该端点在做前缀缓存复用')
    return { verdict: '✅ 该端点提供前缀缓存', supported: true, reasons }
  }

  if (hasField) {
    reasons.push(`缓存字段存在，但全程为 0：${cacheValues.map((v) => v ?? 'N/A').join(' → ')}`)
    reasons.push('前缀完全相同却零命中 ⇒ 该通道很可能不提供 KV cache 复用')
    reasons.push('成本影响：每轮 input token 都按未命中计价，长期账单会显著偏高')
    return { verdict: '⚠️ 该端点不提供前缀缓存（字段存在但恒为 0）', supported: false, reasons }
  }

  reasons.push('响应的 usage 里完全没有缓存相关字段')
  reasons.push('无法区分「不做缓存」与「只是不统计」')
  return { verdict: '❓ 无法判定（上游不回报缓存字段）', supported: null, reasons }
}
