# CP-161 part C — the menubar app

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the worker an operator cockpit — a SwiftUI `MenuBarExtra` that reads the local socket
part B built, shows whether the run is stuck or working, raises a notification when a run ends, and
lets the operator pause, stop and manage the repository allowlist.

**Architecture:** The app is a **pure client of `${CP_STATE_DIR}/worker.sock`** and holds no server
credential. Everything it displays arrives over that socket; everything it changes is either a
fail-safe worker command (`pause`/`resume`/`stop`) or a file the operator already owns
(`repos.json`). All logic lives in plain testable types — transport, decoder, reducer, notifier —
and the SwiftUI layer is a thin renderer over a single observable state.

**Tech Stack:** Swift 6.3, SwiftUI `MenuBarExtra`, `Network.framework` (`NWEndpoint.unix`),
`UserNotifications`, swift-testing, SwiftPM. Worker-side changes are TypeScript + vitest.

---

## Scope decision, stated up front

The spec's preferences window has four tabs: Connection (URL + **credential in Keychain**),
Repositories, Policy (**per project, inherited vs overridden**), Advanced. Two of those need the app
to hold a Board Planner credential and call the REST API.

**This plan does not give the app a credential.** Reasons, in order of weight:

1. **C4 is still open.** Worker registration is `withAdmin`, so any credential minted for this
   machine is an instance-admin credential. Handing a second copy to a second process — one with a
   GUI, a login item and an auto-update story — widens the blast radius of a decision rpo has
   explicitly parked. The app is the wrong place to pre-empt it.
2. **The spec's own core split says so.** "Loud data stays local, durable data goes to the server."
   Configuration is durable data; the web console already owns it.
3. It keeps part C unblocked. Everything below can ship and be verified live today.

What this costs, honestly:

- **Checklist item 10 lands partially.** Connection, Repositories and Advanced are real; **Policy
  becomes read-only** — the app shows the effective policy the worker is running under, read from a
  new `GET /config` socket route, and says where to change it.
- **Checklist item 3 ("inherited vs overridden in the UI") is not part C's job.** It belongs to the
  web console at `settings/workers`, and is scheduled in the gap-closing phase after this plan.

If rpo decides C4 in favour of a one-time enrolment credential, the Connection tab gains write
access as a follow-up — the transport, the state model and the window all already exist by then.

---

## Global Constraints

- **Swift 6.3**, macOS 26 SDK. Toolchain verified on this machine: Xcode 26.6, swift-driver 1.148.6,
  SDK 26.5.
- **No third-party Swift dependencies.** `Network.framework` and `UserNotifications` are in the OS.
- **The app never opens a TCP socket and never resolves a hostname.** Its only I/O is the unix
  socket and `repos.json`.
- Socket path: `${CP_STATE_DIR}/worker.sock`, default `~/.boardplanner/worker.sock`
  (`worker/src/config.ts:117`, `:125`).
- **`CP_CONCURRENCY` is not exposed** anywhere in the UI — the loop is sequential.
- Comments follow the repo rule: none by default; only a one-liner for a genuine workaround.
- Conventional commits, English. No `Co-Authored-By`, no generated-by footer.
- Worker-side (TypeScript) tasks run `cd worker && npm test`; the root suite is `npm test`.
- Swift tasks run `cd menubar && swift test`.

---

## What already exists, and is not to be rebuilt

Read these before Task 1; the plan depends on their exact shapes.

**Socket routes** (`worker/src/local-server.ts:85-94`):

| Route | Response |
|---|---|
| `GET /status` | `{ paused: boolean, current: Progress \| null, recent: Progress[] }` |
| `GET /stream` | SSE, `data: <TelemetryUpdate>\n\n` per event |
| `POST /pause` / `POST /resume` / `POST /stop` | `{ paused: boolean }` |

**Telemetry shapes** (`worker/src/telemetry.ts:3-24`):

```ts
type Phase = "claiming" | "worktree" | "agent" | "push" | "pr" | "merge" | `gates:${string}`;
interface ToolActivity { name: string; target?: string }
interface Progress { phase: Phase; tool?: ToolActivity; turns?: number; costUsd?: number }
interface Quota { status: "allowed" | "allowed_warning" | "rejected"; utilization?: number;
                  resetsAt?: number; rateLimitType?: string }
type TelemetryUpdate = Progress | Quota;
```

`isQuota(u)` discriminates on `"status" in u`. The `recent()` ring holds **only** `Progress`
(`telemetry.ts:149`).

**Two facts that shape Tasks 1 and 2:**

- `GET /stream` **drops every `Quota`** (`local-server.ts:73`). The usage-limit notification the
  checklist asks for therefore cannot be built until that stops.
- Telemetry carries **phases, not outcomes**. "merged", "gate rejected" and "needs human review" are
  reported to the *server* by `worker/src/reporter.ts` and never reach the socket. Three of the four
  required notifications have no local source today.

**The task card's missing fields are settled, not open.** The spec (`### Task card`) refuses "last
error" because `execution.lastError` is only ever written as `""`
(`src/lib/task-service.ts:610`), and refuses "attempt 2 of 3" because `attempts` is decremented on
refund and so is a budget, not an ordinal. Do not add either to the app.

---

## File Structure

**Worker (TypeScript), modified:**

- `worker/src/telemetry.ts` — gains the `Outcome` update variant and `isOutcome`; `emit` keeps the
  ring `Progress`-only.
- `worker/src/local-server.ts` — stops filtering non-`Progress` updates out of `/stream`; gains
  `GET /config`.
- `worker/src/pipeline.ts` — emits an `Outcome` beside each terminal `reporter.*` call.
- `worker/src/wiring.ts` — passes the effective config into `startLocalServer`.

**App (Swift), created — `menubar/`:**

| File | Responsibility |
|---|---|
| `Package.swift` | SPM manifest, two targets |
| `Sources/CPMenubarCore/UnixHTTP.swift` | `Transport` protocol + `NWConnection` implementation; one request, one response |
| `Sources/CPMenubarCore/TelemetryEvent.swift` | The wire union and its `Decodable` conformance |
| `Sources/CPMenubarCore/SocketClient.swift` | `/status`, `/stream` SSE framing, the three commands |
| `Sources/CPMenubarCore/WorkerState.swift` | Reduces events into `Health`, icon, title, stepper rows |
| `Sources/CPMenubarCore/ReposFile.swift` | Reads and writes `repos.json` at 0600 |
| `Sources/CPMenubarCore/Notifier.swift` | Maps outcomes and quota to notification requests |
| `Sources/CPMenubar/CPMenubarApp.swift` | `@main`, `MenuBarExtra`, `Settings` scene |
| `Sources/CPMenubar/PanelView.swift` | Health header, current task, stepper, actions, controls, tally |
| `Sources/CPMenubar/PreferencesView.swift` | Four tabs |
| `Sources/CPMenubar/AppModel.swift` | `@Observable` bridge: owns `SocketClient`, feeds `WorkerState` |
| `Tests/CPMenubarCoreTests/*.swift` | swift-testing suites, one per core file |
| `menubar/Makefile` | `make app` assembles `CPMenubar.app` |
| `menubar/README.md` | Build, install, where the socket is |

Everything in `CPMenubarCore` is platform-agnostic logic with no SwiftUI import — that is what makes
it testable. `CPMenubar` is the shell and is not unit-tested; it is verified live.

---

### Task 1: `Outcome` telemetry, so notifications have a local source

**Files:**
- Modify: `worker/src/telemetry.ts`
- Modify: `worker/src/pipeline.ts`
- Test: `worker/src/telemetry.test.ts`, `worker/src/pipeline.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Outcome`, `isOutcome(update): update is Outcome`, `TelemetryUpdate = Progress | Quota |
  Outcome`, and `Progress.taskKey?: string`. Task 2 forwards these; Task 5 decodes them; Tasks 7 and
  9 render them.

**Why `Progress` gains `taskKey`:** the spec's menu bar title is `CP-161 · build 1:42`, and today a
`Progress` names a phase but never says whose. `runTask(deps, task)` has `task.taskKey` in scope from
its first line (`pipeline.ts:109`), so the emit site already holds it.

- [ ] **Step 1: Write the failing test**

In `worker/src/telemetry.test.ts`:

