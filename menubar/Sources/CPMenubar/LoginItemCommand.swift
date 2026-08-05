import Foundation

// Not a feature — a way to check, on this machine and from a script, what SMAppService actually
// does from inside a bundle. The PATH and login-item behaviour only appear in that configuration,
// and finding out during signing would mean finding out behind a blocker.
enum LoginItemCommand {
    static func runIfRequested() {
        let arguments = ProcessInfo.processInfo.arguments
        guard arguments.count > 1 else { return }

        switch arguments[1] {
        case "--login-item-status":
            print(LoginItem.statusDescription)
            print("registered: \(LoginItem.isRegistered)")
            print("bundle: \(Bundle.main.bundlePath)")
            exit(0)
        case "--register-login-item":
            do {
                try LoginItem.register()
                print("registered: \(LoginItem.statusDescription)")
                exit(0)
            } catch {
                print("failed: \(error)")
                exit(1)
            }
        case "--unregister-login-item":
            do {
                try LoginItem.unregister()
                print("unregistered: \(LoginItem.statusDescription)")
                exit(0)
            } catch {
                print("failed: \(error)")
                exit(1)
            }
        default:
            return
        }
    }
}
