import Foundation
import XCTest

@testable import MLXServer

/// Regression tests for #74: an unresolvable model path must make
/// `ModelRunner.load(modelPath:)` throw instead of returning normally.
final class ModelPathResolutionTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mlx-path-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testMissingPathDoesNotResolve() {
        let missing = root.appendingPathComponent("does-not-exist").path
        XCTAssertNil(ModelRunner.resolveModelDirectory(modelPath: missing))
    }

    func testDirectoryWithoutConfigDoesNotResolve() throws {
        let dir = root.appendingPathComponent("empty")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        XCTAssertNil(ModelRunner.resolveModelDirectory(modelPath: dir.path))
    }

    func testDirectoryWithConfigResolvesToItself() throws {
        let dir = root.appendingPathComponent("model")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: dir.appendingPathComponent("config.json"))
        XCTAssertEqual(
            ModelRunner.resolveModelDirectory(modelPath: dir.path)?.standardizedFileURL.path,
            dir.standardizedFileURL.path
        )
    }

    func testLoadThrowsForUnresolvedPath() async {
        let runner = ModelRunner()
        let missing = root.appendingPathComponent("nope").path
        do {
            try await runner.load(modelPath: missing)
            XCTFail("load(modelPath:) returned normally for an unresolved path")
        } catch MLXServerError.modelPathNotResolved(let path) {
            XCTAssertEqual(path, missing)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}