```ts
describe("outcome updates", () => {
  it("discriminates an outcome from a progress and a quota", () => {
    const outcome: TelemetryUpdate = { outcome: "merged", taskKey: "CP-1" };
    expect(isOutcome(outcome)).toBe(true);
    expect(isOutcome({ phase: "agent" })).toBe(false);
    expect(isOutcome({ status: "allowed" })).toBe(false);
  });

  it("keeps outcomes out of the recent ring, which is progress only", () => {
    const telemetry = createTelemetry();
    telemetry.emit({ phase: "agent" });
    telemetry.emit({ outcome: "merged", taskKey: "CP-1" });
    expect(telemetry.recent()).toEqual([{ phase: "agent" }]);
  });

  it("delivers an outcome to subscribers", () => {
    const telemetry = createTelemetry();
    const seen: TelemetryUpdate[] = [];
    telemetry.subscribe((u) => seen.push(u));
    telemetry.emit({ outcome: "gateRejected", taskKey: "CP-1", detail: "build" });
    expect(seen).toEqual([{ outcome: "gateRejected", taskKey: "CP-1", detail: "build" }]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd worker && npx vitest run src/telemetry.test.ts`
Expected: FAIL — `isOutcome is not exported` / type errors on the `outcome` literal.

- [ ] **Step 3: Implement in `telemetry.ts`**

Widen `Progress` first:

```ts
export interface Progress {
  phase: Phase;
  taskKey?: string;
  tool?: ToolActivity;
  turns?: number;
  costUsd?: number;
}
```

Optional, not required: `summarise()` builds a `Progress` from an agent stream event and has no task
in scope, so making it required would break every call site for no gain.

Then add above `TelemetryUpdate`:

```ts
export type OutcomeKind =
  | "merged"
  | "gateRejected"
  | "blocked"
  | "released"
  | "requeued"
  | "failed";

export interface Outcome {
  outcome: OutcomeKind;
  taskKey: string;
  detail?: string;
}

export type TelemetryUpdate = Progress | Quota | Outcome;

export function isOutcome(update: TelemetryUpdate): update is Outcome {
  return "outcome" in update;
}
```

`isQuota` must stop being the negation of `Progress`. It already tests `"status" in update`, which
an `Outcome` does not have, so it needs no change — but the ring guard does:

```ts
function emit(update: TelemetryUpdate): void {
  if (!isQuota(update) && !isOutcome(update)) {
    ring.push(update);
    if (ring.length > RECENT_LIMIT) ring.shift();
  }
  // ... unchanged
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd worker && npx vitest run src/telemetry.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing pipeline test**

The point is that every terminal path emits exactly one outcome. In `worker/src/pipeline.test.ts`,
alongside the existing pipeline tests, using the file's existing harness:

```ts
it("emits a merged outcome when the run completes", async () => {
  const updates: TelemetryUpdate[] = [];
  telemetry.subscribe((u) => updates.push(u));
  await runTask(/* the harness's happy path */);
  expect(updates.filter(isOutcome)).toEqual([{ outcome: "merged", taskKey: "CP-1" }]);
});

it("emits a gateRejected outcome carrying the gate name", async () => {
  const updates: TelemetryUpdate[] = [];
  telemetry.subscribe((u) => updates.push(u));
  await runTask(/* the harness's rejecting-gate path */);
  expect(updates.filter(isOutcome)).toEqual([
    { outcome: "gateRejected", taskKey: "CP-1", detail: "build" },
  ]);
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `cd worker && npx vitest run src/pipeline.test.ts`
Expected: FAIL — the filtered array is empty.

- [ ] **Step 7: Emit beside every reporter call**

In `pipeline.ts:115`, widen `enter` so every phase names its task, and add `settle` beside it:

```ts
const enter = (phase: Phase): void => telemetry?.emit({ phase, taskKey: task.taskKey });

const settle = (outcome: OutcomeKind, detail?: string): void =>
  telemetry?.emit(detail === undefined
    ? { outcome, taskKey: task.taskKey }
    : { outcome, taskKey: task.taskKey, detail: scrub(detail).slice(0, 200) });
```

`task.taskKey` — **not** `task.key`; `ClaimedTask` has no `key`. `scrub` is already imported in this
file (it is used at `:126`), so no new import.

Then place one `settle(...)` immediately **before** each terminal `reporter.*` call already in the
file — before, so a reporter that throws does not swallow the operator's notification:

| Line today | Call | `settle` |
|---|---|---|
| `:104` | `reporter.requeued` / `reporter.released` (stop path) | `settle(stoppedByProcessSignal ? "requeued" : "released")` |
| `:141` | `reporter.requeued` (worktree) | `settle("requeued", "could not create a worktree")` |
| `:159` | `reporter.released` (usage limit) | `settle("released", "usage limit reached")` |
| `:163` | `reporter.requeued` (timeout) | `settle("requeued", "the run timed out")` |
| `:167` | `reporter.requeued` (outcome message) | `settle("requeued", outcome.message)` |
| `:171` | `reporter.blocked` | `settle("blocked", outcome.result.blockedReason)` |
| `:178` | `reporter.failed` | `settle("failed")` |
| `:197` | `reporter.released` (gate could not run) | `settle("released", `the ${gate.name} gate could not run`)` |
| `:204` | `reporter.gateRejected` | `settle("gateRejected", gate.name)` |
| `:251` | `reporter.failed` (merge) | `settle("failed", "the merge did not land")` |
| `:258` | `reporter.merged` | `settle("merged")` |
| `:260` | `reporter.requeued` (unexpected) | `settle("requeued", "unexpected error")` |

Agent- and gate-authored text reaches a Notification Center database that outlives the run, so it
goes through the same redaction as board-bound text. 200 characters is a notification body, not a
report.

Two existing assertions will now see `taskKey` on every `Progress`. Update the **assertions**, never
the implementation — this branch has already been burned once by a test edited to match broken code.

- [ ] **Step 8: Run the worker suite**

Run: `cd worker && npm test`
Expected: PASS, including the two new pipeline tests. If an existing test asserted the exact set of
emitted updates, it now sees outcomes too — update the assertion, **never** the implementation.

- [ ] **Step 9: Commit**

```bash
git add worker/src/telemetry.ts worker/src/pipeline.ts worker/src/telemetry.test.ts worker/src/pipeline.test.ts
git commit -m "feat(worker): emit run outcomes as telemetry (CP-161)"
```

---

### Task 2: Let the socket carry everything, and expose the effective config

**Files:**
- Modify: `worker/src/local-server.ts`
- Modify: `worker/src/wiring.ts:332`
- Test: `worker/src/local-server.test.ts`

**Interfaces:**
- Consumes: `Outcome`, `isOutcome` from Task 1.
- Produces: `GET /config` → `{ apiUrl, workerName, projectCount, model, reviewModel, maxDiffLines,
  taskTimeoutMs }`. Task 6 fetches it; Task 11 renders it.

- [ ] **Step 1: Write the failing tests**

In `worker/src/local-server.test.ts`, using the file's existing socket harness:

```ts
it("forwards a quota update to an open stream", async () => {
  const events = openStream();
  telemetry.emit({ status: "allowed_warning", utilization: 0.9 });
  await expect(events.next()).resolves.toEqual({ status: "allowed_warning", utilization: 0.9 });
});

it("forwards an outcome update to an open stream", async () => {
  const events = openStream();
  telemetry.emit({ outcome: "merged", taskKey: "CP-1" });
  await expect(events.next()).resolves.toEqual({ outcome: "merged", taskKey: "CP-1" });
});

it("serves the effective config without any credential in it", async () => {
  const body = await get("/config");
  expect(body).toEqual({
    apiUrl: "http://localhost:3991",
    workerName: "rig-laptop",
    projectCount: 1,
    model: "claude-opus-5",
    reviewModel: "claude-opus-5",
    maxDiffLines: 2000,
    taskTimeoutMs: 900_000,
  });
  expect(JSON.stringify(body)).not.toMatch(/cpw_|token|credential/i);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd worker && npx vitest run src/local-server.test.ts`
Expected: FAIL — the quota/outcome streams time out, `/config` 404s.

- [ ] **Step 3: Remove the filter**

In `local-server.ts:72-75`, delete the `isQuota` guard:

```ts
const unsubscribe = deps.telemetry.subscribe((update) => {
  response.write(`data: ${JSON.stringify(update)}\n\n`);
});
```

The `isQuota` import goes with it if nothing else in the file uses it.

- [ ] **Step 4: Add the config route**

Widen `LocalServerDeps`:

```ts
export interface LocalConfigView {
  apiUrl: string;
  workerName: string;
  projectCount: number;
  model: string;
  reviewModel: string;
  maxDiffLines: number;
  taskTimeoutMs: number;
}
```

with `config: () => LocalConfigView` on the deps, and the route:

```ts
"GET /config": (_request, response) => json(response, 200, deps.config()),
```

A function, not a value: policy arrives from the server over SSE and changes under a running worker.

In `wiring.ts:332`, beside `socketPath`, pass a closure reading the same resolved config the loop
uses. **No token, no credential, no repository path** — a repository binding is exactly what the
socket must never disclose (`local-server.ts:14`).

- [ ] **Step 5: Run and watch them pass**

Run: `cd worker && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/local-server.ts worker/src/wiring.ts worker/src/local-server.test.ts
git commit -m "feat(worker): stream every telemetry update and expose effective config (CP-161)"
```

---

### Task 3: The Swift package, proving the toolchain end to end

**Files:**
- Create: `menubar/Package.swift`, `menubar/Sources/CPMenubarCore/Version.swift`,
  `menubar/Tests/CPMenubarCoreTests/VersionTests.swift`, `menubar/.gitignore`

**Interfaces:**
- Produces: the `CPMenubarCore` and `CPMenubar` targets every later task builds into.

- [ ] **Step 1: Write `Package.swift`**

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CPMenubar",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "CPMenubarCore"),
        .executableTarget(name: "CPMenubar", dependencies: ["CPMenubarCore"]),
        .testTarget(name: "CPMenubarCoreTests", dependencies: ["CPMenubarCore"]),
    ]
)
```

`.v14` is the floor `MenuBarExtra` needs; the machine runs 26 and the SDK is 26.5.

- [ ] **Step 2: Write the failing test**

`Tests/CPMenubarCoreTests/VersionTests.swift`:

```swift
import Testing
@testable import CPMenubarCore

