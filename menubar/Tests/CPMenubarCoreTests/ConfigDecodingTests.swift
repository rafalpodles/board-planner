import Foundation
import Testing
@testable import CPMenubarCore

// Byte-for-byte what worker/src/local-server.ts serves on GET /config, captured from a running
// worker. The app decodes this with `try?`, so a mismatch is not an error anybody sees — it is a
// config of nil, every field in Preferences reading "—", and no way to tell that from a worker
// that is simply not running. That is how a required `autoMerge` the worker had stopped sending
// went unnoticed, and why this fixture is a copy rather than a hand-written shape.
private let SERVED = """
{
  "apiUrl": "http://localhost:3958",
  "workerName": "rig-mac",
  "projectCount": 1,
  "pollIntervalMs": 15000,
  "projects": [
    {
      "project": "6a86bbe7c3cd8d57941081c6",
      "baseBranch": "main",
      "model": "opus",
      "reviewModel": "opus",
      "maxDiffLines": 400,
      "taskTimeoutMs": 1800000
    }
  ],
  "githubAccount": "rafalpodles",
  "githubAccounts": [
    { "login": "rafalpodles", "active": true },
    { "login": "podlesrafal", "active": false }
  ],
  "offers": [
    {
      "project": "6a86bbe7c3cd8d57941081c7",
      "key": "SBR",
      "name": "Sandbox Rig",
      "repositoryUrl": "/Users/rpo/bp-rig-375/origins/sandbox-rig.git"
    }
  ]
}
"""

@Test func decodesExactlyWhatTheWorkerServes() throws {
    let config = try JSONDecoder().decode(ConfigResponse.self, from: Data(SERVED.utf8))

    #expect(config.apiUrl == "http://localhost:3958")
    #expect(config.projects.count == 1)
    #expect(config.projects.first?.baseBranch == "main")
    #expect(config.offers?.count == 1)
    #expect(config.offers?.first?.label == "Sandbox Rig · SBR")
    #expect(config.githubAccount == "rafalpodles")
}

// A worker older than this app sends neither field. It must still decode, or upgrading the app
// before the worker takes the whole panel down.
@Test func decodesAWorkerThatKnowsNeitherOffersNorGithubAccounts() throws {
    let older = """
    {
      "apiUrl": "http://localhost:3958",
      "workerName": "rig-mac",
      "projectCount": 0,
      "pollIntervalMs": 30000,
      "projects": []
    }
    """

    let config = try JSONDecoder().decode(ConfigResponse.self, from: Data(older.utf8))

    #expect(config.offers == nil)
    #expect(config.githubAccounts == nil)
}
