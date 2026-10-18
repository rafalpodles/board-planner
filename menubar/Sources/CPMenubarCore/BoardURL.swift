import Foundation

// People type "localhost:3973", or "board.example.com" — not "https://board.example.com". Swift
// reads the first as scheme "localhost" with no host at all, so the request goes nowhere and fails
// with a message naming neither the address nor the reason. Normalising is the difference between
// "it doesn't work" and it working.
public enum BoardURL {
    public static func normalise(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }

        let withoutTrailingSlash = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        if withoutTrailingSlash.contains("://") { return withoutTrailingSlash }

        // A board on this machine is what a dev server serves, over plain HTTP. Anything else is
        // assumed to want TLS — the only safe default for an address that leaves the machine.
        // Note this only ever *adds* a scheme: an explicit https:// is never quietly downgraded.
        let host = withoutTrailingSlash.split(separator: "/").first.map(String.init) ?? withoutTrailingSlash
        let bare = host.split(separator: ":").first.map(String.init) ?? host
        let isLocal = bare == "localhost" || bare == "127.0.0.1" || bare == "::1" || bare.hasSuffix(".local")

        return (isLocal ? "http://" : "https://") + withoutTrailingSlash
    }

    /// The task's page on the board, from a key like `BP-1075`. Nil for anything that is not
    /// `PROJECT-NUMBER`, so a malformed key never becomes a link.
    public static func task(apiURL: String, key: String) -> URL? {
        let board = normalise(apiURL)
        guard !board.isEmpty, let dash = key.lastIndex(of: "-") else { return nil }
        let project = String(key[..<dash])
        let number = String(key[key.index(after: dash)...])
        guard !project.isEmpty, project.allSatisfy({ $0.isLetter || $0.isNumber }),
            !number.isEmpty, number.allSatisfy(\.isNumber)
        else { return nil }
        return URL(string: "\(board)/projects/\(project)/tasks/\(number)")
    }
}
