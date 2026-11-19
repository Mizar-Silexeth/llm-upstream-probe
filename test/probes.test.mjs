/**
 * 测试：证明这些探针**真的能抓出问题**，而不只是会说「没问题」。
 *
 * 这是整个仓库最重要的一组测试。一个检测器如果对「加料的上游」也说 OK，
 * 那它存在的意义就是给人虚假的安全感。所以每条测试都构造一个**确定有问题的
 * 假上游**，断言探针必须报警。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ProbeClient } from '../src/client.mjs'
import { probeTokenDifferential, analyze } from '../src/probes/token-differential.mjs'
import { probeCanary, analyzeCanary } from '../src/probes/canary.mjs'
import { probeCache, analyzeCache } from '../src/probes/cache.mjs'
import { makeFakeUpstream } from './fake-upstream.mjs'

const fast = { sleepMs: 0 }

/** 造一个指向假上游的 client。 */
function clientFor(behavior) {
  const { fetchImpl, calls } = makeFakeUpstream(behavior)
  const client = new ProbeClient({
    baseUrl: 'http://fake/v1',
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl,
  })
  return { client, calls }
}

// ─────────────────────────────────────────────────────────────
// token 差分
// ─────────────────────────────────────────────────────────────

test('token 差分：干净上游 → 判定通过', async () => {
  const { client } = clientFor({})
  const result = await probeTokenDifferential(client, { ...fast, ladder: [0, 25, 50, 100] })

  assert.equal(result.analysis.suspicious, false, `不应报警，理由: ${result.analysis.reasons.join('; ')}`)
  assert.ok(result.fit.r2 > 0.98, `线性度应很高，实际 R²=${result.fit.r2}`)
  assert.ok(result.fit.slope > 5, `斜率应接近每单位 11 tokens，实际 ${result.fit.slope}`)
})

test('token 差分：上游偷塞固定前缀 → 必须报警', async () => {
  // 偷偷加 3000 tokens 的固定前缀：这是最典型的「中转加料」形态
  const { client } = clientFor({ extraBloat: 3000 })
  const result = await probeTokenDifferential(client, { ...fast, ladder: [0, 25, 50, 100] })

  assert.equal(result.analysis.suspicious, true, '上下游偷加固定前缀时必须报警')
  assert.ok(
    result.analysis.reasons.some((r) => r.includes('截距') || r.includes('附加') || r.includes('空 system')),
    `应指出截距异常，实际理由: ${result.analysis.reasons.join('; ')}`,
  )
})

test('token 差分：上游截断 system → 必须报警', async () => {
  const { client } = clientFor({ truncateSystem: true })
  const result = await probeTokenDifferential(client, { ...fast, ladder: [0, 25, 50, 100] })

  assert.equal(result.analysis.suspicious, true, '上游截断内容时必须报警')
  assert.ok(
    result.analysis.reasons.some((r) => r.includes('截断') || r.includes('摘要') || r.includes('斜率')),
    `应指出斜率异常，实际理由: ${result.analysis.reasons.join('; ')}`,
  )
})

test('token 差分：样本不足时不许假装通过', async () => {
  const fakeFetch = async () => new Response('nope', { status: 500 })
  const client = new ProbeClient({
    baseUrl: 'http://fake/v1', apiKey: 'k', model: 'm', fetchImpl: fakeFetch,
  })
  const result = await probeTokenDifferential(client, { ...fast, ladder: [0, 25] })

  assert.equal(result.analysis.suspicious, false)
  assert.match(result.analysis.verdict, /无法判定/, '不能把「测不到」说成「没问题」')
})

// ─────────────────────────────────────────────────────────────
// 暗号法
// ─────────────────────────────────────────────────────────────

test('暗号法：干净上游 → 暗号复现且规则被遵守', async () => {
  const { client } = clientFor({})
  const result = await probeCanary(client, fast)

  const echo = result.checks.find((c) => c.name.startsWith('①'))
  assert.equal(echo.passed, true, `暗号应被复现，实际回复: ${echo.reply}`)

  const on = result.checks.find((c) => c.name.startsWith('②'))
  const off = result.checks.find((c) => c.name.startsWith('③'))
  assert.equal(on.passed, true, '有规则时应服从')
  assert.equal(off.passed, true, '无规则时应正确地不带标记')

  assert.equal(result.analysis.suspicious, false)
})

