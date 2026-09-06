import Foundation

public enum OnboardingStep: String, Codable, Sendable {
    case needsPreflight
    case needsFolder
    case awaitingApproval
    case starting
    case running
}

public struct OnboardingState: Codable, Equatable, Sendable {
    public var step: OnboardingStep
    public var apiURL: String
    public var workerName: String
    public var checkoutsFolder: String
    public var checkoutPath: String
    public var userCode: String
    public var verificationURL: String
    public var deviceCode: String
    public var workerID: String
    public var toolPath: String

    public init(
        step: OnboardingStep = .needsPreflight,
        apiURL: String = "",
        workerName: String = "",
        checkoutsFolder: String = "",
        checkoutPath: String = "",
        userCode: String = "",
        verificationURL: String = "",
        deviceCode: String = "",
        workerID: String = "",
        toolPath: String = ""
    ) {
        self.step = step
        self.apiURL = apiURL
        self.workerName = workerName
        self.checkoutsFolder = checkoutsFolder
        self.checkoutPath = checkoutPath
        self.userCode = userCode
        self.verificationURL = verificationURL
        self.deviceCode = deviceCode
        self.workerID = workerID
        self.toolPath = toolPath
    }

    public var isOnboarded: Bool { step == .running }
}

public enum Onboarding {
    public static let defaultsKey = "onboarding"

    public static func load(defaults: UserDefaults = .standard) -> OnboardingState {
        guard
            let data = defaults.data(forKey: defaultsKey),
            let state = try? JSONDecoder().decode(OnboardingState.self, from: data)
        else {
            return OnboardingState()
        }
        return state
    }

    public static func save(_ state: OnboardingState, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults.set(data, forKey: defaultsKey)
    }

    public static func reset(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: defaultsKey)
    }

    public static func preflightPassed(
        _ state: OnboardingState,
        apiURL: String,
        workerName: String,
        toolPath: String
    ) -> OnboardingState {
        var next = state
        next.apiURL = BoardURL.normalise(apiURL)
        next.workerName = workerName
        next.toolPath = toolPath
        if next.step == .needsPreflight { next.step = .needsFolder }
        return next
    }

    public static func folderChosen(_ state: OnboardingState, path: String) -> OnboardingState {
        var next = state
        next.checkoutsFolder = path
        if next.step == .needsFolder || next.step == .needsPreflight { next.step = .awaitingApproval }
        return next
    }

    public static func approvalStarted(
        _ state: OnboardingState,
        deviceCode: String,
        userCode: String,
        verificationURL: String
    ) -> OnboardingState {
        var next = state
        next.step = .awaitingApproval
        next.deviceCode = deviceCode
        next.userCode = userCode
        next.verificationURL = verificationURL
        return next
    }

    public static func approved(_ state: OnboardingState, workerID: String) -> OnboardingState {
        var next = state
        next.step = .starting
        next.workerID = workerID
        next.deviceCode = ""
        next.userCode = ""
        next.verificationURL = ""
        return next
    }

    public static func approvalAbandoned(_ state: OnboardingState) -> OnboardingState {
        var next = state
        next.deviceCode = ""
        next.userCode = ""
        next.verificationURL = ""
        next.step = .awaitingApproval
        return next
    }

    public static func cloned(_ state: OnboardingState, at path: String) -> OnboardingState {
        var next = state
        next.checkoutPath = path
        return next
    }

    public static func changingBoard(_ state: OnboardingState) -> OnboardingState {
        var next = state
        next.step = .needsFolder
        next.workerID = ""
        next.checkoutPath = ""
        next.userCode = ""
        next.deviceCode = ""
        next.verificationURL = ""
        return next
    }

    public static func started(_ state: OnboardingState) -> OnboardingState {
        var next = state
        next.step = .running
        return next
    }
}
