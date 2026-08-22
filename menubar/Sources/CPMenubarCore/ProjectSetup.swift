import Foundation

// Adding a second project to a machine, after onboarding added the first. The two steps are the
// same two — clone it, then grant it — and they are in this order for the same reason: repos.json
// is what lets a worker bind a directory, so granting a checkout that does not exist, or one whose
// push was refused, produces a machine the board believes can work and which cannot.
public struct ProjectSetup: Sendable {
    private let clone: CloneStep
    private let repos: ReposFile

    public init(clone: CloneStep, repos: ReposFile) {
        self.clone = clone
        self.repos = repos
    }

    public enum Failure: Error, Equatable {
        case clone(reason: String)
        case grant(reason: String)
    }

    /// The path of the checkout this machine now has for that project.
    @discardableResult
    public func add(_ offer: ProjectOffer, parent: String) -> Result<String, Failure> {
        let projectKey = offer.key.isEmpty ? offer.project : offer.key
        switch clone.run(repositoryURL: offer.repositoryUrl, parent: parent, projectKey: projectKey) {
        case .failed(let reason):
            return .failure(.clone(reason: reason))
        case .cloned(let path), .reused(let path):
            do {
                var granted = (try? repos.read()) ?? []
                if !granted.contains(path) {
                    granted.append(path)
                    try repos.write(granted)
                }
                return .success(path)
            } catch {
                // The clone is on disk and the grant is not, which is recoverable by hand — say
                // where it is rather than leaving the operator to guess what half happened.
                return .failure(
                    .grant(reason: "Cloned to \(path), but could not write repos.json: \(error.localizedDescription)"))
            }
        }
    }
}
