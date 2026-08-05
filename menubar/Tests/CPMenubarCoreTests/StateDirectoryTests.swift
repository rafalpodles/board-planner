import Foundation
import Testing
@testable import CPMenubarCore

private func scratchDefaults() -> UserDefaults {
    let suite = UserDefaults(suiteName: "test-\(UUID().uuidString)")!
    return suite
}

@Test func fallsBackToTheConventionalDirectory() {
    let resolved = StateDirectory.resolve(
        defaults: scratchDefaults(), environment: [:], home: "/Users/someone")

    #expect(resolved == "/Users/someone/.claudeplanner")
}

@Test func readsTheEnvironmentWhenLaunchedFromAShell() {
    let resolved = StateDirectory.resolve(
        defaults: scratchDefaults(),
        environment: ["CP_STATE_DIR": "/rig/state"],
        home: "/Users/someone")

    #expect(resolved == "/rig/state")
}

// The case the whole type exists for: launched from Finder or a login item, there is no
// environment at all, and only a stored setting can point the app at a non-default worker.
@Test func prefersTheStoredSettingSoAFinderLaunchFindsTheSocket() {
    let defaults = scratchDefaults()
    StateDirectory.set("/operators/choice", defaults: defaults)

    let resolved = StateDirectory.resolve(
        defaults: defaults, environment: ["CP_STATE_DIR": "/rig/state"], home: "/Users/someone")

    #expect(resolved == "/operators/choice")
}

@Test func clearingTheSettingReturnsToTheEnvironmentAndThenTheDefault() {
    let defaults = scratchDefaults()
    StateDirectory.set("/operators/choice", defaults: defaults)
    StateDirectory.set(nil, defaults: defaults)

    #expect(StateDirectory.resolve(defaults: defaults, environment: [:], home: "/h")
            == "/h/.claudeplanner")
}

@Test func treatsAWhitespaceOnlySettingAsUnset() {
    let defaults = scratchDefaults()
    defaults.set("   ", forKey: StateDirectory.defaultsKey)

    #expect(StateDirectory.resolve(defaults: defaults, environment: [:], home: "/h")
            == "/h/.claudeplanner")
}

@Test func theSocketAndAllowlistSitInWhicheverDirectoryResolved() {
    let defaults = scratchDefaults()
    StateDirectory.set("/rig/state", defaults: defaults)

    #expect(SocketClient.socketPath(in: StateDirectory.resolve(defaults: defaults, environment: [:]))
            == "/rig/state/worker.sock")
    #expect(ReposFile.path(in: StateDirectory.resolve(defaults: defaults, environment: [:]))
            == "/rig/state/repos.json")
}
