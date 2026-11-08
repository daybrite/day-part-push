import Foundation
import UIKit

func register_native(done: UInt64) throws {
    DispatchQueue.main.async {
        UIApplication.shared.registerForRemoteNotifications()
        register_native_complete(done, "")
    }
}
func unregister_native(done: UInt64) throws {
    DispatchQueue.main.async {
        UIApplication.shared.unregisterForRemoteNotifications()
        unregister_native_complete(done, "")
    }
}
