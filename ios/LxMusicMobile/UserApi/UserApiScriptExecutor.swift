//
//  UserApiScriptExecutor.swift
//  LxMusicMobile
//
//  iOS 版自定义音源脚本引擎。
//  移植自 Android 端 QuickJS.java + JavaScriptThread.java + JsHandler.java:
//  用 JavaScriptCore 的 JSContext 在独立串行队列上运行 user-api-preload.js + 音源脚本,
//  通过 __lx_native_call__ / __lx_native__ 字符串协议与 RN JS 侧交换消息,
//  事件形态(api-action 的 action/data/errorMessage/type/log)与 Android 完全一致。
//

import Foundation
import JavaScriptCore
import CryptoKit

@objc(UserApiScriptExecutor)
final class UserApiScriptExecutor: NSObject {

    /// 向 RN JS 侧发事件: (action, data, errorMessage, type, log), 除 action 外均可为 nil
    private let emitEvent: (String, String?, String?, String?, String?) -> Void

    /// 所有 JSContext 操作都在该串行队列上执行(对应 Android 的 JavaScriptThread)
    private let queue = DispatchQueue(label: "cn.toside.music.mobile.userapi.js")

    private var context: JSContext?

    /// 会话密钥(对应 Android 端 UUID), 防止串扰
    private let key = UUID().uuidString

    /// 脚本是否已发送过 init 事件(对应 Android QuickJS.java 的 inited)
    private var inited = false

    init(emitEvent: @escaping (String, String?, String?, String?, String?) -> Void) {
        self.emitEvent = emitEvent
        super.init()
    }

    // MARK: - 对外接口(由 UserApiModule 调用, 线程安全)

    func loadScript(info: [String: Any]) {
        let id = info["id"] as? String ?? ""
        let name = info["name"] as? String ?? "Unknown"
        let description = info["description"] as? String ?? ""
        let version = info["version"] as? String ?? ""
        let author = info["author"] as? String ?? ""
        let homepage = info["homepage"] as? String ?? ""
        let script = info["script"] as? String ?? ""

        queue.async { [weak self] in
            guard let self = self else { return }
            self.inited = false
            self.context = nil

            guard let jsContext = JSContext() else {
                self.emitInitFailed("Create JavaScript Env Failed")
                return
            }
            self.context = jsContext
            // 异常统一在调用点检查 context.exception 上报, 这里只负责兜底避免泄漏
            jsContext.exceptionHandler = { _, _ in }

            self.installConsole(jsContext)
            self.installNativeFunctions(jsContext)

            // 1) 注入 preload(定义 lx_setup / __lx_native__ 及 lx 对象构建逻辑)
            jsContext.evaluateScript(UserApiPreload.script)
            if self.checkException() { return }

            // 2) 调用 lx_setup(key, id, name, description, version, author, homepage, rawScript)
            let setup = jsContext.objectForKeyedSubscript("lx_setup")
            setup?.call(withArguments: [
                self.key, id, name, description, version, author, homepage, script,
            ])
            if self.checkException() { return }

            // 3) 执行音源脚本(脚本内部 lx.on('request') + lx.send('inited'))
            jsContext.evaluateScript(script)
            if self.checkException() { return }

            self.emitLog(type: "info", message: "UserApi script loaded.")
        }
    }

    /// RN JS 侧 sendAction 透传: 调用脚本环境里的 __lx_native__(key, action, data)
    func callJS(action: String, data: String?) {
        queue.async { [weak self] in
            guard let self = self, let context = self.context else { return }
            guard let fn = context.objectForKeyedSubscript("__lx_native__") else { return }
            var args: [Any] = [self.key, action]
            if let data = data { args.append(data) }
            fn.call(withArguments: args)
            self.checkException()
        }
    }

    func destroy() {
        queue.async { [weak self] in
            self?.context = nil
        }
    }

    // MARK: - 内部实现

    /// 检查并上报 JS 异常; 返回是否发生了异常
    @discardableResult
    private func checkException() -> Bool {
        guard let context = context, let exc = context.exception else { return false }
        context.exception = nil
        let message = String(exc.toString() ?? "Unknown JavaScript error")
        emitLog(type: "error", message: message)
        if !inited {
            inited = true
            emitInitFailed(message)
        }
        return true
    }

    /// console.log/info/warn/error → api-action 的 log 事件(对应 Android Console.java)
    private func installConsole(_ context: JSContext) {
        // 通过 JS 侧建空对象再取回, 兼容不同 SDK 版本下 JSValue 工厂方法的可空性差异
        context.evaluateScript("var __lx_console__ = {};")
        let console = context.objectForKeyedSubscript("__lx_console__")
        let makeLog: (String) -> (@convention(block) (JSValue?) -> Void) = { [weak self] type in
            return { [weak self] value in
                guard let self = self else { return }
                let message = value?.toString() ?? "undefined"
                self.emitLog(type: type, message: message)
            }
        }
        console?.setValue(makeLog("log"), forProperty: "log")
        console?.setValue(makeLog("info"), forProperty: "info")
        console?.setValue(makeLog("warn"), forProperty: "warn")
        console?.setValue(makeLog("error"), forProperty: "error")
        context.setObject(console, forKeyedSubscript: "console" as NSString)
    }

