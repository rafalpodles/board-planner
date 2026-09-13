import Foundation

// The difference between what the operator picked and what this machine has, and the acting on it.
// The picking happens in a browser; this is the half that touches the disk.
//
// Split from the doing on purpose: what is about to happen is a value that can be shown before it
// happens and asserted about in a test, rather than a sequence of side effects nobody can see
// coming. That matters most for the deletions.

public struct SyncPlan: Equatable {
    public let add: [ProjectOffer]
    public let remove: [PlannedRemoval]

    public var isEmpty: Bool { add.isEmpty && remove.isEmpty }
}

public struct PlannedRemoval: Equatable {
    public let project: ProjectOffer
    /// The checkout this machine holds for it, resolved locally by remote — the socket never says
    /// where anything lives.
    public let path: String
}

public enum SyncStep: Equatable, Sendable {
    case added(project: String, path: String)
    case removed(project: String, path: String)
    /// The grant was dropped and the checkout directory was not deleted, because it had already
    /// gone. Distinct from `.removed` because telling an operator a directory was deleted when it
    /// was not is the kind of thing they only discover when they go looking for it.
    ///
    /// Says nothing about the checkout's worktrees. They can only have been deleted if the
    /// directory vanished between the guard and the act, which needs a race — but "nothing was
    /// deleted" would be a stronger claim than this case can make.
    case forgotten(project: String, path: String)
    /// A removal a guard said no to. Not a failure: the checkout is intact and the reason is one
    /// the operator can act on.
    case refused(project: String, reason: String)
    /// A removal the operator said no to when the app asked, on the machine, with the paths in
    /// front of them. Its own case rather than a `.refused` carrying a sentence: a guard saying no
    /// is a fact about the checkout, and this is a fact about the person. It also leaves the
    /// unticking standing — nothing is forgotten — so the next pass puts the same question again.
    case declined(project: String, paths: [String])
    /// A removal that deleted some of what it meant to and then stopped. Its own case rather than a
    /// `.failed` carrying a longer sentence, for the reason `.forgotten` is its own case: the
    /// difference between "nothing happened" and "some of it is gone" is the whole of what the
    /// operator has afterwards, and a message naming only the path that failed reads as the first
    /// while meaning the second.
    case partiallyRemoved(project: String, removed: [String], reason: String)
    case failed(project: String, reason: String)
    /// The machine was given projects and has nowhere to clone them.
    ///
    /// The guard itself is right — there is nowhere to put a checkout — but it used to return in
    /// silence, so the operator ticked a project, was told the app would pick it up, and then read
    /// a healthy fleet screen, an empty Repositories pane and a row that never connected. Every
    /// surface agreed that everything was fine (BP-602).
    case nowhereToPut(projects: [String], where: String)
}

/// Where the folder is set, named in the message rather than left for the operator to find.
///
/// The setup screen, and not a Preferences tab: `Preferences` has four — Connection, Repositories,
/// Policy, Advanced — and none of them writes `checkoutsFolder`. Its only writer is
/// `Onboarding.folderChosen`, reached from **2 · Where it keeps its checkouts** on the first-run
/// screen, which is what the panel shows until this machine is set up. A message naming a tab that
/// does not exist is worse than the silence BP-602 replaced (found in review).
public let checkoutsFolderLocation = "the setup screen, under \"Where it keeps its checkouts\""


public enum ProjectSync {
    /// `checkouts` maps an allowlisted path to the remote its `origin` reports.
    /**
     * The one step a pass can produce before it starts: it has work to do and nowhere to do it.
     *
     * In Core rather than in the runner because the runner is in the app target, which carries no
     * tests at all — a decision nothing can drive is a decision that quietly stops being made.
     *
     * Nil when the folder is set, and nil when there was nothing to act on either: a machine
     * nobody has given a project to is not misconfigured, it is unused.
     */
    public static func nowhereToPut(plan: SyncPlan, checkoutsFolder: String) -> SyncStep? {
        guard checkoutsFolder.trimmingCharacters(in: .whitespaces).isEmpty, !plan.isEmpty else {
            return nil
        }
        // Both halves of the plan: a removal needs no folder, but the pass returns before it too,
        // so a message naming only the clones would describe half of what did not happen.
        let projects = plan.add.map(\.name) + plan.remove.map(\.project.name)
        return .nowhereToPut(projects: projects, where: checkoutsFolderLocation)
    }

    /**
     * The steps a pass keeps once it has somewhere to clone to.
     *
     * `nowhereToPut` is the one step that is a **condition** rather than an event: every other line
     * in the pane records something that happened and stays true, while this one stops being true
     * the moment a folder is chosen. Dropped here rather than in the runner, for the reason the
     * decision above lives here — the app target has no tests.
     */
    public static func withoutNowhereToPut(_ steps: [SyncStep]) -> [SyncStep] {
        steps.filter { step in
            if case .nowhereToPut = step { return false }
            return true
        }
    }

    public static func plan(
        catalogue: [ProjectCatalogueRow],
        checkouts: [String: String]
    ) -> SyncPlan {
        var add: [ProjectOffer] = []
        var remove: [PlannedRemoval] = []

        for row in catalogue {
            let offer = ProjectOffer(
                project: row.project, key: row.key, name: row.name, repositoryUrl: row.repositoryUrl)
            let held = checkouts.first { RemoteMatch.same($0.value, row.repositoryUrl) }?.key

            if row.wanted {
                // A project with no repository cannot be cloned; the screen already shows it as
                // unavailable, and reaching for it here would be one failure per poll forever.
                guard row.available, held == nil else { continue }
                add.append(offer)
            } else if let held {
                remove.append(PlannedRemoval(project: offer, path: held))
            }
        }

        return SyncPlan(add: add, remove: remove)
    }
}

/// The catalogue row as the socket carries it. Declared here rather than in SocketClient so the
/// planning above can be tested without a transport.
public struct ProjectCatalogueRow: Decodable, Sendable, Equatable, Identifiable {
    public let project: String
    public let key: String
    public let name: String
    public let repositoryUrl: String
    public let available: Bool
    public let workersEnabled: Bool
    public let servedHere: Bool
    public let wanted: Bool
    public var id: String { project }

    public init(
        project: String, key: String, name: String, repositoryUrl: String,
        available: Bool, workersEnabled: Bool, servedHere: Bool, wanted: Bool
    ) {
        self.project = project
        self.key = key
        self.name = name
        self.repositoryUrl = repositoryUrl
        self.available = available
        self.workersEnabled = workersEnabled
        self.servedHere = servedHere
        self.wanted = wanted
    }

    public var label: String {
        if !name.isEmpty && !key.isEmpty { return "\(name) · \(key)" }
        if !name.isEmpty { return name }
        if !key.isEmpty { return key }
        return repositoryUrl
    }
}
