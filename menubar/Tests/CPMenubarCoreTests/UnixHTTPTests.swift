import Foundation
import Testing
@testable import CPMenubarCore

@Test func parsesAStatusLineAndFindsTheBodyOffset() throws {
    let raw = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}".utf8)
    let head = try #require(parseHead(raw))

    #expect(head.status == 200)
    #expect(String(data: raw.dropFirst(head.headerLength), encoding: .utf8) == "{}")
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

// A body may hold \r\n\r\n of its own; only the first one ends the header.
@Test func splitsOnTheFirstTerminatorNotTheLast() throws {
    let raw = Data("HTTP/1.1 200 OK\r\n\r\n{\"a\":\"x\r\n\r\ny\"}".utf8)
    let head = try #require(parseHead(raw))

    #expect(String(data: raw.dropFirst(head.headerLength), encoding: .utf8) == "{\"a\":\"x\r\n\r\ny\"}")
}

// Node answers every socket route with Transfer-Encoding: chunked — `response.end(json)` sets no
// Content-Length. curl hides this; a hand-written client must not. Found against a running worker.
@Test func reportsWhetherTheBodyIsChunked() throws {
    let chunked = try #require(parseHead(Data(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n".utf8)))
    let plain = try #require(parseHead(Data("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n".utf8)))

    #expect(chunked.chunked == true)
    #expect(plain.chunked == false)
}

@Test func readsAChunkedHeaderRegardlessOfItsCasing() throws {
    let head = try #require(parseHead(Data("HTTP/1.1 200 OK\r\ntransfer-encoding: CHUNKED\r\n\r\n".utf8)))

    #expect(head.chunked == true)
}

@Test func dechunksASingleChunkAndSeesTheTerminator() {
    var buffer = Data("2b\r\n{\"paused\":false,\"current\":null,\"recent\":[]}\r\n0\r\n\r\n".utf8)

    let result = dechunk(from: &buffer)

    #expect(String(data: result.data, encoding: .utf8) == "{\"paused\":false,\"current\":null,\"recent\":[]}")
    #expect(result.finished == true)
}

@Test func joinsChunksThatArriveSeparately() {
    var buffer = Data("5\r\nhello\r\n".utf8)
    let first = dechunk(from: &buffer)
    #expect(String(data: first.data, encoding: .utf8) == "hello")
    #expect(first.finished == false)

    buffer.append(Data("5\r\nworld\r\n0\r\n\r\n".utf8))
    let second = dechunk(from: &buffer)

    #expect(String(data: second.data, encoding: .utf8) == "world")
    #expect(second.finished == true)
}

// The failure this whole path exists for: a read(2) boundary landing inside a chunk.
@Test func holdsAnIncompleteChunkUntilTheRestArrives() {
    var buffer = Data("b\r\nhel".utf8)
    #expect(dechunk(from: &buffer).data.isEmpty)

    buffer.append(Data("lo world\r\n".utf8))

    #expect(String(data: dechunk(from: &buffer).data, encoding: .utf8) == "hello world")
}

@Test func holdsAChunkWhoseSizeLineIsStillArriving() {
    var buffer = Data("4".utf8)
    #expect(dechunk(from: &buffer).data.isEmpty)

    buffer.append(Data("\r\nabcd\r\n".utf8))

    #expect(String(data: dechunk(from: &buffer).data, encoding: .utf8) == "abcd")
}

@Test func ignoresAChunkExtensionAfterTheSize() {
    var buffer = Data("4;name=value\r\nabcd\r\n0\r\n\r\n".utf8)

    #expect(String(data: dechunk(from: &buffer).data, encoding: .utf8) == "abcd")
}
