import Testing
@testable import CPMenubarCore

@Test func readsTheVersionTheBundleWasStampedWith() {
    #expect(CPMenubarCore.version(from: ["CFBundleShortVersionString": "1.2.3"]) == "1.2.3")
}

@Test func saysItDoesNotKnowOutsideABundle() {
    #expect(CPMenubarCore.version(from: nil) == CPMenubarCore.unknownVersion)
    #expect(CPMenubarCore.version(from: ["CFBundleShortVersionString": " "]) == CPMenubarCore.unknownVersion)
}
