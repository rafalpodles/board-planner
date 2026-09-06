import Foundation

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
                return .failure(
                    .grant(reason: "Cloned to \(path), but could not write repos.json: \(error.localizedDescription)"))
            }
        }
    }
}
