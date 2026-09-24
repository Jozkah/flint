import Foundation
import XCTest
@testable import MLXServer

/// #76: a non-object `tools` entry must be rejected, not crash the server.
final class ToolValidationTests: XCTestCase {
    private func decodeTools(_ json: String) throws -> [AnyCodable] {
        try JSONDecoder().decode([AnyCodable].self, from: Data(json.utf8))
    }

    func testNonObjectToolEntriesAreRejected() throws {
        for json in [#"["not-an-object"]"#, "[123]", "[[1,2]]", "[true]"] {
            let tools = try decodeTools(json)
            XCTAssertThrowsError(try validateToolEntries(tools), json) { error in
                XCTAssertTrue(error is InvalidToolEntryError, json)
            }
            XCTAssertNil(toolSpec(from: tools[0]), json)
        }
    }

    func testTheOffendingIndexIsReported() throws {
        let tools = try decodeTools(#"[{"type":"function","function":{"name":"a"}}, "bad"]"#)
        XCTAssertThrowsError(try validateToolEntries(tools)) { error in
            XCTAssertEqual((error as? InvalidToolEntryError)?.index, 1)
        }
    }

    func testObjectToolEntriesPass() throws {
        let tools = try decodeTools(
            #"[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object"}}}]"#
        )
        XCTAssertNoThrow(try validateToolEntries(tools))
        XCTAssertNoThrow(try validateToolEntries(nil))
        let spec = try XCTUnwrap(toolSpec(from: tools[0]))
        XCTAssertEqual(spec["type"] as? String, "function")
    }

    func testAnthropicConversionOfABareStringIsRejected() throws {
        let converted = anthropicToolsToOpenAI(try decodeTools(#"["oops"]"#))
        XCTAssertThrowsError(try validateToolEntries(converted))
    }
}
