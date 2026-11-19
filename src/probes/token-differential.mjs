/**
 * 探针 1：token 差分法 —— 判断上游有没有在你的内容之外加东西。
 *
 * ## 原理（为什么这个能证明事）
 *
 * 发出去的内容完全由我们控制。上游若原样转发，返回的 prompt_tokens 只应
 * 与我们的内容成线性关系：
 *
 *     prompt_tokens = slope × 我们的量 + intercept
 *
 * - **intercept（截距）** 是「内容之外的部分」：消息结构 + 上游可能塞的固定前缀。
 *   若上游偷偷塞了一段身份声明/安全规则，它会全部落进这个截距。
 * - **slope（斜率）** 是「内容被计入的效率」。若上游截断、摘要、去重，斜率会偏低。
 *
 * ## 关键：这个判据能抓出什么、抓不出什么
 *
 * ✅ 抓得出：固定的 system 前缀注入（截距异常大）
 * ✅ 抓得出：内容截断或摘要（斜率偏低）
 * ✅ 抓得出：每次结果不同（有隐藏状态 / 内容相关改写）
 * ❌ 抓不出：上游把我们的内容等量替换（比如系统提示词换成它自己的，但长度相当）
 *           —— 这种情况交给 probe 2（暗号法）
 *
 * @module probes/token-differential
 */

import { linearRegression } from '../client.mjs'

/** 定长填充单位：7 个英文词，约 44 字符。英文密度稳定，最适合做标尺。 */
export const UNIT = 'alpha bravo charlie delta echo foxtrot golf '

/** 纯英文基线的理论密度：约 4 字符/token。用于粗判斜率是否离谱。 */
const EN_CHARS_PER_TOKEN = 4

/**
 * @typedef {object} DifferentialResult
 * @property {{k:number, chars:number, promptTokens:number|null, ok:boolean, error?:string}[]} samples
 * @property {{slope:number, intercept:number, r2:number, n:number}} fit
 * @property {{baseline:number|null}} meta
 * @property {{verdict:string, reasons:string[], suspicious:boolean}} analysis
 */

/**
 * @param {import('../client.mjs').ProbeClient} client
 * @param {object} [options]
 * @param {number[]} [options.ladder] 重复次数阶梯
 * @param {number} [options.sleepMs]
 * @param {(msg:string)=>void} [options.onProgress]
 * @returns {Promise<DifferentialResult>}
 */
export async function probeTokenDifferential(client, options = {}) {
  const ladder = options.ladder ?? [0, 25, 50, 100]
  const sleepMs = options.sleepMs ?? 1200
  const onProgress = options.onProgress ?? (() => {})
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** @type {DifferentialResult['samples']} */
  const samples = []

  for (const k of ladder) {
    const systemText = UNIT.repeat(k)
    const messages = systemText.length > 0
      ? [{ role: 'system', content: systemText }, { role: 'user', content: 'reply with: ok' }]
      : [{ role: 'user', content: 'reply with: ok' }]

    try {
      const { usage } = await client.chat(messages, { maxTokens: 4 })
      samples.push({ k, chars: systemText.length, promptTokens: usage.promptTokens, ok: true })
      onProgress(`k=${k}  chars=${systemText.length}  prompt_tokens=${usage.promptTokens}`)
    } catch (err) {
      samples.push({ k, chars: systemText.length, promptTokens: null, ok: false, error: err.message })
      onProgress(`k=${k}  失败: ${err.message}`)
      if ([401, 403, 429].includes(/** @type {any} */ (err).status)) {
        onProgress('⛔ 鉴权/限流错误，停止采样')
        break
      }
    }
    if (sleepMs > 0) await sleep(sleepMs)
  }

  const usable = samples.filter((s) => s.ok && typeof s.promptTokens === 'number')
  const fit = linearRegression(usable.map((s) => ({ x: s.k, y: /** @type {number} */ (s.promptTokens) })))
  const baselineSample = usable.find((s) => s.k === 0)

  const { verdict, reasons, suspicious } = analyze(fit, usable)

  return {
    samples,
    fit,
    meta: { baseline: baselineSample ? /** @type {number} */ (baselineSample.promptTokens) : null },
    analysis: { verdict, reasons, suspicious },
  }
}