@Test func exposesItsVersion() {
    #expect(CPMenubarCore.version == "0.1.0")
}
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd menubar && swift test`
Expected: FAIL — no such module member. If `import Testing` itself fails, the toolchain does not
ship swift-testing; fall back to XCTest for every test in this plan and note it in the README.

- [ ] **Step 4: Implement**

`Sources/CPMenubarCore/Version.swift`:

```swift
public enum CPMenubarCore {
    public static let version = "0.1.0"
}
```

Placeholder executable so the target builds — `Sources/CPMenubar/main.swift`, deleted in Task 8:

```swift
print("CPMenubar \(CPMenubarCore.version)")
```

`menubar/.gitignore`:

```
.build/
*.app
```

- [ ] **Step 5: Run and watch it pass**

Run: `cd menubar && swift test`
Expected: PASS, 1 test.

- [ ] **Step 6: Commit**

```bash
git add menubar
git commit -m "chore(menubar): scaffold the SwiftPM package (CP-161)"
```

---

### Task 4: `UnixHTTP` — one request over a unix socket

**Files:**
- Create: `menubar/Sources/CPMenubarCore/UnixHTTP.swift`
- Test: `menubar/Tests/CPMenubarCoreTests/UnixHTTPTests.swift`

**Interfaces:**
- Produces:
  ```swift
  public protocol Transport: Sendable {
      func send(_ request: String, to path: String) async throws -> AsyncThrowingStream<Data, Error>
  }
  public struct HTTPResponse { public let status: Int; public let body: Data }
  public func parseHead(_ bytes: Data) -> (status: Int, headerLength: Int)?
  public struct NWTransport: Transport { public init() }
  ```
  Task 6 builds `SocketClient` on `Transport`, and injects a fake in its tests.

- [ ] **Step 1: Write the failing test**

The parsing is the part with bugs in it; the socket is the part that needs a live worker. So test
the parser hard and keep `NWTransport` a thin shell verified in Task 12.

```swift
import Foundation
import Testing
@testable import CPMenubarCore

@Test func parsesAStatusLineAndFindsTheBodyOffset() {
    let raw = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}".utf8)
    let head = parseHead(raw)
    #expect(head?.status == 200)
    #expect(head?.headerLength == 49)
    #expect(String(data: raw.dropFirst(head!.headerLength), encoding: .utf8) == "{}")
}

@Test func returnsNilUntilTheHeaderTerminatorHasArrived() {
    #expect(parseHead(Data("HTTP/1.1 200 OK\r\nContent-Ty".utf8)) == nil)
}

@Test func readsANonOKStatus() {
    #expect(parseHead(Data("HTTP/1.1 404 Not Found\r\n\r\n".utf8))?.status == 404)
}

@Test func refusesAResponseThatIsNotHTTP() {
    #expect(parseHead(Data("garbage\r\n\r\n".utf8)) == nil)
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd menubar && swift test`
Expected: FAIL — `parseHead` undefined.

- [ ] **Step 3: Implement**

```swift
import Foundation
import Network

public struct HTTPResponse: Sendable {
    public let status: Int
    public let body: Data
    public init(status: Int, body: Data) { self.status = status; self.body = body }
}

public func parseHead(_ bytes: Data) -> (status: Int, headerLength: Int)? {
    let terminator = Data("\r\n\r\n".utf8)
    guard let range = bytes.range(of: terminator) else { return nil }
    let head = bytes[..<range.lowerBound]
    guard let text = String(data: head, encoding: .utf8) else { return nil }
    let parts = text.split(separator: "\r\n", maxSplits: 1).first?.split(separator: " ") ?? []
    guard parts.count >= 2, parts[0].hasPrefix("HTTP/"), let status = Int(parts[1]) else { return nil }
    return (status, bytes.distance(from: bytes.startIndex, to: range.upperBound))
}

public protocol Transport: Sendable {
    func send(_ request: String, to path: String) async throws -> AsyncThrowingStream<Data, Error>
}

public struct NWTransport: Transport {
    public init() {}

    public func send(_ request: String, to path: String) async throws -> AsyncThrowingStream<Data, Error> {
        let connection = NWConnection(to: .unix(path: path), using: .tcp)
        return AsyncThrowingStream { continuation in
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    connection.send(content: Data(request.utf8), completion: .idempotent)
                    receive(connection, continuation)
                case .failed(let error):
                    continuation.finish(throwing: error)
                case .cancelled:
                    continuation.finish()
                default:
                    break
                }
            }
            continuation.onTermination = { _ in connection.cancel() }
            connection.start(queue: .global(qos: .utility))
        }
    }

    private func receive(
        _ connection: NWConnection,
        _ continuation: AsyncThrowingStream<Data, Error>.Continuation
    ) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, done, error in
            if let data, !data.isEmpty { continuation.yield(data) }
            if let error { continuation.finish(throwing: error); return }
            if done { continuation.finish(); return }
            receive(connection, continuation)
        }
    }
}
```

`.unix(path:)` is why this is `Network.framework` and not `URLSession` — `URLSession` cannot address
a unix socket at all.

- [ ] **Step 4: Run and watch it pass**

Run: `cd menubar && swift test`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add menubar/Sources/CPMenubarCore/UnixHTTP.swift menubar/Tests/CPMenubarCoreTests/UnixHTTPTests.swift
git commit -m "feat(menubar): HTTP over a unix domain socket (CP-161)"
```

---

### Task 5: `TelemetryEvent` — decoding a union that has no tag

**Files:**
- Create: `menubar/Sources/CPMenubarCore/TelemetryEvent.swift`
- Test: `menubar/Tests/CPMenubarCoreTests/TelemetryEventTests.swift`

**Interfaces:**
- Consumes: the wire shapes in Task 1.
- Produces:
  ```swift
  public struct ToolActivity: Equatable, Sendable { public let name: String; public let target: String? }
  public struct Progress: Equatable, Sendable {
      public let phase: String; public let taskKey: String?; public let tool: ToolActivity?
      public let turns: Int?; public let costUsd: Double?
  }
  public struct Quota: Equatable, Sendable {
      public let status: String; public let utilization: Double?
      public let resetsAt: Double?; public let rateLimitType: String?
  }
  public struct Outcome: Equatable, Sendable {
      public let outcome: String; public let taskKey: String; public let detail: String?
  }
  public enum TelemetryEvent: Equatable, Sendable { case progress(Progress), quota(Quota), outcome(Outcome) }
  public struct StatusResponse: Decodable, Sendable {
      public let paused: Bool; public let current: Progress?; public let recent: [Progress]
  }
  ```
  Tasks 6, 7 and 9 all consume `TelemetryEvent`.

- [ ] **Step 1: Write the failing test**

The union is discriminated **structurally**, exactly as `telemetry.ts` does it: `status` ⇒ quota,
`outcome` ⇒ outcome, otherwise progress. Order matters, and an unknown phase must survive — a
`gates:<name>` phase is open-ended by construction.

