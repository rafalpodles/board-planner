import Foundation

public struct RepositoryProblem: Equatable, Sendable {
    public let summary: String
    public let fix: String

    public init(summary: String, fix: String) {
        self.summary = summary
        self.fix = fix
    }
}

public struct RepositoryInspection: Sendable {
    public let exists: Bool
    public let isDirectory: Bool
    public let resolved: String
    public let hasGitDirectory: Bool
    public let posixPermissions: Int
    public let ownedByCurrentUser: Bool

    public init(
        exists: Bool,
        isDirectory: Bool,
        resolved: String,
        hasGitDirectory: Bool,
        posixPermissions: Int,
        ownedByCurrentUser: Bool
    ) {
        self.exists = exists
        self.isDirectory = isDirectory
        self.resolved = resolved
        self.hasGitDirectory = hasGitDirectory
        self.posixPermissions = posixPermissions
        self.ownedByCurrentUser = ownedByCurrentUser
    }
}

public enum RepositoryCheck {
    public static func problems(at path: String, _ inspection: RepositoryInspection) -> [RepositoryProblem] {
        var found: [RepositoryProblem] = []

        guard inspection.exists, inspection.isDirectory else {
            return [
                RepositoryProblem(
                    summary: "There is no folder at \(path).",
                    fix: "Pick a folder that exists."
                )
            ]
        }

        if inspection.resolved != path {
            found.append(
                RepositoryProblem(
                    summary: "\(path) is a link to \(inspection.resolved).",
                    fix: "Pick \(inspection.resolved) instead."
                )
            )
        }

        if inspection.hasGitDirectory {
            found.append(
                RepositoryProblem(
                    summary: "\(inspection.resolved) is itself a checkout.",
                    fix: "Pick the folder that holds your checkouts. The worker clones its own copy inside it."
                )
            )
        }

        if !inspection.ownedByCurrentUser {
            found.append(
                RepositoryProblem(
                    summary: "\(inspection.resolved) belongs to someone else.",
                    fix: "The worker runs as you, so pick a checkout you own."
                )
            )
        }

        if inspection.posixPermissions & 0o022 != 0 {
            found.append(
                RepositoryProblem(
                    summary: "\(inspection.resolved) can be written to by other users.",
                    fix: "Run chmod go-w on it, or pick a checkout only you can write to."
                )
            )
        }

        return found
    }

    public static func inspect(
        _ path: String,
        fileManager: FileManager = .default,
        currentUID: Int = Int(getuid())
    ) -> RepositoryInspection {
        var isDirectory: ObjCBool = false
        let exists = fileManager.fileExists(atPath: path, isDirectory: &isDirectory)
        let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        let attributes = (try? fileManager.attributesOfItem(atPath: path)) ?? [:]

        return RepositoryInspection(
            exists: exists,
            isDirectory: isDirectory.boolValue,
            resolved: resolved,
            hasGitDirectory: fileManager.fileExists(
                atPath: (resolved as NSString).appendingPathComponent(".git")),
            posixPermissions: (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0,
            ownedByCurrentUser: (attributes[.ownerAccountID] as? NSNumber)?.intValue == currentUID
        )
    }
}
