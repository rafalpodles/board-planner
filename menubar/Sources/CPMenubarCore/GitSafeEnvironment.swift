import Foundation

/// What a git the app spawns must not inherit. The counterpart of the worker's own hardening
/// (`worker/src/delivery.ts`), deliberately smaller.
///
/// `core.gitProxy` is the reason this exists at all rather than living in `-c` flags beside the
/// rest: git keeps the **first** value it is given for that key, so the operator's `~/.gitconfig`
/// outranks any command-line override. The environment is the one layer that wins, and an empty
/// value there means "no proxy" rather than "fall through to the config". Measured on git 2.50.1
/// through the app's own spawn path: a `url.*.insteadOf` rewriting `https://` to `git://` made a
/// plain, well-formed https remote reach a program of the config's choosing, and this stopped it.
///
/// The four `GIT_*` redirects are the BP-422 review's finding, and they cut both ways, measured
/// through this app's own spawn path: `GIT_COMMON_DIR` pointing elsewhere makes a healthy
/// repository read as a linked worktree and refuses to remove it, and `GIT_DIR` pointing at any
/// clean repository makes every question the removal guard asks get answered about *that* one
/// while the path it authorises for deletion is still the one it was given. A GUI launched from
/// Finder inherits none of them; a developer's terminal, and `swift run`, do.
///
/// `GIT_CEILING_DIRECTORIES` goes with them for the same reason (BP-734 review): naming a
/// superproject stops `--show-superproject-working-tree` looking one level up, which then answers
/// empty, exit 0, and a submodule reads as a repository of its own — measured.
///
/// Which config files git reads: the system file is dropped (`GIT_CONFIG_SYSTEM=/dev/null`, which
/// needs git 2.32 or later; that is `/etc/gitconfig`, or `$(prefix)/etc/gitconfig` on a Homebrew
/// git), while Apple git's vendor file beside its binary (`…/usr/share/git-core/gitconfig`, root-owned, carrying
/// `credential.helper=osxkeychain` and `init.defaultBranch=main`) and `~/.gitconfig` are read.
/// `GIT_CONFIG_NOSYSTEM` is removed rather than set, because on Apple git it drops the vendor file
/// too, and with it the only credential helper most operators have (BP-798, measured on
/// Apple git 2.54.0 and 2.50.1). A Homebrew git keeps its osxkeychain in the system file, so for the
/// clone step's git `credential.helper=osxkeychain` is put back on the command line, but only
/// when that git has no vendor file naming a helper, `git-credential-osxkeychain` is installed, and
/// the operator's global config — with its includes and the XDG file — names no helper at all. An
/// empty `credential.helper=` there is a deliberate reset and is respected: a second helper would be
/// handed every credential git stores, and write into the keychain what the operator kept out of it.
///
/// `~/.gitconfig` is left readable deliberately, which is where this parts company with the
/// worker: delivery drops it because the agent shares that filesystem, whereas this runs during
/// onboarding, and dropping it would take the operator's credential helper and any `core.sshCommand`
/// deploy key with it — at the one moment a failure is hardest to tell apart from a typo.
public enum GitSafeEnvironment {
    public static func apply(to environment: [String: String]) -> [String: String] {
        var hardened = environment
        hardened["GIT_CONFIG_SYSTEM"] = "/dev/null"
        hardened["GIT_PROXY_COMMAND"] = ""
        // Removed rather than emptied: an empty GIT_DIR is not "unset", it is a git dir named "".
        for redirect in [
            "GIT_CONFIG_NOSYSTEM", "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
            "GIT_CEILING_DIRECTORIES",
        ] {
            hardened.removeValue(forKey: redirect)
        }
        return hardened
    }

    public static func apply(to environment: [String: String], keychainHelper: Bool) -> [String: String] {
        var hardened = apply(to: environment)
        guard keychainHelper else { return hardened }
        let index = Int(hardened["GIT_CONFIG_COUNT"] ?? "") ?? 0
        hardened["GIT_CONFIG_COUNT"] = String(index + 1)
        hardened["GIT_CONFIG_KEY_\(index)"] = "credential.helper"
        hardened["GIT_CONFIG_VALUE_\(index)"] = "osxkeychain"
        return hardened
    }
}

public struct KeychainHelperProbe: Sendable {
    /// The scope of every credential helper git reads, URL-scoped ones such as the
    /// `credential.https://github.com.helper` that `gh auth setup-git` writes included, or nil when
    /// git could not answer.
    public typealias HelperScopes = @Sendable (_ git: String, _ environment: [String: String]) -> Set<String>?
    public typealias Check = @Sendable (_ git: String, _ environment: [String: String]) -> Bool

    public var helperScopes: HelperScopes
    public var osxkeychainInstalled: Check

    public init(helperScopes: @escaping HelperScopes, osxkeychainInstalled: @escaping Check) {
        self.helperScopes = helperScopes
        self.osxkeychainInstalled = osxkeychainInstalled
    }

    /// `unknown` is how git reports Apple's vendor file. `global` covers `~/.gitconfig`,
    /// `~/.config/git/config` and anything either includes, an empty reset among them.
    public func keychainHelperNeeded(git: String, environment: [String: String]) -> Bool {
        guard let scopes = helperScopes(git, environment) else { return false }
        return !scopes.contains("unknown") && !scopes.contains("global") && osxkeychainInstalled(git, environment)
    }

    // Each check only reads config or stats a file; none runs a credential helper.
    public static let live = KeychainHelperProbe(
        helperScopes: { git, environment in
            let answer = run(
                git, ["config", "--show-scope", "--get-regexp", #"^credential\.(.*\.)?helper$"#], environment)
            // Exit 1 is git's "no such key"; anything else but 0, an unreadable file included, is
            // taken as the operator having a say.
            guard answer.code == 0 || answer.code == 1 else { return nil }
            return Set(answer.output.split(separator: "\n").compactMap { line in
                line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init)
            })
        },
        osxkeychainInstalled: { git, environment in
            let execPath = run(git, ["--exec-path"], environment).output
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let onPath = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
            return ([execPath] + onPath).filter { !$0.isEmpty }.contains {
                FileManager.default.isExecutableFile(atPath: "\($0)/git-credential-osxkeychain")
            }
        }
    )

    private static func run(_ git: String, _ args: [String], _ environment: [String: String])
        -> (code: Int32, output: String)
    {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: git)
        process.arguments = args
        process.environment = environment
        process.currentDirectoryURL = FileManager.default.temporaryDirectory
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return (-1, "") }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }
}