```swift
import Foundation
import Testing
@testable import CPMenubarCore

private func decode(_ json: String) throws -> TelemetryEvent {
    try JSONDecoder().decode(TelemetryEvent.self, from: Data(json.utf8))
}

@Test func decodesProgressWithATaskAndATool() throws {
    let event = try decode(#"{"phase":"agent","taskKey":"CP-1","tool":{"name":"Read","target":"src/a.ts"}}"#)
    #expect(event == .progress(Progress(phase: "agent", taskKey: "CP-1",
                                        tool: ToolActivity(name: "Read", target: "src/a.ts"))))
}

@Test func decodesAnOpenEndedGatePhase() throws {
    let event = try decode(#"{"phase":"gates:build","taskKey":"CP-1"}"#)
    #expect(event == .progress(Progress(phase: "gates:build", taskKey: "CP-1")))
}

@Test func decodesAProgressThatCarriesNoTask() throws {
    #expect(try decode(#"{"phase":"agent"}"#) == .progress(Progress(phase: "agent")))
}

@Test func decodesQuotaByItsStatusKey() throws {
    let event = try decode(#"{"status":"allowed_warning","utilization":0.91}"#)
    #expect(event == .quota(Quota(status: "allowed_warning", utilization: 0.91,
                                  resetsAt: nil, rateLimitType: nil)))
}

@Test func decodesAnOutcomeByItsOutcomeKey() throws {
    let event = try decode(#"{"outcome":"gateRejected","taskKey":"CP-1","detail":"build"}"#)
    #expect(event == .outcome(Outcome(outcome: "gateRejected", taskKey: "CP-1", detail: "build")))
}

@Test func throwsOnAnObjectThatIsNoneOfTheThree() {
    #expect(throws: (any Error).self) { try decode(#"{"unrelated":1}"#) }
}

@Test func decodesTheStatusResponse() throws {
    let json = #"{"paused":false,"current":{"phase":"agent"},"recent":[{"phase":"claiming"},{"phase":"agent"}]}"#
    let status = try JSONDecoder().decode(StatusResponse.self, from: Data(json.utf8))
    #expect(status.paused == false)
    #expect(status.current?.phase == "agent")
    #expect(status.recent.count == 2)
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd menubar && swift test`
Expected: FAIL — no such type.

- [ ] **Step 3: Implement**

```swift
import Foundation

public struct ToolActivity: Equatable, Sendable, Decodable {
    public let name: String
    public let target: String?
    public init(name: String, target: String? = nil) { self.name = name; self.target = target }
}

public struct Progress: Equatable, Sendable, Decodable {
    public let phase: String
    public let taskKey: String?
    public let tool: ToolActivity?
    public let turns: Int?
    public let costUsd: Double?
    public init(phase: String, taskKey: String? = nil, tool: ToolActivity? = nil,
                turns: Int? = nil, costUsd: Double? = nil) {
        self.phase = phase; self.taskKey = taskKey
        self.tool = tool; self.turns = turns; self.costUsd = costUsd
    }
}

public struct Quota: Equatable, Sendable, Decodable {
    public let status: String
    public let utilization: Double?
    public let resetsAt: Double?
    public let rateLimitType: String?
    public init(status: String, utilization: Double? = nil,
                resetsAt: Double? = nil, rateLimitType: String? = nil) {
        self.status = status; self.utilization = utilization
        self.resetsAt = resetsAt; self.rateLimitType = rateLimitType
    }
}

public struct Outcome: Equatable, Sendable, Decodable {
    public let outcome: String
    public let taskKey: String
    public let detail: String?
    public init(outcome: String, taskKey: String, detail: String? = nil) {
        self.outcome = outcome; self.taskKey = taskKey; self.detail = detail
    }
}

public enum TelemetryEvent: Equatable, Sendable, Decodable {
    case progress(Progress)
    case quota(Quota)
    case outcome(Outcome)

    private enum Discriminator: String, CodingKey { case status, outcome, phase }

    public init(from decoder: any Decoder) throws {
        let keys = try decoder.container(keyedBy: Discriminator.self)
        if keys.contains(.status) {
            self = .quota(try Quota(from: decoder))
        } else if keys.contains(.outcome) {
            self = .outcome(try Outcome(from: decoder))
        } else if keys.contains(.phase) {
            self = .progress(try Progress(from: decoder))
        } else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath,
                      debugDescription: "not a progress, quota or outcome update"))
        }
    }
}

public struct StatusResponse: Decodable, Sendable {
    public let paused: Bool
    public let current: Progress?
    public let recent: [Progress]
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd menubar && swift test`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add menubar/Sources/CPMenubarCore/TelemetryEvent.swift menubar/Tests/CPMenubarCoreTests/TelemetryEventTests.swift
git commit -m "feat(menubar): decode the telemetry union (CP-161)"
```

---

### Task 6: `SocketClient` — status, commands, and SSE framing

**Files:**
- Create: `menubar/Sources/CPMenubarCore/SocketClient.swift`
- Test: `menubar/Tests/CPMenubarCoreTests/SocketClientTests.swift`

**Interfaces:**
- Consumes: `Transport`, `parseHead` (Task 4); `TelemetryEvent`, `StatusResponse` (Task 5).
- Produces:
  ```swift
  public struct ConfigResponse: Decodable, Sendable {
      public let apiUrl: String; public let workerName: String; public let projectCount: Int
      public let model: String; public let reviewModel: String
      public let maxDiffLines: Int; public let taskTimeoutMs: Int
  }
  public struct SocketClient: Sendable {
      public init(socketPath: String, transport: any Transport)
      public func status() async throws -> StatusResponse
      public func config() async throws -> ConfigResponse
      public func command(_ name: String) async throws -> Bool   // returns `paused`
      public func stream() -> AsyncStream<TelemetryEvent>
  }
  public func sseEvents(from buffer: inout Data) -> [Data]
  public static func defaultSocketPath() -> String
  ```
  Task 7 reduces the stream; Task 12 points it at a live worker.

- [ ] **Step 1: Write the failing test**

SSE framing is where this breaks in production: a chunk boundary lands mid-event and a naive split
loses it. Test that directly, with a fake transport that hands over deliberately awkward chunks.

```swift
import Foundation
import Testing
@testable import CPMenubarCore

private struct FakeTransport: Transport {
    let chunks: [String]
    func send(_ request: String, to path: String) async throws -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            for chunk in chunks { continuation.yield(Data(chunk.utf8)) }
            continuation.finish()
        }
    }
}

@Test func framesTwoEventsOutOfOneChunk() {
    var buffer = Data("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n".utf8)
    let events = sseEvents(from: &buffer)
    #expect(events.map { String(data: $0, encoding: .utf8) } == ["{\"a\":1}", "{\"b\":2}"])
    #expect(buffer.isEmpty)
}

@Test func holdsAPartialEventUntilItsTerminatorArrives() {
    var buffer = Data("data: {\"a\":".utf8)
    #expect(sseEvents(from: &buffer).isEmpty)
    buffer.append(Data("1}\n\n".utf8))
    #expect(sseEvents(from: &buffer).map { String(data: $0, encoding: .utf8) } == ["{\"a\":1}"])
}

@Test func parsesAStatusResponseOverTheTransport() async throws {
    let body = #"{"paused":true,"current":null,"recent":[]}"#
    let client = SocketClient(socketPath: "/x", transport: FakeTransport(
        chunks: ["HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n", body]))
    let status = try await client.status()
    #expect(status.paused == true)
    #expect(status.current == nil)
}

@Test func surfacesEventsFromASplitStream() async throws {
    let client = SocketClient(socketPath: "/x", transport: FakeTransport(chunks: [
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {\"pha",
        "se\":\"agent\"}\n\ndata: {\"outcome\":\"merged\",\"taskKey\":\"CP-1\"}\n\n",
    ]))
    var seen: [TelemetryEvent] = []
    for await event in client.stream() { seen.append(event) }
    #expect(seen == [
        .progress(Progress(phase: "agent")),
        .outcome(Outcome(outcome: "merged", taskKey: "CP-1")),
    ])
}

