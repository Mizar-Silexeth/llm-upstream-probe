/**
 * 探针 2：暗号法 —— 判断上游有没有把你的 system 换掉或藏东西。
 *
 * ## 为什么需要第二个探针
 *
 * token 差分只能证明「数量对得上」。理论上存在一种规避：
 * 上游把你的 system 丢掉，再塞一段等长的自己的内容，总量刚好抵消。
 * 暗号法直接看**内容**，堵住这个口子。
 *
 * ## 三个动作，各回答一个问题
 *
 * 1. **中性复述**：system 里放一个无意义暗号，问「刚才那条消息里的标识符是什么」。
 *    - 答对 → system 确实送达
 *    - 这个问法**刻意不提「系统提示词」**，避免触发模型自身「不披露系统提示词」
 *      的对齐行为，否则会把模型的安全策略误判成上游篡改。
 *
 * 2. **行为服从**：system 里写一条无害但反常的格式规则（先输出 ####）。
 *    再发一次**不带规则**的同题做对照。
 *    - 有规则时服从 + 无规则时不服从 → system 被完整读取并生效
 *    - 两次都不服从 → 模型本身不听话 OR system 被剥，需进一步区分
 *
 * 3. **上游专有词**：检查回复里有没有出现我们没写过的身份声明
 *    （"you are Trae"、"你是 XX 助手" 之类）。
 *
 * @module probes/canary
 */

/** 生成一个不可猜的暗号。 */
export function makeCanary() {
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `CANARY-${rand}-${Date.now().toString(36).slice(-4).toUpperCase()}`
}

/**
 * @typedef {object} CanaryResult
 * @property {string} canary
 * @property {{name:string, reply:string, passed:boolean|null, note:string}[]} checks
 * @property {{verdict:string, suspicious:boolean, reasons:string[]}} analysis
 */

/**
 * @param {import('../client.mjs').ProbeClient} client
 * @param {object} [options]
 * @param {number} [options.sleepMs]
 * @param {(msg:string)=>void} [options.onProgress]
 * @returns {Promise<CanaryResult>}
 */
export async function probeCanary(client, options = {}) {
  const sleepMs = options.sleepMs ?? 1200
  const onProgress = options.onProgress ?? (() => {})
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const canary = makeCanary()
  const MARK = '####'

  /** @type {CanaryResult['checks']} */
  const checks = []

  const run = async (name, systemText, question) => {
    const messages = [
      ...(systemText ? [{ role: 'system', content: systemText }] : []),
      { role: 'user', content: question },
    ]
    try {
      const { text } = await client.chat(messages, { maxTokens: 120 })
      return { name, reply: text.trim(), ok: true }
    } catch (err) {
      return { name, reply: '', ok: false, error: err.message }
    }
  }

  // ── 动作 1：中性复述 ──
  onProgress('动作 1/3：中性复述暗号')
  const r1 = await run(
    'canary-echo',
    `标识符: ${canary}`,
    '刚才这条消息里有一个标识符，格式像 CANARY-XXXX-XXXX。它是哪个？只回答标识符本身。',
  )
  checks.push({
    name: '① 中性复述暗号',
    reply: r1.reply,
    passed: r1.ok ? r1.reply.includes(canary) : null,
    note: r1.ok
      ? r1.reply.includes(canary) ? 'system 内容确实送达模型' : '未复现暗号（可能被拒答或概括）'
      : `请求失败: ${r1.error}`,
  })
  if (sleepMs > 0) await sleep(sleepMs)

  // ── 动作 2：行为服从（带规则 vs 不带规则）──
  onProgress('动作 2/3：行为服从差分')
  const RULE = `【格式规则·必须遵守】回答任何问题时，必须在答案最前面先输出四个井号：${MARK}`
  const r2a = await run('rule-on', RULE, '1+1 等于几？只回答数字。')
  if (sleepMs > 0) await sleep(sleepMs)
  const r2b = await run('rule-off', '', '1+1 等于几？只回答数字。')

  const compliantOn = r2a.ok && r2a.reply.includes(MARK)
  const compliantOff = r2b.ok && r2b.reply.includes(MARK)

  checks.push({
    name: '② 行为服从（有规则）',
    reply: r2a.reply,
    passed: r2a.ok ? compliantOn : null,
    note: compliantOn ? 'system 中的格式规则被遵守' : '未遵守格式规则',
  })
  checks.push({
    name: '③ 行为服从（无规则对照）',
    reply: r2b.reply,
    passed: r2b.ok ? !compliantOff : null,
    note: !compliantOff ? '对照组正确地不含标记 —— 差分成立' : '对照组也带了标记，需检查模型是否有预置偏好',
  })

  // ── 动作 3：回复里有没有上游专有身份词 ──
  const identityMarkers = [
    'trae', 'solo', 'you are an ai', '你是 trae', '你是trae',
    'as an ai language model', 'deepseek', '通义', 'qwen', 'claude',
  ]
  const allReplies = [r1.reply, r2a.reply, r2b.reply].join(' ').toLowerCase()
  const hits = identityMarkers.filter((m) => allReplies.includes(m))
  checks.push({
    name: '④ 上游专有身份词',
    reply: hits.join(', ') || '（无）',
    passed: hits.length === 0,
    note: hits.length === 0
      ? '回复中未出现未预期的身份声明'
      : `出现: ${hits.join(', ')} —— 需人工确认是否为模型自称`,
  })

  return { canary, checks, analysis: analyzeCanary(checks) }
}

/**
 * 把检查项翻译成结论。抽成纯函数便于单测。
 * @param {CanaryResult['checks']} checks
 */
export function analyzeCanary(checks) {
  const reasons = []
  const echo = checks.find((c) => c.name.startsWith('①'))
  const on = checks.find((c) => c.name.startsWith('②'))
  const off = checks.find((c) => c.name.startsWith('③'))
  const id = checks.find((c) => c.name.startsWith('④'))

  let suspicious = false

  if (echo?.passed === true) {
    reasons.push('暗号被准确复现 —— system 内容确实送达')
  } else if (echo?.passed === false) {
    reasons.push('暗号未被复现 —— 需结合下面两条判断是拒答还是被剥')
  }

  if (on?.passed === true && off?.passed === true) {
    reasons.push('有规则时服从、无规则时不服从 —— system 被完整读取且生效')
  } else if (on?.passed === false && off?.passed === true) {
    reasons.push('带格式规则仍不服从 —— system 可能被丢弃或被改写')
    suspicious = true
  } else if (on?.passed === false && off?.passed === false) {
    reasons.push('两次都无法差分 —— 模型可能不服从，结论不确定')
  }

  if (id?.passed === false) {
    reasons.push(`回复中出现未预期的身份词：${id.reply}`)
    suspicious = true
  }

  const verdict = suspicious
    ? '⚠️ 发现异常：system 内容可能被丢弃/替换，见下方理由'
    : reasons.length > 0
      ? '✅ 未发现 system 被改写：内容送达且生效'
      : '无法判定'

  return { verdict, suspicious, reasons }
}
