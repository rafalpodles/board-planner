import Foundation

public enum CloneOutcome: Equatable, Sendable {
    case cloned(path: String)
    case reused(path: String)
    case failed(reason: String)
}

// Registration hands back a credential before anything has been cloned, so a worker exists on the
// board before it can do a thing. That gap is the reason this step reports rather than assumes:
// the worker is not started until the clone exists AND a push has been shown to work. There is
// never one that looks ready and is not.
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

    /// `<parent>/<projectKey>`. Keyed on the project rather than the repository, so two projects
    /// sharing one repository get two clones — accepted deliberately, and worth saying out loud
    /// rather than pretending it does not happen.
    public static func destination(parent: String, projectKey: String) -> String {
        (parent as NSString).appendingPathComponent(projectKey)
    }

    /// `ext::` and `git://` are refused by CloneInputs before git is spawned; these close the same
    /// two transports from the other side, because a `url.*.insteadOf` in the operator's own config
    /// can rewrite a well-formed https remote into either and no check on the string would see it.
    /// `-c` beats a global setting for these keys — measured, unlike core.gitProxy, which does not
    /// and is emptied in the environment instead (GitSafeEnvironment).
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
            // A linked worktree has a `.git` too — a file rather than a directory, which `exists`
            // cannot tell apart — and it answers `remote get-url`, `fetch` and `push --dry-run`
            // exactly as its repository does. So every check below passes on one, and the app
            // adopts a directory it did not create, inside a repository it does not own, which
            // unticking the project would then delete along with that repository (BP-422).
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

            // Re-entering this step must not fail on its own earlier success
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

        // -- keeps both values in git's positional slots. The shape checks above are the gate; this
        // is the second line, so a caller that ever loosens one does not silently reopen the other.
        let cloned = run("git", CloneStep.safeTransport + ["clone", "--", repositoryURL, target], nil)
        guard cloned.code == 0 else {
            return .failed(reason: "Could not clone \(repositoryURL): \(cloned.output)")
        }

        return pushable(at: target) ?? .cloned(path: target)
    }

    private func quoted(_ value: String) -> String {
        value.isEmpty ? "(empty)" : "\"\(value)\""
    }

    // The worker pushes to origin with --force-with-lease and has no notion of a fork, so read-only
    // access is a hard failure. Today it fails late — after the agent has worked and six gates have
    // passed — which is the worst possible moment to learn it.
    //
    // Known limit, measured rather than assumed: against a remote over https or ssh, --dry-run
    // contacts the server and a refusal really is caught here. It did almost nothing against a
    // LOCAL path — a bare repository chmod'd read-only still reported success — and that gap is
    // now moot rather than fixed: BP-399 refuses a local path as a remote outright.
    private func pushable(at path: String) -> CloneOutcome? {
        let probe = run("git", ["-C", path, "push", "--dry-run", "origin", "HEAD"], nil)
        guard probe.code != 0 else { return nil }
        return .failed(
            reason: "Cloned, but this machine cannot push to it: \(probe.output.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
}