@Test func ignoresAnEventItCannotDecodeRatherThanEndingTheStream() async throws {
    let client = SocketClient(socketPath: "/x", transport: FakeTransport(chunks: [
        "HTTP/1.1 200 OK\r\n\r\ndata: {\"nonsense\":1}\n\ndata: {\"phase\":\"push\"}\n\n",
    ]))
    var seen: [TelemetryEvent] = []
    for await event in client.stream() { seen.append(event) }
    #expect(seen == [.progress(Progress(phase: "push"))])
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd menubar && swift test`
Expected: FAIL — no such type.

- [ ] **Step 3: Implement**

```swift
import Foundation

public struct ConfigResponse: Decodable, Sendable {
    public let apiUrl: String
    public let workerName: String
    public let projectCount: Int
    public let model: String
    public let reviewModel: String
    public let maxDiffLines: Int
    public let taskTimeoutMs: Int
}

public func sseEvents(from buffer: inout Data) -> [Data] {
    let separator = Data("\n\n".utf8)
    var events: [Data] = []
    while let range = buffer.range(of: separator) {
        let block = buffer[..<range.lowerBound]
        buffer.removeSubrange(..<range.upperBound)
        guard let text = String(data: block, encoding: .utf8) else { continue }
        for line in text.split(separator: "\n") where line.hasPrefix("data: ") {
            events.append(Data(line.dropFirst(6).utf8))
        }
    }
    return events
}

public struct SocketClient: Sendable {
    private let socketPath: String
    private let transport: any Transport

    public init(socketPath: String, transport: any Transport) {
        self.socketPath = socketPath
        self.transport = transport
    }

    public static func defaultSocketPath() -> String {
        let stateDir = ProcessInfo.processInfo.environment["CP_STATE_DIR"]
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".boardplanner").path
        return (stateDir as NSString).appendingPathComponent("worker.sock")
    }

    private func request(_ method: String, _ path: String) -> String {
        "\(method) \(path) HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    }

    private func collect(_ method: String, _ path: String) async throws -> HTTPResponse {
        var bytes = Data()
        for try await chunk in try await transport.send(request(method, path), to: socketPath) {
            bytes.append(chunk)
        }
        guard let head = parseHead(bytes) else { throw SocketError.malformedResponse }
        return HTTPResponse(status: head.status, body: bytes.dropFirst(head.headerLength))
    }

    public func status() async throws -> StatusResponse {
        try JSONDecoder().decode(StatusResponse.self, from: await collect("GET", "/status").body)
    }

    public func config() async throws -> ConfigResponse {
        try JSONDecoder().decode(ConfigResponse.self, from: await collect("GET", "/config").body)
    }

    @discardableResult
    public func command(_ name: String) async throws -> Bool {
        let response = try await collect("POST", "/\(name)")
        struct Ack: Decodable { let paused: Bool }
        return try JSONDecoder().decode(Ack.self, from: response.body).paused
    }

    public func stream() -> AsyncStream<TelemetryEvent> {
        AsyncStream { continuation in
            let task = Task {
                do {
                    var buffer = Data()
                    var headerSeen = false
                    let decoder = JSONDecoder()
                    for try await chunk in try await transport.send(request("GET", "/stream"), to: socketPath) {
                        buffer.append(chunk)
                        if !headerSeen {
                            guard let head = parseHead(buffer) else { continue }
                            buffer.removeSubrange(..<buffer.index(buffer.startIndex, offsetBy: head.headerLength))
                            headerSeen = true
                        }
                        for payload in sseEvents(from: &buffer) {
                            // One unparseable event must not end a stream the panel depends on
                            if let event = try? decoder.decode(TelemetryEvent.self, from: payload) {
                                continuation.yield(event)
                            }
                        }
                    }
                } catch {}
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

public enum SocketError: Error { case malformedResponse }
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd menubar && swift test`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add menubar/Sources/CPMenubarCore/SocketClient.swift menubar/Tests/CPMenubarCoreTests/SocketClientTests.swift
git commit -m "feat(menubar): socket client with SSE framing (CP-161)"
```

---

### Task 7: `WorkerState` — the reducer the whole UI renders

**Files:**
- Create: `menubar/Sources/CPMenubarCore/WorkerState.swift`
- Test: `menubar/Tests/CPMenubarCoreTests/WorkerStateTests.swift`

**Interfaces:**
- Consumes: `TelemetryEvent`, `Progress`, `StatusResponse` (Task 5).
- Produces:
  ```swift
  public enum Health: Equatable, Sendable { case idle, working, needsHuman, disconnected, paused }
  public struct WorkerState: Equatable, Sendable {
      public private(set) var health: Health
      public private(set) var currentPhase: String?
      public private(set) var currentTaskKey: String?
      public private(set) var recentTools: [ToolActivity]
      public private(set) var mergedToday: Int
      public private(set) var lastQuota: Quota?
      public private(set) var lastEventAt: Date?
      public init()
      public mutating func apply(_ event: TelemetryEvent, at now: Date)
      public mutating func adopt(_ status: StatusResponse, at now: Date)
      public mutating func markDisconnected()
      public func iconName() -> String
      public func title(now: Date) -> String?
      public static let pipeline: [String]
      public func stepperRows(now: Date) -> [(phase: String, state: StepState)]
  }
  public enum StepState: Equatable, Sendable { case done, active, pending }
  ```
  Task 8 renders it; Task 9 reads `mergedToday`.

- [ ] **Step 1: Write the failing test**

The behaviours that matter: the icon answers "stuck or working?" without a click; a `blocked`
outcome is the only thing that means *needs a human*; a quiet run is not a dead one.

```swift
import Foundation
import Testing
@testable import CPMenubarCore

private let t0 = Date(timeIntervalSince1970: 1_000_000)

@Test func startsIdle() {
    #expect(WorkerState().health == .idle)
}

@Test func aProgressEventMakesItWorking() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent")), at: t0)
    #expect(state.health == .working)
    #expect(state.currentPhase == "agent")
}

@Test func aMergedOutcomeReturnsItToIdleAndCountsTheMerge() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent")), at: t0)
    state.apply(.outcome(Outcome(outcome: "merged", taskKey: "CP-1")), at: t0)
    #expect(state.health == .idle)
    #expect(state.mergedToday == 1)
    #expect(state.currentPhase == nil)
}

@Test func aBlockedOutcomeIsTheOneThatNeedsAHuman() {
    var state = WorkerState()
    state.apply(.outcome(Outcome(outcome: "blocked", taskKey: "CP-1", detail: "ambiguous")), at: t0)
    #expect(state.health == .needsHuman)
}

@Test func aRequeuedOutcomeDoesNotNeedAHuman() {
    var state = WorkerState()
    state.apply(.outcome(Outcome(outcome: "requeued", taskKey: "CP-1")), at: t0)
    #expect(state.health == .idle)
}

@Test func keepsTheLastFiveToolsNewestFirst() {
    var state = WorkerState()
    for i in 1...7 {
        state.apply(.progress(Progress(phase: "agent", tool: ToolActivity(name: "T\(i)"))), at: t0)
    }
    #expect(state.recentTools.map(\.name) == ["T7", "T6", "T5", "T4", "T3"])
}

@Test func adoptsAStatusSnapshotIncludingItsPausedFlag() {
    var state = WorkerState()
    state.adopt(StatusResponse(paused: true, current: Progress(phase: "push"), recent: []), at: t0)
    #expect(state.health == .paused)
    #expect(state.currentPhase == "push")
}

@Test func theTitleNamesTheTaskThePhaseAndTheElapsedTime() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "gates:build", taskKey: "CP-161")), at: t0)
    #expect(state.title(now: t0.addingTimeInterval(102)) == "CP-161 · gates:build 1:42")
}

@Test func theTitleFallsBackToThePhaseWhenNoTaskIsNamed() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "claiming")), at: t0)
    #expect(state.title(now: t0.addingTimeInterval(5)) == "claiming 0:05")
}

@Test func theElapsedClockRestartsOnEachNewPhaseNotOnEachEvent() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent", taskKey: "CP-1")), at: t0)
    state.apply(.progress(Progress(phase: "agent", taskKey: "CP-1",
                                   tool: ToolActivity(name: "Read"))), at: t0.addingTimeInterval(30))
    #expect(state.title(now: t0.addingTimeInterval(60)) == "CP-1 · agent 1:00")
}

@Test func aQuietRunStillReadsAsWorking() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent")), at: t0)
    #expect(state.health == .working)
    #expect(state.iconName() == "circle.fill")
}

@Test func losingTheSocketIsDisconnectedAndSaysSo() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "agent")), at: t0)
    state.markDisconnected()
    #expect(state.health == .disconnected)
    #expect(state.iconName() == "exclamationmark.triangle")
}

@Test func theStepperMarksPassedPhasesDoneAndTheRestPending() {
    var state = WorkerState()
    state.apply(.progress(Progress(phase: "push")), at: t0)
    let rows = state.stepperRows(now: t0)
    #expect(rows.first(where: { $0.phase == "claiming" })?.state == .done)
    #expect(rows.first(where: { $0.phase == "push" })?.state == .active)
    #expect(rows.first(where: { $0.phase == "merge" })?.state == .pending)
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd menubar && swift test`
Expected: FAIL — no such type.

- [ ] **Step 3: Implement**

```swift
import Foundation

public enum Health: Equatable, Sendable { case idle, working, needsHuman, disconnected, paused }
public enum StepState: Equatable, Sendable { case done, active, pending }

public struct WorkerState: Equatable, Sendable {
    public private(set) var health: Health = .idle
    public private(set) var currentPhase: String?
    public private(set) var currentTaskKey: String?
    public private(set) var recentTools: [ToolActivity] = []
    public private(set) var mergedToday: Int = 0
    public private(set) var lastQuota: Quota?
    public private(set) var lastEventAt: Date?
    private var phaseSince: Date?

    public init() {}

    public static let pipeline = ["claiming", "worktree", "agent", "gates", "push", "pr", "merge"]

    private static let recentToolLimit = 5

    public mutating func apply(_ event: TelemetryEvent, at now: Date) {
        lastEventAt = now
        switch event {
        case .progress(let progress):
            if health != .paused { health = .working }
            if currentPhase != progress.phase { phaseSince = now }
            currentPhase = progress.phase
            if let key = progress.taskKey { currentTaskKey = key }
            if let tool = progress.tool {
                recentTools.insert(tool, at: 0)
                if recentTools.count > Self.recentToolLimit { recentTools.removeLast() }
            }
        case .quota(let quota):
            lastQuota = quota
        case .outcome(let outcome):
            currentTaskKey = outcome.taskKey
            currentPhase = nil
            phaseSince = nil
            if outcome.outcome == "merged" { mergedToday += 1 }
            health = outcome.outcome == "blocked" ? .needsHuman : (health == .paused ? .paused : .idle)
        }
    }

    public mutating func adopt(_ status: StatusResponse, at now: Date) {
        lastEventAt = now
        currentPhase = status.current?.phase
        if status.current != nil, phaseSince == nil { phaseSince = now }
        health = status.paused ? .paused : (status.current == nil ? .idle : .working)
    }

    public mutating func markDisconnected() {
        health = .disconnected
        currentPhase = nil
        phaseSince = nil
    }

    public func iconName() -> String {
        switch health {
        case .idle: return "circle"
        case .working: return "circle.fill"
        case .paused: return "pause.circle"
        case .needsHuman: return "exclamationmark.circle.fill"
        case .disconnected: return "exclamationmark.triangle"
        }
    }

    public func title(now: Date) -> String? {
        guard let phase = currentPhase, let since = phaseSince else { return nil }
        let seconds = max(0, Int(now.timeIntervalSince(since)))
        let elapsed = "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
        guard let key = currentTaskKey else { return "\(phase) \(elapsed)" }
        return "\(key) · \(phase) \(elapsed)"
    }

    public func stepperRows(now: Date) -> [(phase: String, state: StepState)] {
        let normalised = currentPhase.map { $0.hasPrefix("gates:") ? "gates" : $0 }
        guard let current = normalised, let index = Self.pipeline.firstIndex(of: current) else {
            return Self.pipeline.map { ($0, .pending) }
        }
        return Self.pipeline.enumerated().map { offset, phase in
            (phase, offset < index ? .done : (offset == index ? .active : .pending))
        }
    }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd menubar && swift test`
Expected: PASS, 31 tests.

- [ ] **Step 5: Commit**

```bash
git add menubar/Sources/CPMenubarCore/WorkerState.swift menubar/Tests/CPMenubarCoreTests/WorkerStateTests.swift
git commit -m "feat(menubar): reduce telemetry into operator-facing state (CP-161)"
```

---

### Task 8: The `MenuBarExtra` shell and the panel

**Files:**
- Create: `menubar/Sources/CPMenubar/AppModel.swift`, `CPMenubarApp.swift`, `PanelView.swift`
- Delete: `menubar/Sources/CPMenubar/main.swift` (the Task 3 placeholder)

**Interfaces:**
- Consumes: `SocketClient` (Task 6), `WorkerState`, `Health`, `StepState` (Task 7).
- Produces: `@Observable final class AppModel` with `state: WorkerState`, `config: ConfigResponse?`,
  `func start()`, `func send(_ command: String)`. Tasks 9–11 hang off it.

There is no unit test here — SwiftUI views are verified live in Task 12. Everything worth asserting
already sits in `CPMenubarCore` and is covered.

- [ ] **Step 1: Write `AppModel.swift`**

```swift
import Foundation
import CPMenubarCore

@Observable
@MainActor
final class AppModel {
    private(set) var state = WorkerState()
    private(set) var config: ConfigResponse?
    private let client: SocketClient
    private var pump: Task<Void, Never>?

    init(client: SocketClient = SocketClient(socketPath: SocketClient.defaultSocketPath(),
                                             transport: NWTransport())) {
        self.client = client
    }

    func start() {
        pump?.cancel()
        pump = Task { await self.pumpForever() }
    }

    private func pumpForever() async {
        while !Task.isCancelled {
            do {
                state.adopt(try await client.status(), at: Date())
                config = try? await client.config()
                for await event in client.stream() {
                    state.apply(event, at: Date())
                }
            } catch {}
            state.markDisconnected()
            try? await Task.sleep(for: .seconds(5))
        }
    }

    func send(_ command: String) {
        Task { _ = try? await client.command(command) }
    }
}
```

The reconnect loop is what makes "Can't reach Board Planner · retrying" true rather than decorative:
a worker restart drops the socket and the panel recovers on its own.

- [ ] **Step 2: Write `CPMenubarApp.swift`**

```swift
import SwiftUI
import CPMenubarCore

@main
struct CPMenubarApp: App {
    @State private var model: AppModel

    init() {
        let model = AppModel()
        _model = State(initialValue: model)
        model.start()
    }

    var body: some Scene {
        MenuBarExtra {
            PanelView(model: model)
        } label: {
            if let title = model.state.title(now: Date()) {
                Label(title, systemImage: model.state.iconName())
            } else {
                Image(systemName: model.state.iconName())
            }
        }
        .menuBarExtraStyle(.window)
    }
}
```

**Ordering, deliberately:** no `Notifier` here and no `Settings` scene — both are added by the tasks
that create them (9 and 11). Referencing a type two tasks early is a plan that does not compile, and
this task must build on its own.

**The icon is a template image.** The menu bar renders it monochrome and follows the system
appearance, so the spec's "amber" and "red" cannot be colours — distinct SF Symbols carry the state
instead, which is what `iconName()` returns.

`@State private var model: AppModel` carries **no** default initialiser: writing
`= AppModel()` alongside `_model = State(initialValue:)` in `init` constructs two models, starts the
pump on one and renders the other, and the panel then never moves. The declaration must be bare.

- [ ] **Step 3: Write `PanelView.swift`**

Six sections, top to bottom: health header, current task, the stepper, recent tools, controls,
today's tally.

```swift
import Combine
import SwiftUI
import CPMenubarCore

struct PanelView: View {
    let model: AppModel
    @State private var now = Date()
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(headline)
                .font(.headline)

            if model.state.currentPhase != nil {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(model.state.stepperRows(now: now), id: \.phase) { row in
                        Label(row.phase, systemImage: symbol(for: row.state))
                            .foregroundStyle(row.state == .pending ? .secondary : .primary)
                    }
                }
                .font(.callout)
            }

            if !model.state.recentTools.isEmpty {
                Divider()
                ForEach(Array(model.state.recentTools.enumerated()), id: \.offset) { _, tool in
                    Text(tool.target.map { "\(tool.name) · \($0)" } ?? tool.name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            Divider()
            HStack {
                Button(model.state.health == .paused ? "Resume" : "Pause") {
                    model.send(model.state.health == .paused ? "resume" : "pause")
                }
                Button("Stop") { model.send("stop") }
                    .disabled(model.state.currentPhase == nil)
                Spacer()
            }

            Text("\(model.state.mergedToday) merged today")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(width: 320)
        .onReceive(tick) { now = $0 }
    }

    private var headline: String {
        switch model.state.health {
        case .idle: return "Waiting for work"
        case .working: return model.state.title(now: now) ?? "Working"
        case .paused: return "Paused"
        case .needsHuman: return "Needs a human"
        case .disconnected: return "Can't reach the worker · retrying"
        }
    }

    private func symbol(for state: StepState) -> String {
        switch state {
        case .done: return "checkmark.circle.fill"
        case .active: return "circle.dotted"
        case .pending: return "circle"
        }
    }
}
```

- [ ] **Step 4: Delete the placeholder and build**

```bash
rm menubar/Sources/CPMenubar/main.swift
cd menubar && swift build
```

Expected: builds. `@main` and a `main.swift` in the same target is a compile error, which is why the
placeholder goes first.

- [ ] **Step 5: Run the suite**

Run: `cd menubar && swift test`
Expected: PASS, 31 tests — unchanged; this task added no core logic.

- [ ] **Step 6: Commit**

```bash
git add menubar/Sources/CPMenubar
git commit -m "feat(menubar): menu bar extra with the live pipeline panel (CP-161)"
```

---

### Task 9: `Notifier` — the four notifications

**Files:**
- Create: `menubar/Sources/CPMenubarCore/Notifier.swift`
- Test: `menubar/Tests/CPMenubarCoreTests/NotifierTests.swift`

**Interfaces:**
- Consumes: `TelemetryEvent` (Task 5).
- Produces: `public func notification(for event: TelemetryEvent) -> NotificationRequest?` and
  `public struct NotificationRequest: Equatable, Sendable { public let title: String; public let body: String }`,
  plus `Notifier.shared.handle(_:)` / `.requestAuthorization()` used by Task 8.

Splitting the *decision* from the *delivery* is what makes this testable: `notification(for:)` is
pure and covered; `UNUserNotificationCenter` is three lines that are verified live.

- [ ] **Step 1: Write the failing test**

The checklist names exactly four: merged, gate rejected, needs human review, usage limit. Everything
else must stay silent, or the app becomes noise the operator turns off.

```swift
import Testing
@testable import CPMenubarCore

@Test func notifiesOnAMerge() {
    let request = notification(for: .outcome(Outcome(outcome: "merged", taskKey: "CP-1")))
    #expect(request == NotificationRequest(title: "CP-1 merged", body: "The worker is free again."))
}

@Test func notifiesOnAGateRejectionAndNamesTheGate() {
    let request = notification(for: .outcome(Outcome(outcome: "gateRejected", taskKey: "CP-1", detail: "build")))
    #expect(request?.title == "CP-1 rejected by the build gate")
}

@Test func notifiesWhenATaskNeedsAHuman() {
    let request = notification(for: .outcome(Outcome(outcome: "blocked", taskKey: "CP-1", detail: "ambiguous scope")))
    #expect(request == NotificationRequest(title: "CP-1 needs a human", body: "ambiguous scope"))
}

@Test func notifiesWhenTheUsageLimitIsHit() {
    let request = notification(for: .quota(Quota(status: "rejected")))
    #expect(request?.title == "Usage limit reached")
}

@Test func staysSilentOnAWarningThatIsNotYetALimit() {
    #expect(notification(for: .quota(Quota(status: "allowed_warning", utilization: 0.9))) == nil)
}

@Test func staysSilentOnOrdinaryProgress() {
    #expect(notification(for: .progress(Progress(phase: "agent"))) == nil)
}

@Test func staysSilentOnARequeue() {
    #expect(notification(for: .outcome(Outcome(outcome: "requeued", taskKey: "CP-1"))) == nil)
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd menubar && swift test`
Expected: FAIL — `notification(for:)` undefined.

- [ ] **Step 3: Implement**

```swift
import Foundation
import UserNotifications

public struct NotificationRequest: Equatable, Sendable {
    public let title: String
    public let body: String
}

public func notification(for event: TelemetryEvent) -> NotificationRequest? {
    switch event {
    case .progress:
        return nil
    case .quota(let quota):
        guard quota.status == "rejected" else { return nil }
        return NotificationRequest(title: "Usage limit reached",
                                   body: "The worker released its task and will retry later.")
    case .outcome(let outcome):
        switch outcome.outcome {
        case "merged":
            return NotificationRequest(title: "\(outcome.taskKey) merged",
                                       body: "The worker is free again.")
        case "gateRejected":
            return NotificationRequest(title: "\(outcome.taskKey) rejected by the \(outcome.detail ?? "unknown") gate",
                                       body: "The branch is still there; the task went back to the board.")
        case "blocked":
            return NotificationRequest(title: "\(outcome.taskKey) needs a human",
                                       body: outcome.detail ?? "The worker stopped and is waiting.")
        default:
            return nil
        }
    }
}

public final class Notifier: Sendable {
    public static let shared = Notifier()
    private init() {}

    public func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    public func handle(_ event: TelemetryEvent) {
        guard let request = notification(for: event) else { return }
        let content = UNMutableNotificationContent()
        content.title = request.title
        content.body = request.body
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd menubar && swift test`
Expected: PASS, 38 tests.

- [ ] **Step 5: Wire it into the app**

Now that the type exists, `AppModel.pumpForever` raises the notification as it applies the event:

```swift
for await event in client.stream() {
    state.apply(event, at: Date())
    Notifier.shared.handle(event)
}
```

and `CPMenubarApp.init` asks for permission once, after starting the pump:

```swift
model.start()
Notifier.shared.requestAuthorization()
```

- [ ] **Step 6: Build and run the suite**

Run: `cd menubar && swift build && swift test`
Expected: builds; 38 tests pass.

- [ ] **Step 7: Commit**

```bash
git add menubar/Sources/CPMenubarCore/Notifier.swift menubar/Tests/CPMenubarCoreTests/NotifierTests.swift menubar/Sources/CPMenubar
git commit -m "feat(menubar): native notifications for the four outcomes that matter (CP-161)"
```

---

### Task 10: `ReposFile` — the allowlist the operator owns

**Files:**
- Create: `menubar/Sources/CPMenubarCore/ReposFile.swift`
- Test: `menubar/Tests/CPMenubarCoreTests/ReposFileTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```swift
  public struct ReposFile: Sendable {
      public init(path: String)
      public func read() throws -> [String]
      public func write(_ paths: [String]) throws
  }
  ```
  Task 11's Repositories tab calls both.

The on-disk shape is fixed by `worker/src/repos.ts`: `{"repos": [<absolute path>, ...]}`, mode 0600,
in a 0700 directory. Getting it wrong means the worker silently refuses every binding.

- [ ] **Step 1: Write the failing test**

```swift
import Foundation
import Testing
@testable import CPMenubarCore

private func scratch() -> String {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("repos.json").path
}

@Test func readsAnEmptyListWhenTheFileDoesNotExist() throws {
    #expect(try ReposFile(path: scratch()).read() == [])
}

@Test func roundTripsTheWorkersOwnFormat() throws {
    let file = ReposFile(path: scratch())
    try file.write(["/Users/rpo/code/a", "/Users/rpo/code/b"])
    #expect(try file.read() == ["/Users/rpo/code/a", "/Users/rpo/code/b"])
}

@Test func writesTheExactJsonShapeReposTsExpects() throws {
    let path = scratch()
    try ReposFile(path: path).write(["/tmp/x"])
    let parsed = try JSONSerialization.jsonObject(
        with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: [String]]
    #expect(parsed?["repos"] == ["/tmp/x"])
}

@Test func writesAtOwnerOnlyPermissions() throws {
    let path = scratch()
    try ReposFile(path: path).write(["/tmp/x"])
    let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber
    #expect(mode?.int16Value == 0o600)
}

@Test func refusesARelativePathRatherThanWritingOneTheWorkerWillReject() {
    #expect(throws: (any Error).self) { try ReposFile(path: scratch()).write(["relative/path"]) }
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd menubar && swift test`
Expected: FAIL — no such type.

- [ ] **Step 3: Implement**

```swift
import Foundation

public struct ReposFile: Sendable {
    private let path: String
    public init(path: String) { self.path = path }

    public static func defaultPath() -> String {
        let stateDir = ProcessInfo.processInfo.environment["CP_STATE_DIR"]
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".boardplanner").path
        return (stateDir as NSString).appendingPathComponent("repos.json")
    }

    private struct Document: Codable { let repos: [String] }

    public func read() throws -> [String] {
        guard FileManager.default.fileExists(atPath: path) else { return [] }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        return try JSONDecoder().decode(Document.self, from: data).repos
    }

    public func write(_ paths: [String]) throws {
        guard paths.allSatisfy({ $0.hasPrefix("/") }) else { throw ReposError.notAbsolute }
        let data = try JSONEncoder().encode(Document(repos: paths))
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }
}

public enum ReposError: Error { case notAbsolute }
```

`.atomic` writes through a temporary file, so `setAttributes` must run after the rename — before it,
it would chmod a file that no longer exists.

- [ ] **Step 4: Run and watch it pass**

Run: `cd menubar && swift test`
Expected: PASS, 43 tests.

- [ ] **Step 5: Commit**

```bash
git add menubar/Sources/CPMenubarCore/ReposFile.swift menubar/Tests/CPMenubarCoreTests/ReposFileTests.swift
git commit -m "feat(menubar): read and write the repository allowlist (CP-161)"
```

---

### Task 11: The preferences window

**Files:**
- Create: `menubar/Sources/CPMenubar/PreferencesView.swift`

**Interfaces:**
- Consumes: `AppModel` (Task 8), `ReposFile` (Task 10), `ConfigResponse` (Task 6).

Four tabs. Connection, Policy and Advanced are read-only for the reason in the scope decision;
Repositories is the one that writes.

- [ ] **Step 1: Write `PreferencesView.swift`**

```swift
import SwiftUI
import CPMenubarCore

struct PreferencesView: View {
    let model: AppModel

    var body: some View {
        TabView {
            ConnectionTab(model: model).tabItem { Label("Connection", systemImage: "network") }
            RepositoriesTab().tabItem { Label("Repositories", systemImage: "folder") }
            PolicyTab(model: model).tabItem { Label("Policy", systemImage: "slider.horizontal.3") }
            AdvancedTab(model: model).tabItem { Label("Advanced", systemImage: "gearshape") }
        }
        .frame(width: 460, height: 320)
    }
}

private struct ConnectionTab: View {
    let model: AppModel
    var body: some View {
        Form {
            LabeledContent("Server", value: model.config?.apiUrl ?? "—")
            LabeledContent("Worker", value: model.config?.workerName ?? "—")
            LabeledContent("Projects", value: model.config.map { "\($0.projectCount)" } ?? "—")
            Text("Registration and credentials are managed on the worker, not here.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped).padding()
    }
}

private struct RepositoriesTab: View {
    @State private var paths: [String] = []
    @State private var selection: String?
    @State private var error: String?
    private let file = ReposFile(path: ReposFile.defaultPath())

    var body: some View {
        VStack(alignment: .leading) {
            List(paths, id: \.self, selection: $selection) { Text($0).lineLimit(1).truncationMode(.head) }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack {
                Button("Add…") { add() }
                Button("Remove") { remove() }.disabled(selection == nil)
                Spacer()
                Text("The worker only ever binds a repository listed here.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding()
        .onAppear { paths = (try? file.read()) ?? [] }
    }

    private func add() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let path = panel.url?.path else { return }
        save(paths.contains(path) ? paths : paths + [path])
    }

    private func remove() {
        guard let selection else { return }
        save(paths.filter { $0 != selection })
    }

    private func save(_ next: [String]) {
        do {
            try file.write(next)
            paths = next
            error = nil
        } catch {
            self.error = "Could not write repos.json: \(error.localizedDescription)"
        }
    }
}

private struct PolicyTab: View {
    let model: AppModel
    var body: some View {
        Form {
            LabeledContent("Model", value: model.config?.model ?? "—")
            LabeledContent("Review model", value: model.config?.reviewModel ?? "—")
            LabeledContent("Max diff lines", value: model.config.map { "\($0.maxDiffLines)" } ?? "—")
            Text("Policy comes from the server. Change it in Settings → Workers in the web console.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped).padding()
    }
}

private struct AdvancedTab: View {
    let model: AppModel
    var body: some View {
        Form {
            LabeledContent("Task timeout", value: model.config.map { "\($0.taskTimeoutMs / 1000)s" } ?? "—")
            LabeledContent("Socket", value: SocketClient.defaultSocketPath())
            LabeledContent("Allowlist", value: ReposFile.defaultPath())
        }
        .formStyle(.grouped).padding()
    }
}
```

The folder picker is the **only** way to add a repository — matching the spec, and matching
`repos.ts`, which refuses anything not already on the list.

- [ ] **Step 2: Give the window a way to open**

`PreferencesView` now exists, so add the scene to `CPMenubarApp.body`, after the `MenuBarExtra`:

```swift
Settings { PreferencesView(model: model) }
```

and the button to `PanelView`'s control row, in the `Spacer()`'s place at the end:

```swift
Spacer()
SettingsLink { Text("Preferences…") }
```

- [ ] **Step 3: Build and run the suite**

Run: `cd menubar && swift build && swift test`
Expected: builds; 43 tests pass. Launch it and confirm ⌘, opens the window — a `Settings` scene with
no `SettingsLink` and no menu bar is otherwise unreachable in an `LSUIElement` app.

- [ ] **Step 4: Commit**

```bash
git add menubar/Sources/CPMenubar
git commit -m "feat(menubar): preferences window with the repository allowlist editor (CP-161)"
```

---

### Task 12: Bundle it, and verify the whole thing against a live worker

**Files:**
- Create: `menubar/Makefile`, `menubar/Resources/Info.plist`, `menubar/README.md`

**Interfaces:** none — this task produces a runnable `.app` and evidence.

- [ ] **Step 1: Write `Resources/Info.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>CPMenubar</string>
    <key>CFBundleIdentifier</key><string>com.boardplanner.menubar</string>
    <key>CFBundleExecutable</key><string>CPMenubar</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSUIElement</key><true/>
</dict>
</plist>
```

`LSUIElement` is what keeps a menubar app out of the Dock and the ⌘-Tab switcher. Without it the app
still runs, but it is a window-less application with a Dock icon, which reads as a bug.

- [ ] **Step 2: Write the `Makefile`**

```make
APP := CPMenubar.app

.PHONY: app test clean

test:
	swift test

app: test
	swift build -c release
	rm -rf $(APP)
	mkdir -p $(APP)/Contents/MacOS
	cp Resources/Info.plist $(APP)/Contents/Info.plist
	cp .build/release/CPMenubar $(APP)/Contents/MacOS/CPMenubar
	codesign --force --sign - $(APP)

clean:
	rm -rf .build $(APP)
```

Ad-hoc signing (`--sign -`) is enough for a locally built app and is what lets
`UNUserNotificationCenter` register a bundle identifier at all.

- [ ] **Step 3: Build the bundle**

Run: `cd menubar && make app`
Expected: `CPMenubar.app` exists and `codesign -dv CPMenubar.app` reports an ad-hoc signature.

- [ ] **Step 4: Bring the rig up**

Follow `docs/superpowers/2026-08-03-cp-161-handoff.md`, section "Bringing the rig back up" —
Mongo 4.4 on 27017 (`cp161_live`), the app on 3991, the worker from `worker/` with
`CP_STATE_DIR=$HOME/cp-rig/state`. Then:

```bash
open menubar/CPMenubar.app
```

Because the worker's state dir is `$HOME/cp-rig/state` and not the default, launch the app with the
same variable so it finds the socket:

```bash
CP_STATE_DIR=$HOME/cp-rig/state menubar/CPMenubar.app/Contents/MacOS/CPMenubar
```

- [ ] **Step 5: Verify, and record what you saw**

Each of these is a checklist line; do not tick one you have not watched happen.

- [ ] Idle worker → outline icon, "Waiting for work", no title
- [ ] A claimed task → filled icon, title counts up, stepper walks `claiming → worktree → agent`
- [ ] Recent tools list fills with real tool names and paths from the agent's own run
- [ ] `gates:build` renders as the `gates` step, active
- [ ] Merge → "CP-N merged" notification in Notification Center, tally increments, panel returns to idle
- [ ] Pause from the panel → worker stops claiming; the button becomes Resume; `paused` is what
      `GET /status` reports
- [ ] Stop mid-run → the run aborts and the task returns to the board with its attempt refunded
- [ ] `kill` the worker → icon goes to the warning triangle within ~5s, header says it is retrying;
      restart it → panel recovers on its own with no user action
- [ ] Preferences → Repositories lists the rig repo; Add… opens a folder picker; the written
      `repos.json` is `0600` and the worker binds a repository added through it
- [ ] Preferences → Policy and Advanced show the values the worker is actually running under

- [ ] **Step 6: Commit**

```bash
git add menubar/Makefile menubar/Resources menubar/README.md
git commit -m "build(menubar): package the app bundle and document the rig (CP-161)"
```

---

## After this plan — the gap-closing phase

Not part C, and not to be folded into it. Listed so the next session does not rediscover them:

1. **Policy UI in the web console** — checklist item 3, inherited vs overridden. This is where that
   item belongs now that the app is read-only.
2. **Duplicate-worker refusal** — checklist item 13. `registerWorker` upserts on `{name, host}`
   (`src/lib/worker-service.ts:54`) and nothing consults project + `proposedPath`.
3. **`workerId` renders as a raw ObjectId** on the task panel.
4. **The stranded-phase sweeper** — `releaseExpiredTasks` has one caller, the claim route, so a
   project no worker is polling never gets swept.
5. **Checklist item 14** needs rewording rather than implementing — the spec already refuses "last
   error" and "attempt N of M", with reasons.
6. **C4, the enrolment token** — rpo's decision, and the thing that would let the app hold a
   credential and make the Connection and Policy tabs writable.
7. **`GET /logs` was never built.** The spec lists it beside `/status` and `/stream`; part B shipped
   without it and this plan does not add it — the recent-tools list answers "what is it doing?"
   without a log pane. Build it only if a real run makes the panel feel blind.

## Two places this app is honestly narrower than the spec

Both follow from it holding no credential, and neither is a defect to be fixed later by accident:

- **"Can't reach Board Planner · retrying in 12s"** becomes *"Can't reach the worker · retrying"*.
  The app's only I/O is a unix socket, so it cannot tell a dead network from a healthy one — only
  whether the worker is answering. Claiming to distinguish them would be a lie in the UI.
- **The first-launch wizard** (URL and credential → discover projects → point at a repository) is
  not built. Its first two steps configure the *worker*, which is exactly what this app does not do.
  The Repositories tab covers its third step, which is the part that is genuinely local.
