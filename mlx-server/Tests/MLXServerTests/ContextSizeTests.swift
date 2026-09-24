import MLXLMCommon
import XCTest

@testable import MLXServer

/// Regression tests for #70: `--ctx-size` must reach the generation
/// parameters instead of only being logged.
final class ContextSizeTests: XCTestCase {
    func testNonPositiveContextSizeIsUnset() {
        XCTAssertNil(ModelRunner.kvCacheLimit(ctxSize: nil))
        XCTAssertNil(ModelRunner.kvCacheLimit(ctxSize: 0))
        XCTAssertNil(ModelRunner.kvCacheLimit(ctxSize: -1))
    }

    func testConfiguredContextSizeIsKept() {
        XCTAssertEqual(ModelRunner.kvCacheLimit(ctxSize: 16000), 16000)
    }

    func testRunnerStoresContextLength() async {
        let runner = ModelRunner()
        await runner.setContextLength(16000)
        let stored = await runner.contextLength
        XCTAssertEqual(stored, 16000)
    }

    func testContextLengthReachesGenerateParameters() {
        let runner = ModelRunner()
        let params = runner.buildGenerateParameters(
            temperature: 0.7, topP: 1.0, repetitionPenalty: 1.0,
            contextLength: 16000
        )
        XCTAssertEqual(params.maxKVSize, 16000)
    }
}
