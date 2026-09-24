import XCTest
@testable import MLXServer

/// #75: the cache limit is 20 GiB, not 20 MiB.
final class CacheLimitTests: XCTestCase {
    func testGpuCacheLimitIsTwentyGibibytes() {
        XCTAssertEqual(MLXServerCommand.gpuCacheLimitBytes, 21_474_836_480)
        XCTAssertEqual(MLXServerCommand.gpuCacheLimitBytes / (1024 * 1024), 20_480)
    }
}
