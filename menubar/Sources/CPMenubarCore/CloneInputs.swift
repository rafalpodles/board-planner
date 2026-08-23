import Foundation

/// The two values a clone is built out of both come from the server — `repositoryUrl` and the
/// project's key travel in the catalogue the app reads off the worker's socket — and both are spent
/// on the operator's own machine at their uid. This is the same boundary `worker/src/config.ts`
/// holds for the worker (BP-327), one package over.
public enum CloneInputs {
    /// Transports that carry a location and nothing else. `ext::` hands the URL to a program,
    /// `git://` reaches core.gitProxy, and a local path or `file://` makes the clone run
    /// git-upload-pack against a directory somebody else chose.
    private static let schemes = ["https://", "http://", "ssh://"]

    public static func isRemote(_ value: String) -> Bool {
        guard !value.isEmpty, !value.hasPrefix("-") else { return false }
        // A remote with whitespace in it is not one, and whitespace is how a second argument gets
        // smuggled into a value that some later caller splits
        guard value.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return false }
        if let scheme = schemes.first(where: { value.hasPrefix($0) }) {
            return value.count > scheme.count
        }
        return isScpLike(value)
    }

    /// `git@github.com:owner/repo.git` — no scheme, and the only other form people actually paste.
    private static func isScpLike(_ value: String) -> Bool {
        guard !value.contains("://"), let colon = value.firstIndex(of: ":") else { return false }
        let authority = value[value.startIndex..<colon]
        guard let at = authority.firstIndex(of: "@") else { return false }
        return !authority[authority.startIndex..<at].isEmpty
            && !authority[authority.index(after: at)...].isEmpty
            && !value[value.index(after: colon)...].isEmpty
    }

    /// One directory name, the same shape the worker demands of a task key. Not a path: the key
    /// decides where a checkout lands, and ProjectSetup then writes that path into repos.json,
    /// which is the allowlist deciding where the worker may run anything at all.
    public static func isProjectKey(_ value: String) -> Bool {
        guard let first = value.first, first.isASCII, first.isLetter || first.isNumber else {
            return false
        }
        return value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// Belt and braces behind isProjectKey. `NSString.appendingPathComponent` does not normalise
    /// "..", so a destination has to be judged after it is built rather than on the segment before.
    public static func isContained(_ target: String, in parent: String) -> Bool {
        let root = (parent as NSString).standardizingPath
        let resolved = (target as NSString).standardizingPath
        return resolved.hasPrefix(root.hasSuffix("/") ? root : root + "/")
    }
}
