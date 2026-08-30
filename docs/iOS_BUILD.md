# iOS 构建与适配 (iOS_BUILD)

为 iPhone/iPad 提供自带 B站音源的洛雪音乐 iOS 版(未签名 IPA + 侧载安装)。

> 上游 lx-music-mobile 官方明确"目前没有计划支持 iOS"(README 原话), 其 ios/ 目录只是
> RN 空模板, 没有 Android 端的 QuickJS 音源引擎。本分支补齐了 iOS 端的全部能力。

## 与 Android 版的差异(为什么 iOS 需要单独适配)

1. **音源脚本引擎**:Android 用 `wang.harlon.quickjs`(QuickJS) 跑 `user-api-preload.js`,
   iOS 用系统自带的 **JavaScriptCore(`JSContext`)** 移植了同等能力, 复用同一份 preload
   (`android/app/src/main/assets/script/user-api-preload.js` 经
   `scripts/generate-ios-preload.js` 嵌入 `UserApiPreload.generated.swift`)。
   消息协议(`api-action` 事件的 action/data/errorMessage/type/log)与 Android 完全一致,
   JS 侧 `src/core/init/userApi/` 无需任何改动。
2. **播放器取流**:iOS 端 RNTP(v2, 基于 SwiftAudioEx/AVPlayer)本来就能给 AVURLAsset
   传 `AVURLAssetHTTPHeaderFieldsKey`(Referer 没问题), 但 AVPlayer 的 UA 是
   `AppleCoreMedia/...` 移动端 UA, 会被 B站 CDN 拦截(403)。补丁给 `Track.swift` 增加
   `AVURLAssetHTTPUserAgentKey` 支持, 读取 track 的 `userAgent` 字段
   (`src/plugins/player/playList.ts` 已给 B站链接附带 PC Chrome UA)。
3. **后台播放**:Info.plist 增加 `UIBackgroundModes: audio`(RNTP 锁屏/后台播放必需)。

## 代码改动(相对 Android 版 v1.8.4.1)

| 文件 | 改动 |
| --- | --- |
| `ios/LxMusicMobile/UserApi/UserApiModule.swift`(新增) | RN 桥模块(RCTEventEmitter): loadScript / sendAction / destroy, 事件 `api-action` |
| `ios/LxMusicMobile/UserApi/UserApiScriptExecutor.swift`(新增) | JSContext 引擎: preload+脚本加载、`__lx_native_call__`/`__lx_native__`/setTimeout/utils(空 AES/RSA)、console、异常上报; 语义对齐 Android QuickJS.java |
| `ios/LxMusicMobile/UserApi/UserApiPreload.generated.swift`(生成) | 嵌入的 preload(与 Android 同一份, 由 `scripts/generate-ios-preload.js` 生成, 勿手改) |
| `scripts/generate-ios-preload.js` + `scripts/verify-ios-preload.js`(新增) | 生成与往返一致性校验脚本 |
| `ios/LxMusicMobile.xcodeproj/project.pbxproj` | 注册 3 个 Swift 源文件; 版本 1.8.4.1(77); Bundle ID `cn.toside.music.mobile` |
| `ios/LxMusicMobile/Info.plist` | 增加 `UIBackgroundModes: audio` |
| `vendor/react-native-track-player/ios/RNTrackPlayer/Models/Track.swift` | `userAgent` 字段 + `AVURLAssetHTTPUserAgentKey`(postinstall 自动应用到 node_modules) |
| `scripts/apply-rntp-patch.js` | 增加 iOS Track.swift 映射 + 触发 preload 重新生成 |
| `.github/workflows/ios.yml`(新增) | macOS 云构建: npm ci → pod install → xcodebuild(未签名) → 打包 IPA → 上传 artifact |

## 构建

**必须在 macOS 上构建**(xcodebuild 无 Windows/Linux 版)。两种方式:

### A. GitHub Actions(推荐, 本机零环境要求)

1. 把本分支推送到 GitHub 仓库;
2. 仓库 → Actions → 左侧 "Build iOS" → Run workflow(或直接 push master 触发);
3. 构建完成后在运行页底部下载 artifact `lx-music-mobile-bili-v1.8.4.1-ios-unsigned.zip`,
   解压得到 `.ipa`。

要求: 仓库公开(免费 macOS 额度 2000 分钟/月, 单次构建约 20~40 分钟);
私有仓库付费, 或自行缩短 `runs-on` 用量。

### B. 本地 Mac

前置: macOS + Xcode 15(建议)+ Node 18 + CocoaPods。

```bash
npm ci                       # postinstall 自动应用 RNTP 补丁 + 生成 preload
cd ios
bundle install
bundle exec pod install
xcodebuild -workspace LxMusicMobile.xcworkspace -scheme LxMusicMobile \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -archivePath build/LxMusicMobile.xcarchive \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY='' archive
# 打包未签名 IPA
mkdir -p Payload
cp -R build/LxMusicMobile.xcarchive/Products/Applications/LxMusicMobile.app Payload/
zip -qry lx-music-mobile-bili-v1.8.4.1-ios-unsigned.ipa Payload
```

有 Apple 开发者账号的也可直接在 Xcode 里 Signing & Capabilities 选 Team 后 Run/Archive 到真机。

## 安装(签名)

IPA 必须签名才能装到未越狱的 iPhone。按条件选一条:

| 条件 | 方式 | 有效期 |
| --- | --- | --- |
| 有 Windows 电脑 + 免费 Apple ID(推荐) | [Sideloadly](https://sideloadly.io/) 把未签名 IPA 拖入, 填 Apple ID 签名安装(USB/WiFi) | 7 天, 到期重复一次即可(数据保留) |
| 有 Mac + 免费 Apple ID | AltStore / Sideloadly | 7 天, AltStore 可在同一 WiFi 自动续签 |
| iOS 14~16.6.1 / 部分 17.0(视机型) | TrollStore(永久签名, 免 Apple ID) | 永久 |
| 付费开发者账号($99/年) | 任意签名工具/Xcode | 1 年 |

注意: 免费 Apple ID 同时最多 3 个侧载 App、7 天重签; 重签后数据保留。
本包 Bundle ID 为 `cn.toside.music.mobile`(与安卓版一致), Sideloadly 会按需自动改名。

## 测试要点(真机, 与 Android 版对齐)

1. 安装打开 → 设置 → 音源 → 自定义源管理, 出现「B站专属音源(手机版)」且状态
   `Successfully initialized`, 首次启动自动选中;
2. 搜索歌曲 → 播放 → 进度走动、无 403(验证 Referer + PC UA 生效, 重点观察
   AVPlayer 是否带 `AVURLAssetHTTPUserAgentKey`);
3. 锁屏/切后台继续播放(验证 UIBackgroundModes)、控制中心切歌暂停正常;
4. 杀进程重开 → 音源仍在、选中状态保持。

## 已知限制

- 手机版官方不支持下载; 无本地音频缓存;
- B站直链有时效(数小时), 失效后脚本自动重新解析(10 分钟内存缓存);
- 与 Android 版一致, 音源仅搜索/取链来自 B站, 歌词来自本地/内置;
- iOS 无法像安卓那样"未知来源直接装", 必须走侧载签名(见上表);
- 免费 Apple ID 证书 7 天过期, 到期重新侧载即可(设置数据保留)。
