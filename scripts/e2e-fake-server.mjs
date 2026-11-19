/**
 * 端到端自测用：起一个真的 HTTP 假上游，让 CLI 通过真实 socket 打它。
 * 这验证的不只是函数逻辑，还有 HTTP/SSE 解析这条真实链路。
 */
import http from 'node:http'
import { makeFakeUpstream } from '../test/fake-upstream.mjs'

const behaviorName = process.argv[2] ?? 'clean'
const behaviors = {
  clean: {},
  bloated: { extraBloat: 3000 },
  truncated: { truncateSystem: true },
  nocache: { reportCache: true, cacheHitTokens: 0 },
  cache: { reportCache: true, cacheHitTokens: 1500 },
}
const behavior = behaviors[behaviorName]
if (!behavior) { console.error('未知行为:', behaviorName); process.exit(1) }

const { fetchImpl } = makeFakeUpstream(behavior)

const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const r = await fetchImpl(req.url, { method: 'POST', body, headers: req.headers })
  res.writeHead(r.status, Object.fromEntries(r.headers))
  res.end(await r.text())
})

const port = Number(process.argv[3] ?? 18999)
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, port, behavior: behaviorName }))
})
