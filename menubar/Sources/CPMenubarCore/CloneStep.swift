import Foundation

public enum CloneOutcome: Equatable, Sendable {
    case cloned(path: String)
    case reused(path: String)
    case failed(reason: String)
}

public struct CloneStep: Sendable {
    public typealias Run = @Sendable (_ tool: String, _ args: [String], _ cwd: String?) -> (code: Int32, output: String)

    private let run: Run
    private let exists: @Sendable (String) -> Bool

    public init(
        run: @escaping Run,
        exists: @escaping @Sendable (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) {
        self.run = run
        self.exists = exists
    }

    public static func destination(parent: String, projectKey: String) -> String {
        (parent as NSString).appendingPathComponent(projectKey)
    }

    private static let safeTransport = [
        "-c", "protocol.ext.allow=never",
        "-c", "protocol.file.allow=never",
    ]

    public func run(repositoryURL: String, parent: String, projectKey: String) -> CloneOutcome {
        guard CloneInputs.isProjectKey(projectKey) else {
            return .failed(
                reason:
                    "Refusing the project key \(quoted(projectKey)): it has to be one directory name, not a path.")
        }
        guard CloneInputs.isRemote(repositoryURL) else {
            return .failed(
                reason:
                    "Refusing the remote \(quoted(repositoryURL)): only https, http and ssh remotes are cloned here.")
        }

        let target = CloneStep.destination(parent: parent, projectKey: projectKey)
        guard CloneInputs.isContained(target, in: parent) else {
            return .failed(reason: "Refusing \(target): it falls outside \(parent).")
        }

        if exists((target as NSString).appendingPathComponent(".git")) {
            let gitDir = run("git", ["-C", target, "rev-parse", "--git-dir"], nil)
            let commonDir = run("git", ["-C", target, "rev-parse", "--git-common-dir"], nil)
            switch LinkedWorktreeCheck.kind(gitDir: gitDir, commonDir: commonDir, relativeTo: target) {
            case .linkedWorktree:
                return .failed(
                    reason: "\(target) is a linked worktree of another checkout, not a repository of its own. Point this project at a folder of its own.")
            case nil:
                return .failed(
                    reason: "\(target) already exists, and git could not say whether it is a repository or one of another repository's worktrees.")
            case .repository:
                break
            }

            let remote = run("git", ["-C", target, "remote", "get-url", "origin"], nil)
            guard remote.code == 0 else {
                return .failed(reason: "\(target) already exists but is not a usable checkout.")
            }
            let fetched = run("git", ["-C", target, "fetch", "--quiet", "origin"], nil)
            guard fetched.code == 0 else {
                return .failed(reason: "\(target) exists but could not be fetched: \(fetched.output)")
            }
            return pushable(at: target) ?? .reused(path: target)
        }

        if exists(target) {
            return .failed(reason: "\(target) already exists and is not a checkout. Move it, or pick another folder.")
        }

        let cloned = run("git", CloneStep.safeTransport + ["clone", "--", repositoryURL, target], nil)
        guard cloned.code == 0 else {
            return .failed(reason: "Could not clone \(repositoryURL): \(cloned.output)")
        }

        return pushable(at: target) ?? .cloned(path: target)
    }

    private func quoted(_ value: String) -> String {
        value.isEmpty ? "(empty)" : "\"\(value)\""
    }

    private func pushable(at path: String) -> CloneOutcome? {
        let probe = run("git", ["-C", path, "push", "--dry-run", "origin", "HEAD"], nil)
        guard probe.code != 0 else { return nil }
        return .failed(
            reason: "Cloned, but this machine cannot push to it: \(probe.output.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
}
