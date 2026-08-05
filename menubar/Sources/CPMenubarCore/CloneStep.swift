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

    public func run(repositoryURL: String, parent: String, projectKey: String) -> CloneOutcome {
        let target = CloneStep.destination(parent: parent, projectKey: projectKey)

        if exists((target as NSString).appendingPathComponent(".git")) {
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

        let cloned = run("git", ["clone", repositoryURL, target], nil)
        guard cloned.code == 0 else {
            return .failed(reason: "Could not clone \(repositoryURL): \(cloned.output)")
        }

        return pushable(at: target) ?? .cloned(path: target)
    }

    // The worker pushes to origin with --force-with-lease and has no notion of a fork, so read-only
    // access is a hard failure. Today it fails late — after the agent has worked and six gates have
    // passed — which is the worst possible moment to learn it.
    //
    // Known limit, measured rather than assumed: against a remote over https or ssh, --dry-run
    // contacts the server and a refusal really is caught here. Against a LOCAL path it does almost
    // nothing — a bare repository chmod'd read-only still reports success. Local paths are a
    // development case, so this is left as is rather than made to look stronger than it is.
    private func pushable(at path: String) -> CloneOutcome? {
        let probe = run("git", ["-C", path, "push", "--dry-run", "origin", "HEAD"], nil)
        guard probe.code != 0 else { return nil }
        return .failed(
            reason: "Cloned, but this machine cannot push to it: \(probe.output.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
}
