import Foundation

// Which checkout belongs to which project. The socket deliberately never carries a path — where a
// checkout lives is the machine's own business — so the app answers this the same way the worker
// does: by comparing the project's repository address with each allowlisted checkout's `origin`.
//
// The comparison has to survive the forms of the same address that git accepts interchangeably:
// `git@github.com:owner/repo.git`, `https://github.com/owner/repo`, a trailing slash, a different
// case in the host. Getting this wrong in the lenient direction pairs a project with somebody
// else's checkout; getting it wrong in the strict direction offers a second clone of a repository
// the machine already has. This mirrors normaliseRemote in src/lib/repo-match.ts.
public enum RemoteMatch {
    public static func normalise(_ remote: String) -> String {
        var value = remote.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return "" }

        for scheme in ["ssh://", "git://", "https://", "http://"] where value.lowercased().hasPrefix(scheme) {
            value = String(value.dropFirst(scheme.count))
            break
        }
        // user@host — the user is not part of the identity of the repository
        if let at = value.firstIndex(of: "@"), !value[value.startIndex..<at].contains("/") {
            value = String(value[value.index(after: at)...])
        }
        // scp-like `host:owner/repo` becomes `host/owner/repo`. A port is left alone: it belongs
        // to the host, and folding it into the path would make two different servers look like one.
        if let colon = value.firstIndex(of: ":"), !value[value.startIndex..<colon].contains("/") {
            let after = value[value.index(after: colon)...]
            let startsWithPort = after.first?.isNumber == true
            if !startsWithPort {
                value = value.replacingCharacters(in: colon...colon, with: "/")
            }
        }
        while value.hasSuffix("/") { value = String(value.dropLast()) }
        if value.lowercased().hasSuffix(".git") { value = String(value.dropLast(4)) }

        return value.lowercased()
    }

    public static func same(_ a: String, _ b: String) -> Bool {
        let left = normalise(a)
        return !left.isEmpty && left == normalise(b)
    }
}