test('暗号法：上游丢弃 system → 必须报警', async () => {
  // 模拟上游把 system 整个剥掉：模型看不到格式规则，也不认识暗号
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    const stripped = { ...body, messages: body.messages.filter((m) => m.role !== 'system') }
    const { fetchImpl: inner } = makeFakeUpstream({})
    return inner(url, { ...init, body: JSON.stringify(stripped) })
  }
  const client = new ProbeClient({
    baseUrl: 'http://fake/v1', apiKey: 'k', model: 'm', fetchImpl,
  })

  const result = await probeCanary(client, fast)
  assert.equal(result.analysis.suspicious, true, 'system 被剥时必须报警')
})

// ─────────────────────────────────────────────────────────────
// 缓存
// ─────────────────────────────────────────────────────────────

test('缓存探针：上游完全不报缓存字段 → 只能给「无法判定」', async () => {
  const { client } = clientFor({ reportCache: false })
  const result = await probeCache(client, fast)

  assert.equal(result.analysis.supported, null)
  assert.match(result.analysis.verdict, /无法判定/)
})

test('缓存探针：字段存在但恒为 0 → 判定为不提供缓存', async () => {
  const { client } = clientFor({ reportCache: true, cacheHitTokens: 0 })
  const result = await probeCache(client, fast)

  assert.equal(result.analysis.supported, false)
  assert.match(result.analysis.verdict, /不提供前缀缓存/)
})

test('缓存探针：有命中 → 判定为提供缓存', async () => {
  const { client } = clientFor({ reportCache: true, cacheHitTokens: 1500 })
  const result = await probeCache(client, fast)

  assert.equal(result.analysis.supported, true)
})

// ─────────────────────────────────────────────────────────────
// 纯函数：结论翻译
// ─────────────────────────────────────────────────────────────

test('analyze：良好拟合不报警', () => {
  const usable = [
    { k: 0, chars: 0, promptTokens: 30 },
    { k: 25, chars: 1100, promptTokens: 305 },
    { k: 50, chars: 2200, promptTokens: 580 },
  ]
  const r = analyze({ slope: 11, intercept: 30, r2: 0.9999, n: 3 }, usable)
  assert.equal(r.suspicious, false)
})

test('analyze：截距异常大时报警', () => {
  const usable = [
    { k: 0, chars: 0, promptTokens: 4000 },
    { k: 25, chars: 1100, promptTokens: 4275 },
    { k: 50, chars: 2200, promptTokens: 4550 },
  ]
  const r = analyze({ slope: 11, intercept: 4000, r2: 0.9999, n: 3 }, usable)
  assert.equal(r.suspicious, true)
})

test('analyzeCanary：全通过不报警', () => {
  const r = analyzeCanary([
    { name: '① 中性复述暗号', reply: 'CANARY-ABCD-1234', passed: true, note: '' },
    { name: '② 行为服从（有规则）', reply: '####2', passed: true, note: '' },
    { name: '③ 行为服从（无规则对照）', reply: '2', passed: true, note: '' },
    { name: '④ 上游专有身份词', reply: '（无）', passed: true, note: '' },
  ])
  assert.equal(r.suspicious, false)
})

test('analyzeCache：无字段与有字段但为 0 必须区分开', () => {
  const noField = analyzeCache([
    { name: 'r1', usage: { cacheReadTokens: null }, ok: true },
    { name: 'r2', usage: { cacheReadTokens: null }, ok: true },
  ])
  assert.equal(noField.supported, null)

  const zero = analyzeCache([
    { name: 'r1', usage: { cacheReadTokens: 0 }, ok: true },
    { name: 'r2', usage: { cacheReadTokens: 0 }, ok: true },
  ])
  assert.equal(zero.supported, false)
})
