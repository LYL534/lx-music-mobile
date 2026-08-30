// 应用 RNTP(react-native-track-player) 补丁: 把 vendored 修改文件复制到 node_modules
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const map = {
  'vendor/react-native-track-player/android/src/main/java/com/guichaguri/trackplayer/service/models/Track.java':
    'node_modules/react-native-track-player/android/src/main/java/com/guichaguri/trackplayer/service/models/Track.java',
  'vendor/react-native-track-player/android/src/main/java/com/guichaguri/trackplayer/service/player/LocalPlayback.java':
    'node_modules/react-native-track-player/android/src/main/java/com/guichaguri/trackplayer/service/player/LocalPlayback.java',
  'vendor/react-native-track-player/android/build.gradle':
    'node_modules/react-native-track-player/android/build.gradle',
  'vendor/react-native-track-player/ios/RNTrackPlayer/Models/Track.swift':
    'node_modules/react-native-track-player/ios/RNTrackPlayer/Models/Track.swift',
};

for (const [src, dst] of Object.entries(map)) {
  const s = path.join(root, src);
  const d = path.join(root, dst);
  if (!fs.existsSync(s)) {
    console.error('[apply-rntp-patch] missing:', s);
    process.exitCode = 1;
    continue;
  }
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(s, d);
  console.log('[apply-rntp-patch] applied:', dst);
}

// 重新生成 iOS 端 JSContext 使用的 preload 嵌入文件
try {
  require('./generate-ios-preload.js')
} catch (err) {
  console.error('[apply-rntp-patch] generate-ios-preload failed:', err.message)
  process.exitCode = 1
}
