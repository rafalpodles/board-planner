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

public enum SyncStep: Equatable {
    case added(project: String, path: String)
    case removed(project: String, path: String)
    /// A removal a guard said no to. Not a failure: the checkout is intact and the reason is one
    /// the operator can act on.
    case refused(project: String, reason: String)
    case failed(project: String, reason: String)
}

public enum ProjectSync {
    /// `checkouts` maps an allowlisted path to the remote its `origin` reports.
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
