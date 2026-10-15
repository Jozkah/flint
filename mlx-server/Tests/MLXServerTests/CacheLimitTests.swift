import XCTest
@testable import MLXServer

/// #75: the cache limit is 20 GiB, not 20 MiB, scaled down to a quarter of
/// RAM on smaller machines.
final class CacheLimitTests: XCTestCase {
    func testGpuCacheLimitIsTwentyGibibytesOrAQuarterOfRam() {
        let quarter = Int(ProcessInfo.processInfo.physicalMemory / 4)
        XCTAssertEqual(MLXServerCommand.gpuCacheLimitBytes, min(21_474_836_480, quarter))
    }
}
