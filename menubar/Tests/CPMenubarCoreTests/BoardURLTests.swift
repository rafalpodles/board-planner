import XCTest
@testable import CPMenubarCore

final class BoardURLTests: XCTestCase {
    func testALocalAddressWithNoSchemeBecomesHTTP() {
        XCTAssertEqual(BoardURL.normalise("localhost:3973"), "http://localhost:3973")
        XCTAssertEqual(BoardURL.normalise("127.0.0.1:3000"), "http://127.0.0.1:3000")
    }

    func testTheResultActuallyParses() throws {
        let url = try XCTUnwrap(URL(string: BoardURL.normalise("localhost:3973") + "/api/x"))

        XCTAssertEqual(url.scheme, "http")
        XCTAssertEqual(url.host, "localhost")
        XCTAssertEqual(url.port, 3973)
    }

    func testARemoteAddressWithNoSchemeBecomesHTTPS() {
        XCTAssertEqual(BoardURL.normalise("board.example.com"), "https://board.example.com")
    }

    func testAnExplicitSchemeIsLeftAlone() {
        XCTAssertEqual(BoardURL.normalise("https://localhost:3973"), "https://localhost:3973")
        XCTAssertEqual(BoardURL.normalise("http://board.example.com"), "http://board.example.com")
    }

    func testItTidiesWhatPeoplePaste() {
        XCTAssertEqual(BoardURL.normalise("  localhost:3973/  "), "http://localhost:3973")
        XCTAssertEqual(BoardURL.normalise(""), "")
        XCTAssertEqual(BoardURL.normalise("   "), "")
    }

    func testAMachineOnTheLocalNetworkIsNotAssumedToHaveTLS() {
        XCTAssertEqual(BoardURL.normalise("mac-mini.local:3000"), "http://mac-mini.local:3000")
    }
}
