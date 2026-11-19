#!/usr/bin/env node
/**
 * llm-probe —— 检测一个 OpenAI 兼容端点到底把你的提示词怎么样了。
 *
 * 用法：
 *   llm-probe --base-url https://api.example.com/v1 --api-key sk-xxx --model gpt-4o-mini
 *   llm-probe --base-url ... --probe cache        # 只测缓存
 *   llm-probe --base-url ... --json               # 输出机器可读结果
 *
 * 凭据只从命令行/环境变量读取，**不读任何本地凭据文件**，也不落盘。
 */

import { ProbeClient } from '../src/client.mjs'
import { probeTokenDifferential } from '../src/probes/token-differential.mjs'
import { probeCanary } from '../src/probes/canary.mjs'
import { probeCache } from '../src/probes/cache.mjs'

function parseArgs(argv) {
  const out = { probe: 'all', sleepMs: 1200, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--base-url' || a === '-u') out.baseUrl = next()
    else if (a === '--api-key' || a === '-k') out.apiKey = next()
    else if (a === '--model' || a === '-m') out.model = next()
    else if (a === '--probe' || a === '-p') out.probe = next()
    else if (a === '--sleep') out.sleepMs = Number(next())
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (a === '--header') {
      const h = next() ?? ''
      const idx = h.indexOf(':')
      if (idx > 0) {
        out.headers ??= {}
        out.headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim()
      }
    }
  }
  return out
}

const HELP = `
llm-probe —— 检测 OpenAI 兼容端点是否原样转发你的提示词

必需参数：
  -u, --base-url <url>    端点根地址，例如 https://api.example.com/v1
  -m, --model <name>      模型名

可选：
  -k, --api-key <key>     API Key（也可用环境变量 LLM_PROBE_API_KEY）
  -p, --probe <name>      token | canary | cache | all（默认 all）
      --sleep <ms>        请求间隔，默认 1200
      --header "K: V"     额外请求头，可重复
      --json              输出 JSON
  -h, --help              显示帮助

示例：
  llm-probe -u https://api.deepseek.com/v1 -k $KEY -m deepseek-chat
  llm-probe -u https://relay.example.com/v1 -k $KEY -m gpt-4o -p cache

注意：会消耗少量额度（约 20-40 次短请求）。凭据只在本进程内使用，不落盘。
`

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.baseUrl || !args.model) {
    console.log(HELP)
    process.exit(args.help ? 0 : 1)
  }

  const apiKey = args.apiKey ?? process.env.LLM_PROBE_API_KEY ?? ''
  const client = new ProbeClient({
    baseUrl: args.baseUrl,
    apiKey,
    model: args.model,
    headers: args.headers,
  })

  const log = args.json ? () => {} : (m) => console.log(m)
  const results = {}

  if (args.probe === 'all' || args.probe === 'token') {
    log('\n── 探针 1/3：token 差分（有没有额外内容）──')
    results.token = await probeTokenDifferential(client, {
      sleepMs: args.sleepMs,
      onProgress: log,
    })
  }

  if (args.probe === 'all' || args.probe === 'canary') {
    log('\n── 探针 2/3：暗号（system 有没有被换掉）──')
    results.canary = await probeCanary(client, {
      sleepMs: args.sleepMs,
      onProgress: log,
    })
  }

  if (args.probe === 'all' || args.probe === 'cache') {
    log('\n── 探针 3/3：缓存（有没有在做前缀复用）──')
    results.cache = await probeCache(client, {
      sleepMs: args.sleepMs,
      onProgress: log,
    })
  }

  if (args.json) {
    console.log(JSON.stringify({ endpoint: args.baseUrl, model: args.model, results }, null, 2))
    return
  }

  console.log('\n════════ 结论 ════════')
  let suspicious = false
  for (const [name, r] of Object.entries(results)) {
    console.log(`\n【${name}】`)
    if (r.analysis) {
      console.log(r.analysis.verdict)
      for (const reason of r.analysis.reasons ?? []) console.log(`  · ${reason}`)
      if (r.analysis.suspicious) suspicious = true
    }
  }
  console.log(`\n请求总数：${client.requestCount}`)
  console.log(suspicious
    ? '\n⚠️ 有探针报警，请核对上面的理由。'
    : '\n✅ 所有探针均未发现异常。')
}

main().catch((err) => {
  console.error('探针异常:', err.message)
  process.exit(1)
})
