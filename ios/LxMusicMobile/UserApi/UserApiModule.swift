//
//  UserApiModule.swift
//  LxMusicMobile
//
//  RN 桥模块(对应 Android 端 UserApiModule.java):
//  - loadScript(info)  加载并运行自定义音源脚本
//  - sendAction(action, info)  向脚本环境投递消息(字符串协议, 与 Android 一致)
//  - destroy()  销毁脚本环境
//  脚本侧消息通过事件 "api-action" 上报, 事件形态与 Android UtilsEvent 完全一致。
//

import Foundation
import React

@objc(UserApiModule)
final class UserApiModule: RCTEventEmitter {

    private var executor: UserApiScriptExecutor?

    @objc
    override static func requiresMainQueueSetup() -> Bool {
        return false
    }

    @objc
    override func supportedEvents() -> [String]! {
        return ["api-action"]
    }

    @objc(loadScript:)
    func loadScript(_ data: NSDictionary) {
        let executor = UserApiScriptExecutor { [weak self] action, data, errorMessage, type, log in
            guard let self = self else { return }
            var body: [String: Any] = ["action": action]
            if let data = data { body["data"] = data }
            if let errorMessage = errorMessage { body["errorMessage"] = errorMessage }
            if let type = type { body["type"] = type }
            if let log = log { body["log"] = log }
            self.sendEvent(withName: "api-action", body: body)
        }
        self.executor = executor
        executor.loadScript(info: (data as? [String: Any]) ?? [:])
    }

    @objc(sendAction:info:)
    func sendAction(_ action: String, _ info: String) {
        executor?.callJS(action: action, data: info)
    }

    @objc(destroy)
    func destroy() {
        executor?.destroy()
        executor = nil
    }
}
