/**
 * 假上游：模拟几种真实的「加料 vs 不加料」行为。
 *
 * 这个文件是整个工具信誉的基石 —— 一个只会说「没问题」的检测器毫无价值。
 * 所以先造一个**确定会加料**的假上游，证明探针能抓到它。
 *
 * 用最简单的 token 估算（英文 4 字符/token、中文 1 字 0.6 token），
 * 精度不需要高，因为探针比较的是**相对变化**。
 *
 * @module test/fake-upstream
 */

/** 字符数 → token 数（粗估，够用） */
export function estimateTokens(text) {
  if (!text) return 0
  let tokens = 0
  for (const ch of text) {
    // CJK 统一表意文字范围：1 字约 0.6 token
    tokens += /[\u4e00-\u9fff]/.test(ch) ? 0.6 : 0.25
  }
  return Math.ceil(tokens)
}

/**
 * 创建一个假上游的 fetch 实现。
 *
 * @param {object} behavior
 * @param {string} [behavior.injectedSystem] 若设置，则模拟上游**偷偷加**的系统提示词
 * @param {boolean} [behavior.truncateSystem] 若 true，模拟上游截断 system
 * @param {boolean} [behavior.reportCache] 若 true，usage 里带上缓存字段
 * @param {number} [behavior.cacheHitTokens] 缓存命中 token 数
 * @param {boolean} [behavior.obeySystemRules] 是否服从 system 里的格式规则
 * @param {number} [behavior.extraBloat] 额外固定的 prompt token（模拟固定前缀）
 */
export function makeFakeUpstream(behavior = {}) {
  const calls = []

  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body, headers: init.headers })

    // 模拟上游在服务端偷偷拼接的那一段
    const injected = behavior.injectedSystem ?? ''
    const systemMsg = body.messages?.find((m) => m.role === 'system')
    let systemText = systemMsg?.content ?? ''
    if (behavior.truncateSystem) systemText = systemText.slice(0, Math.floor(systemText.length / 2))

    // ⚠️ 关键：token 计数必须用「上游真正看到的那份 messages」。
    // 早期版本这里用的是原始 body.messages，于是截断只改了 systemText 却
    // 没改计数，token 照样按全长度算 —— 测试因此假绿。（这条是测试自己抓出来的）
    const seenMessages = body.messages.map((m) =>
      m.role === 'system' ? { ...m, content: systemText } : m,
    )
    const allText =
      seenMessages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n') +
      (injected ? '\n' + injected : '')

    let promptTokens = estimateTokens(allText) + (behavior.extraBloat ?? 0)
    // 保证基线不为 0
    promptTokens = Math.max(promptTokens, 8)

    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: 2,
      total_tokens: promptTokens + 2,
    }
    if (behavior.reportCache) {
      usage.prompt_tokens_details = { cached_tokens: behavior.cacheHitTokens ?? 0 }
    }

    // 决定回复内容。这里模拟一个「行为良好的模型」：
    //   ① 若 system 给了格式规则（####）且它愿意服从 → 加上标记
    //   ② 若问题在问标识符且 system 里有 → 复述它
    const askedForMark = /####/.test(systemText)
    const obey = behavior.obeySystemRules ?? true
    const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const asksForId = /标识符|identifier|哪个/i.test(String(lastUser))
    const canaryMatch = /CANARY-[A-Z0-9-]+/i.exec(systemText)

    let content = 'ok'
    if (asksForId && canaryMatch) {
      content = canaryMatch[0]
    } else if (/1\+1/.test(String(lastUser))) {
      content = '2'
    }
    if (askedForMark && obey) content = '####' + content

    if (body.stream === false) {
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage,
      })
    }

    // 流式：先发一个 delta，再发 usage
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
      'data: [DONE]\n\n',
    ].join('')
    return sseResponse(chunks)
  }

  return { fetchImpl, calls }
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sseResponse(text) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}
