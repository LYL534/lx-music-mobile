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
