import Foundation

// Four things happen on a first run — a folder is chosen, a credential is obtained, the worker is
// started, and it is registered as a login item — and today none of them is recorded. Close the
// browser halfway and repos.json is already written while nothing else is, which is a state with
// no name and no way back. This is that name.
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
    /// Where the worker keeps its checkouts. Chosen by the operator; never a checkout itself.
    public var checkoutsFolder: String
    /// The clone the app made inside it, once there is one. Empty until the clone succeeds.
    public var checkoutPath: String
    public var userCode: String
    public var verificationURL: String
    // Held only while an approval is outstanding, and dropped the moment one arrives or is refused
    public var deviceCode: String
    public var workerID: String
    // The PATH `--preflight` resolved. Persisted because the worker has to be spawned with it on
    // every later launch too, not only the one where preflight happened to run.
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

// Every transition is a plain function over the state, so re-entering a step is re-running one of
// these rather than a sequence of side effects that half happened.
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
        // Stored in the form everything downstream needs, so there is one canonical value rather
        // than a raw one that each consumer has to remember to fix up
        next.apiURL = BoardURL.normalise(apiURL)
        next.workerName = workerName
        next.toolPath = toolPath
        // Only ever forward from the step it answers. A machine already running must not be walked
        // back to "pick a folder" because someone opened preflight again out of curiosity.
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
        // The device code is spent. Keeping it would leave a used secret in defaults for no reason.
        next.deviceCode = ""
        next.userCode = ""
        next.verificationURL = ""
        return next
    }

    // A refusal, an expiry, or a browser nobody came back to. The folder stays chosen, so trying
    // again costs one click rather than the whole flow.
    public static func approvalAbandoned(_ state: OnboardingState) -> OnboardingState {
        var next = state
        next.deviceCode = ""
        next.userCode = ""
        next.verificationURL = ""
        next.step = .awaitingApproval
        return next
    }

    /// The clone exists and a push has been shown to work. Only now is there something to run.
    public static func cloned(_ state: OnboardingState, at path: String) -> OnboardingState {
        var next = state
        next.checkoutPath = path
        return next
    }

    // Changing which board this machine answers to. Not `reset()`: the checkouts folder and the
    // resolved tool paths describe the machine, not the board, and asking for them again is asking
    // the operator to redo a setup that is still true. The address is kept as the starting point
    // for the field they are about to edit — it is the thing being changed, so it is the thing
    // worth showing.
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
