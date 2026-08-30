// 验证 generated Swift 字符串与原始 preload 的往返一致性
const fs = require('fs')
const path = require('path')
const root = path.join(__dirname, '..')
const gen = fs.readFileSync(path.join(root, 'ios/LxMusicMobile/UserApi/UserApiPreload.generated.swift'), 'utf8')
const orig = fs.readFileSync(path.join(root, 'android/app/src/main/assets/script/user-api-preload.js'), 'utf8')

const m = gen.match(/static let script = "([\s\S]*)"\n\}/)
if (!m) {
  console.error('NO MATCH for script literal')
  process.exit(1)
}
let body = m[1]
// 反向还原生成时的转义:
// 1) 原换行 → "\n"+续行反斜杠+真实换行  2) 原反斜杠 → "\\"  3) 原双引号 → \""
body = body
  .replace(/\\n\\\n/g, '\n')
  .replace(/\\\\/g, '\\')
  .replace(/\\"/g, '"')

console.log('roundtrip equal:', body === orig)
if (body !== orig) {
  for (let i = 0; i < Math.max(body.length, orig.length); i++) {
    if (body[i] !== orig[i]) {
      console.log('first diff at', i, JSON.stringify(body.slice(i - 40, i + 40)), 'vs', JSON.stringify(orig.slice(i - 40, i + 40)))
      break
    }
  }
  process.exit(1)
}
console.log('length:', orig.length)
