// iOS UserApiScriptExecutor 的 Node 端模拟验证:
// 用与 Swift JSContext 完全相同的原生函数桥(__lx_native_call__ 系列),
// 加载同一份 user-api-preload.js + 移动版 B站音源脚本,
// 再模拟 RN JS 侧(init/userApi/request.js)的消息协议, 对真实 B站 API 做端到端验证。
// 用途: 在 Windows 上预先验证 iOS 引擎架构(无法本机跑 xcodebuild)。
//
// 注意: Node vm 默认 microtaskMode=afterEvaluate, 宿主直接调用 vm 内函数不会冲刷
// Promise 微任务队列, 因此所有 宿主→脚本 的调用都包一层 runInContext
// (iOS JavaScriptCore 原生调用会自动冲刷微任务, 无需此处理)。
import fs from 'fs'
import path from 'path'
import vm from 'vm'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const preload = fs.readFileSync(path.join(root, 'android/app/src/main/assets/script/user-api-preload.js'), 'utf8')
// 从 biliSourceScript.ts 提取 String.raw 模板里的原始脚本(与 App 实际嵌入内容一致)
const biliTs = fs.readFileSync(path.join(root, 'src/utils/biliSourceScript.ts'), 'utf8')
const startIdx = biliTs.indexOf('String.raw`') + 'String.raw`'.length
const sourceScript = biliTs.slice(startIdx, biliTs.lastIndexOf('`'))

const KEY = 'test-key'
const events = [] // 脚本 → "原生" 的事件(对应 Swift 的 emitEvent)
const sandbox = {
  console: {
    log: (...a) => events.push(['log', 'log', a.map(String).join(' ')]),
    info: (...a) => events.push(['log', 'info', a.map(String).join(' ')]),
    warn: (...a) => events.push(['log', 'warn', a.map(String).join(' ')]),
    error: (...a) => events.push(['log', 'error', a.map(String).join(' ')]),
  },
}

vm.createContext(sandbox)

// —— 宿主 → 脚本 统一入口(包 runInContext 以冲刷微任务) ——
function nativeToScript(action, data) {
  const args = [JSON.stringify(KEY), JSON.stringify(action)]
  if (data != null) args.push(JSON.stringify(data))
  vm.runInContext(`__lx_native__(${args.join(',')})`, sandbox, { filename: 'nativeToScript.js' })
}

// —— 模拟 RN JS 侧(request.js): 脚本发来的 lx.request → fetch → 回 response ——
async function handleScriptRequest(eventData) {
  const { requestKey, url, options } = JSON.parse(eventData)
  const method = (options && options.method) || 'get'
  const headers = Object.assign({ Accept: 'application/json' }, (options && options.headers) || {})
  const resp = await fetch(url, { method, headers })
  const text = await resp.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  const response = {
    statusCode: resp.status,
    statusMessage: resp.statusText,
    headers: Object.fromEntries(resp.headers.entries()),
    body,
  }
  nativeToScript('response', JSON.stringify({ requestKey, error: null, response }))
}

// 脚本 → 原生 的事件(对应 Swift 的 emitEvent); 结果按 requestKey 归档
const results = new Map()

// —— 模拟 Swift 端 installNativeFunctions ——
// 注意: preload 在 lx_setup 时捕获 __lx_native_call__, 因此必须在 preload 加载前
// 一次性装好最终版本(与 iOS 端一致), 不能在运行中替换。
sandbox.__lx_native_call__ = (key, action, data) => {
  if (key !== KEY) return null
  events.push([action, data])
  if (action === 'request') {
    handleScriptRequest(data).catch(err => {
      const { requestKey } = JSON.parse(data)
      nativeToScript('response', JSON.stringify({ requestKey, error: err.message, response: null }))
    })
  }
  if (action === 'response') {
    const parsed = JSON.parse(data)
    results.set(parsed.requestKey, parsed)
  }
  return null
}
sandbox.__lx_native_call__set_timeout = (id, ms) => {
  setTimeout(() => nativeToScript('__set_timeout__', id), ms)
}
sandbox.__lx_native_call__utils_str2b64 = (str) => Buffer.from(str, 'utf8').toString('base64')
sandbox.__lx_native_call__utils_b642buf = (b64) => '[' + [...Buffer.from(b64, 'base64')].join(',') + ']'
sandbox.__lx_native_call__utils_str2md5 = (str) => crypto.createHash('md5').update(decodeURIComponent(str), 'utf8').digest('hex')
sandbox.__lx_native_call__utils_aes_encrypt = () => ''
sandbox.__lx_native_call__utils_rsa_encrypt = () => ''

// —— 与 Swift 相同顺序: preload → lx_setup → 音源脚本 ——
vm.runInContext(preload, sandbox, { filename: 'user-api-preload.js' })
vm.runInContext(
  `lx_setup(${JSON.stringify(KEY)}, ${JSON.stringify('test-id')}, ${JSON.stringify('B站专属音源(手机版)')}, ${JSON.stringify('')}, ${JSON.stringify('6.4.0')}, ${JSON.stringify('Charke Lee')}, ${JSON.stringify('')}, ${JSON.stringify(sourceScript)})`,
  sandbox,
  { filename: 'lx_setup-call.js' },
)
vm.runInContext(sourceScript, sandbox, { filename: 'biliSourceScript.js' })

function sendMusicUrlRequest(song) {
  const requestKey = 'request__' + Math.random().toString().substring(2)
  nativeToScript('request', JSON.stringify({
    requestKey,
    data: { source: 'wy', action: 'musicUrl', info: { type: 'music', musicInfo: song } },
  }))
  return requestKey
}

// 用一首真实的歌验证
const song = { name: '海阔天空', singer: 'Beyond', interval: '4:22' }
sendMusicUrlRequest(song)

const deadline = Date.now() + 60000
const finalize = new Promise((resolve, reject) => {
  const poll = setInterval(() => {
    const initEvent = events.find(([a]) => a === 'init')
    if (!initEvent) {
      if (Date.now() > deadline) { clearInterval(poll); reject(new Error('timeout waiting init')) }
      return
    }
    const response = [...results.values()].find(r => r.status !== undefined)
    if (response) {
      clearInterval(poll)
      resolve({ initEvent, response })
    }
    if (Date.now() > deadline) { clearInterval(poll); reject(new Error('timeout waiting musicUrl response')) }
  }, 500)
})

finalize.then(({ initEvent, response }) => {
  const init = JSON.parse(initEvent[1])
  console.log('=== init event ===')
  console.log(JSON.stringify(init, null, 2))
  console.log('=== musicUrl response ===')
  console.log(JSON.stringify({ status: response.status, result: response.result }, null, 2))
  const url = response.result && response.result.data && response.result.data.url
  if (init.status !== true) throw new Error('init status not true')
  if (!url || !/^https?:/.test(url)) throw new Error('no valid music url')
  console.log('=== PASS: init ok + got music url:', url.substring(0, 80) + '...')
  process.exit(0)
}).catch(err => {
  console.error('=== FAIL ===')
  console.error(err.message)
  console.error('events tail:', JSON.stringify(events.slice(-8), null, 2))
  process.exit(1)
})
