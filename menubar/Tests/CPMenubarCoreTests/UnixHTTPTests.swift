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
