import Foundation

public struct SyncPlan: Equatable {
    public let add: [ProjectOffer]
    public let remove: [PlannedRemoval]

    public var isEmpty: Bool { add.isEmpty && remove.isEmpty }
}

public struct PlannedRemoval: Equatable {
    public let project: ProjectOffer
    public let path: String
}

public enum SyncStep: Equatable {
    case added(project: String, path: String)
    case removed(project: String, path: String)
    case forgotten(project: String, path: String)
    case refused(project: String, reason: String)
    case partiallyRemoved(project: String, removed: [String], reason: String)
    case failed(project: String, reason: String)
}

public enum ProjectSync {
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
                guard row.available, held == nil else { continue }
                add.append(offer)
            } else if let held {
                remove.append(PlannedRemoval(project: offer, path: held))
            }
        }

        return SyncPlan(add: add, remove: remove)
    }
}

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