/**
 * 把回归结果翻译成结论。抽成纯函数，便于单测。
 *
 * @param {{slope:number, intercept:number, r2:number, n:number}} fit
 * @param {{k:number, chars:number, promptTokens:number|null}[]} usable
 */
export function analyze(fit, usable) {
  const reasons = []
  let suspicious = false

  if (usable.length < 2) {
    return {
      verdict: '无法判定：可用样本不足（至少需要 2 个成功请求）',
      reasons: ['端点可能拒绝请求、返回了非标准 usage，或网络不通'],
      suspicious: false,
    }
  }

  if (Number.isNaN(fit.slope)) {
    return {
      verdict: '无法判定：样本点没有区分度（各档 prompt_tokens 相同）',
      reasons: ['可能上游忽略了 system 字段，或所有请求都失败了'],
      suspicious: false,
    }
  }

  // ── 斜率：每单位（44 字符英文）应约 11 tokens ──
  //
  // 阈值为什么是 0.6 / 2.0：
  //   不同 tokenizer 对同一段英文的密度在 3.5~4.5 字符/token 之间浮动，
  //   折算成比率是 0.89~1.14，留足余量后取 0.6 作为下界。
  //   截断 50% 会让比率落到 0.5 —— 必须能被抓住，所以下界不能高于 0.5。
  //   （这条边界是测试逼出来的：最初写 < 0.5，恰好放过 50% 截断。）
  const expectedPerUnit = UNIT.length / EN_CHARS_PER_TOKEN
  const slopeRatio = fit.slope / expectedPerUnit

  if (slopeRatio < 0.6) {
    suspicious = true
    reasons.push(
      `斜率仅 ${fit.slope.toFixed(3)} token/单位（期望约 ${expectedPerUnit.toFixed(1)}），` +
      `内容可能被截断或摘要`,
    )
  } else if (slopeRatio > 2) {
    suspicious = true
    reasons.push(
      `斜率 ${fit.slope.toFixed(3)} token/单位远高于期望 ${expectedPerUnit.toFixed(1)}，` +
      `内容可能被扩写或重复计入`,
    )
  } else {
    reasons.push(`斜率 ${fit.slope.toFixed(3)} token/单位（期望约 ${expectedPerUnit.toFixed(1)}），正常`)
  }

  // ── 线性度 ──
  if (fit.r2 < 0.98) {
    suspicious = true
    reasons.push(`线性度 R²=${fit.r2.toFixed(4)} 偏低，token 数不随内容线性增长，可能存在内容相关的处理`)
  } else {
    reasons.push(`线性度 R²=${fit.r2.toFixed(4)}，内容按比例完整计入`)
  }

  // ── 截距：这档阶梯下，k=0 的基线就是这个量级 ──
  // 正常情况下，k=0 时只有一条 user 消息，prompt_tokens 应在 10~60 之间。
  const baseline = usable.find((s) => s.k === 0)?.promptTokens ?? null
  if (typeof baseline === 'number' && baseline > 200) {
    suspicious = true
    reasons.push(
      `空 system 时已消耗 ${baseline} tokens（正常应 < 60），` +
      `上游可能在请求里附加了固定内容`,
    )
  }

  // ── 单点离群：某一档明显偏离拟合线 ──
  const outliers = usable.filter((s) => {
    const predicted = fit.slope * s.k + fit.intercept
    const actual = /** @type {number} */ (s.promptTokens)
    return Math.abs(actual - predicted) > Math.max(10, predicted * 0.08)
  })
  if (outliers.length > 0) {
    suspicious = true
    reasons.push(
      `离群点：${outliers.map((o) => `k=${o.k}(实测${o.promptTokens})`).join(', ')} 与拟合不符`,
    )
  }

  const verdict = suspicious
    ? '⚠️ 发现异常：上游行为与「原样转发」不符，见下方理由'
    : '✅ 未发现加料迹象：内容按比例完整计入，截距在正常范围'

  return { verdict, reasons, suspicious }
}
