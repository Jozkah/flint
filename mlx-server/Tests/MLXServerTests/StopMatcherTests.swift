import XCTest
import Hummingbird
import NIOCore
@testable import MLXServer

final class StopMatcherTests: XCTestCase {
    private func run(_ chunks: [String], stops: [String]) -> (String, String?) {
        var m = StopMatcher(stops: stops)
        var out = ""
        for c in chunks {
            out += m.feed(c)
            if m.matched != nil { return (out, m.matched) }
        }
        out += m.flush()
        return (out, m.matched)
    }

    func testNoStopsPassesThrough() {
        XCTAssertEqual(run(["ab", "cd"], stops: []).0, "abcd")
    }

    func testStopInsideChunkTruncates() {
        let (t, s) = run(["hello END world"], stops: ["END"])
        XCTAssertEqual(t, "hello ")
        XCTAssertEqual(s, "END")
    }

    func testStopSplitAcrossChunks() {
        let (t, s) = run(["hello E", "N", "D tail"], stops: ["END"])
        XCTAssertEqual(t, "hello ")
        XCTAssertEqual(s, "END")
    }

    func testPartialPrefixIsFlushedWhenNoMatch() {
        let (t, s) = run(["abc EN"], stops: ["END"])
        XCTAssertEqual(t, "abc EN")
        XCTAssertNil(s)
    }

    func testEarliestStopWins() {
        let (t, s) = run(["a<b>c</x>"], stops: ["</x>", "<b>"])
        XCTAssertEqual(t, "a")
        XCTAssertEqual(s, "<b>")
    }

    func testEmptyStopIgnored() {
        XCTAssertEqual(run(["abc"], stops: [""]).0, "abc")
    }
}

final class CancelIdParsingTests: XCTestCase {
    private func buf(_ s: String) -> ByteBuffer {
        var b = ByteBufferAllocator().buffer(capacity: s.utf8.count)
        b.writeString(s)
        return b
    }

    func testIdParsed() {
        XCTAssertEqual(MLXHTTPServer.parseCancelId(from: buf("{\"id\":\"chatcmpl-1\"}")), "chatcmpl-1")
    }

    func testEmptyOrMissingIdMeansCancelAll() {
        XCTAssertNil(MLXHTTPServer.parseCancelId(from: buf("")))
        XCTAssertNil(MLXHTTPServer.parseCancelId(from: buf("{}")))
        XCTAssertNil(MLXHTTPServer.parseCancelId(from: buf("not json")))
    }
}
