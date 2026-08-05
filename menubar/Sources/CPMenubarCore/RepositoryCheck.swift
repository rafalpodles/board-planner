import Foundation

// Every one of these is a plausible first pick, and today each surfaces only as a string in the
// fleet console after the machine has already been enrolled. `bindRepository` refuses them for
// good reasons; saying so at the picker costs one sentence and saves the round trip.
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
    /// The path with every symlink resolved. Equal to the pick when there was nothing to resolve.
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

        // The worker resolves and compares real paths, so a symlinked pick is not the directory it
        // will end up working in — and the mismatch only shows up once it refuses to bind.
        if inspection.resolved != path {
            found.append(
                RepositoryProblem(
                    summary: "\(path) is a link to \(inspection.resolved).",
                    fix: "Pick \(inspection.resolved) instead."
                )
            )
        }

        // A package inside a monorepo has no .git of its own. The worker builds worktrees against a
        // repository toplevel, so this is the difference between working and refusing.
        if !inspection.hasGitDirectory {
            found.append(
                RepositoryProblem(
                    summary: "\(inspection.resolved) is not the top of a git repository.",
                    fix: "Pick the folder that contains .git — not a package inside it."
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

        // The agent runs with the operator's own rights inside this tree; anything group- or
        // world-writable widens who can change what it is about to execute.
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
