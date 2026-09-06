import Foundation

public enum GitCheckoutKind: Equatable, Sendable {
    case repository
    case linkedWorktree
}

public enum LinkedWorktreeCheck {
    public static func kind(
        gitDir: (code: Int32, output: String),
        commonDir: (code: Int32, output: String),
        relativeTo path: String
    ) -> GitCheckoutKind? {
        guard gitDir.code == 0, commonDir.code == 0 else { return nil }

        let resolve: (String) -> String? = { answer in
            let trimmed = answer.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !trimmed.hasPrefix("-") else { return nil }
            let absolute = trimmed.hasPrefix("/")
                ? trimmed
                : (path as NSString).appendingPathComponent(trimmed)
            return ((absolute as NSString).standardizingPath as NSString).resolvingSymlinksInPath
        }

        guard let git = resolve(gitDir.output), let common = resolve(commonDir.output) else {
            return nil
        }
        return git == common ? .repository : .linkedWorktree
    }
}
