import XCTest
@testable import MLXServer

final class SplitterAndNullTests: XCTestCase {
    func testTextBeforeExplicitThinkIsContent() {
        var s = ReasoningSplitter()
        var content = ""
        var reasoning = ""
        for t in ["Hi ", "<think>why", "</think>done"] {
            let p = s.feed(t)
            content += p.content ?? ""
            reasoning += p.reasoning ?? ""
        }
        let tail = s.finish()
        content += tail.content ?? ""
        reasoning += tail.reasoning ?? ""
        XCTAssertEqual(content, "Hi done")
        XCTAssertEqual(reasoning, "why")
    }

    func testAnyCodableDecodesNull() throws {
        let json = #"[{"type":"function","function":{"name":"f","parameters":{"default":null}}}]"#
        let tools = try JSONDecoder().decode([AnyCodable].self, from: Data(json.utf8))
        XCTAssertEqual(tools.count, 1)
        let encoded = try JSONEncoder().encode(tools)
        XCTAssertTrue(String(decoding: encoded, as: UTF8.self).contains("null"))
    }
}