    /// 注入 preload 依赖的原生函数(对应 Android QuickJS.java 的 createEnvObj)
    private func installNativeFunctions(_ context: JSContext) {
        // __lx_native_call__(key, action, data): JS → 原生发消息
        let nativeCall: @convention(block) (JSValue?, JSValue?, JSValue?) -> Void = { [weak self] k, action, data in
            guard let self = self,
                  let k = k?.toString(), k == self.key,
                  let action = action?.toString() else { return }
            if action == "init" {
                if self.inited { return }
                self.inited = true
            }
            self.emitEvent(action, data?.toString(), nil, nil, nil)
        }

        // 定时器: 与 Android 一致, clearTimeout 只在 JS 侧删回调,
        // 原生定时器到点照常触发(回调已被删 → preload 里 no-op)
        let setNativeTimeout: @convention(block) (JSValue?, JSValue?) -> Void = { [weak self] idValue, msValue in
            guard let self = self,
                  let id = idValue?.toString(),
                  let ms = msValue?.toNumber().doubleValue else { return }
            let when = DispatchTime.now() + .milliseconds(max(0, Int(ms)))
            DispatchQueue.main.asyncAfter(deadline: when) { [weak self] in
                self?.callJS(action: "__set_timeout__", data: id)
            }
        }

        // utils: 字符串 → base64
        let utilsStr2B64: @convention(block) (JSValue?) -> String = { value in
            guard let str = value?.toString() else { return "" }
            return Data(str.utf8).base64EncodedString()
        }

        // utils: base64 → 字节数组的 JSON 字符串(如 "[1,2,3]")
        let utilsB642Buf: @convention(block) (JSValue?) -> String = { value in
            guard let str = value?.toString(), let data = Data(base64Encoded: str) else { return "" }
            return "[" + data.map { String($0) }.joined(separator: ",") + "]"
        }

        // utils: 字符串 → MD5(对应 Java 端先 URLDecoder.decode 再对 UTF-8 字节取 MD5)
        let utilsStr2MD5: @convention(block) (JSValue?) -> String = { value in
            guard let raw = value?.toString() else { return "" }
            let str = raw.removingPercentEncoding ?? raw
            guard let data = str.data(using: .utf8) else { return "" }
            let digest = Insecure.MD5.hash(data: data)
            return digest.map { byte -> String in
                let hex = String(byte, radix: 16)
                return hex.count == 1 ? "0" + hex : hex
            }.joined()
        }

        // utils: AES/RSA 加密 —— B站音源不用, 与 Android 失败时返回空串保持兼容
        let utilsAesEncrypt: @convention(block) (JSValue?, JSValue?, JSValue?, JSValue?) -> String = { _, _, _, _ in "" }
        let utilsRsaEncrypt: @convention(block) (JSValue?, JSValue?, JSValue?) -> String = { _, _, _ in "" }

        context.setObject(nativeCall, forKeyedSubscript: "__lx_native_call__" as NSString)
        context.setObject(setNativeTimeout, forKeyedSubscript: "__lx_native_call__set_timeout" as NSString)
        context.setObject(utilsStr2B64, forKeyedSubscript: "__lx_native_call__utils_str2b64" as NSString)
        context.setObject(utilsB642Buf, forKeyedSubscript: "__lx_native_call__utils_b642buf" as NSString)
        context.setObject(utilsStr2MD5, forKeyedSubscript: "__lx_native_call__utils_str2md5" as NSString)
        context.setObject(utilsAesEncrypt, forKeyedSubscript: "__lx_native_call__utils_aes_encrypt" as NSString)
        context.setObject(utilsRsaEncrypt, forKeyedSubscript: "__lx_native_call__utils_rsa_encrypt" as NSString)
    }

    private func emitLog(type: String, message: String) {
        emitEvent("log", nil, nil, type, message)
    }

    private func emitInitFailed(_ errorMessage: String) {
        // 与 Android JsHandler.sendInitFailedEvent 完全一致:
        // action=init + 顶层 errorMessage + 固定 JSON data(JS 侧会用顶层 errorMessage 覆盖 data.errorMessage)
        emitEvent(
            "init",
            "{\"info\":null,\"status\":false,\"errorMessage\":\"Create JavaScript Env Failed\"}",
            errorMessage,
            nil,
            nil
        )
    }
}
