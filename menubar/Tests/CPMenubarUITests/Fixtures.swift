import Foundation
@testable import CPMenubar
@testable import CPMenubarCore

enum Fixtures {
    static let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    static func state(_ build: (inout WorkerState) -> Void = { _ in }) -> WorkerState {
        var state = WorkerState()
        build(&state)
        return state
    }

    static let idle = state()

    static let working = state {
        for (phase, tool) in [
            ("agent", ToolActivity(name: "Read", target: "menubar/Sources/CPMenubarCore/CloneStep.swift")),
            ("agent", ToolActivity(name: "Edit", target: "CloneStep.swift")),
            ("agent", ToolActivity(name: "Bash", target: "swift test --filter CloneStepTests")),
        ] {
            $0.apply(.progress(Progress(phase: phase, taskKey: "BP-1076", tool: tool)), at: t0)
        }
        $0.apply(.quota(Quota(status: "allowed_warning", utilization: 0.76, resetsAt: nil, rateLimitType: "seven_day")), at: t0)
    }

    static let needsHuman = state {
        $0.apply(.outcome(Outcome(outcome: "blocked", taskKey: "BP-1075", detail: "attempts exhausted")), at: t0)
    }

    static let faulted = state {
        $0.apply(.outcome(Outcome(outcome: "machineFault", taskKey: "BP-1075", detail: "the agent exited 1")), at: t0)
    }

    static let disconnected = state { $0.markDisconnected() }

    static let paused = state {
        $0.adopt(StatusResponse(paused: true, current: nil, recent: []), at: t0)
    }

    static let config: ConfigResponse = {
        let json = """
        {"apiUrl":"https://app.board-planner.com","workerName":"MAC","projectCount":3,"pollIntervalMs":30000,
         "githubAccount":"rafalpodles","githubAccounts":[{"login":"rafalpodles","active":true},{"login":"work","active":false}],
         "projects":[
          {"project":"p1","key":"BP","name":"Board Planner","baseBranch":"main","model":"opus","reviewModel":"sonnet","maxDiffLines":800,"taskTimeoutMs":1800000,"blocked":""},
          {"project":"p2","key":"FNV","name":"Fonvo","baseBranch":"main","model":"opus","reviewModel":"sonnet","maxDiffLines":800,"taskTimeoutMs":1800000,"blocked":"/Users/rpo/Documents/Projects/ClaudePlannerWorkspace/FNV has no package-lock.json, and the build gate runs npm ci, which fails without one"},
          {"project":"p3","key":"SB","name":"Ventures","baseBranch":"main","model":"opus","reviewModel":"sonnet","maxDiffLines":800,"taskTimeoutMs":1800000,"blocked":""}
         ]}
        """
        return try! JSONDecoder().decode(ConfigResponse.self, from: Data(json.utf8))
    }()

    static func preflight(claudeSignedIn: Bool) -> PreflightReport {
        let claude = claudeSignedIn
            ? #"{"name":"claude","ok":true,"detail":"signed in as rafal@example.com"}"#
            : #"{"name":"claude","ok":false,"detail":"Not signed in. Run claude auth login in a terminal, then check again."}"#
        let json = """
        {"ok":\(claudeSignedIn),"account":"rafalpodles","path":"/usr/bin","paths":{},
         "githubAccounts":[{"login":"rafalpodles","active":true},{"login":"work","active":false}],
         "githubAccount":"rafalpodles","githubPinned":true,
         "checks":[
          {"name":"git","ok":true,"detail":"/usr/bin/git"},
          {"name":"npm","ok":true,"detail":"/opt/homebrew/bin/npm"},
          \(claude),
          {"name":"gh","ok":true,"detail":"pinned to rafalpodles"},
          {"name":"commit identity","ok":true,"detail":"commits are authored as Rafał Podleś"},
          {"name":"sandbox","ok":true,"detail":"the agent can only write inside its own worktree"},
          {"name":"npm cache","ok":true,"detail":"/private/var/folders/cp-npm-cache-502"}
         ]}
        """
        return try! JSONDecoder().decode(PreflightReport.self, from: Data(json.utf8))
    }

    static func onboarding(step: OnboardingStep, userCode: String = "") -> OnboardingState {
        var state = OnboardingState()
        state.step = step
        state.apiURL = "https://app.board-planner.com"
        state.workerName = "MAC"
        state.checkoutsFolder = "/Users/rpo/Documents/Projects/ClaudePlannerWorkspace"
        state.userCode = userCode
        state.verificationURL = "https://app.board-planner.com/device"
        if step == .running { state.checkoutPath = "/Users/rpo/Documents/Projects/ClaudePlannerWorkspace/BP" }
        return state
    }
}
