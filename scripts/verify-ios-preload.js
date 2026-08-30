// 验证 generated Swift(base64 分块)解码后与原始 preload 完全一致
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const gen = fs.readFileSync(path.join(root, 'ios/LxMusicMobile/UserApi/UserApiPreload.generated.swift'), 'utf8')
const orig = fs.readFileSync(path.join(root, 'android/app/src/main/assets/script/user-api-preload.js'), 'utf8')

// 提取所有 "..." 字符串分块(容忍 CRLF)
const chunks = [...gen.matchAll(/^\s*"([A-Za-z0-9+/=]+)",?\r?$/gm)].map(m => m[1])
if (!chunks.length) {
  console.error('NO base64 chunks found')
  process.exit(1)
}
const b64 = chunks.join('')
const decoded = Buffer.from(b64, 'base64').toString('utf8')
console.log('roundtrip equal:', decoded === orig)
if (decoded !== orig) {
  for (let i = 0; i < Math.max(decoded.length, orig.length); i++) {
    if (decoded[i] !== orig[i]) {
      console.log('first diff at', i, JSON.stringify(decoded.slice(i - 40, i + 40)), 'vs', JSON.stringify(orig.slice(i - 40, i + 40)))
      break
    }
  }
  process.exit(1)
}
console.log('length:', orig.length, 'base64 length:', b64.length)
