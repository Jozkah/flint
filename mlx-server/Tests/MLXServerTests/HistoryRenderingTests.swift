import Foundation
import XCTest
@testable import MLXServer

final class HistoryRenderingTests: XCTestCase {
    func testOnlyAnOpenThinkInTheGenerationPromptCounts() {
        // Thinking model: the reply starts inside a reasoning block.
        XCTAssertTrue(ModelRunner.injectsOpener(
            "{%- if add_generation_prompt %}{{- '<|im_start|>assistant\\n<think>\\n' }}{%- endif %}"))
        // Instruct model that only strips <think> from history.
        XCTAssertFalse(ModelRunner.injectsOpener(
            "{% set c = content.split('</think>')[-1].split('<think>')[0] %}"
                + "{%- if add_generation_prompt %}{{- '<|im_start|>assistant\\n' }}{%- endif %}"))
        // Hybrid model turning thinking off with a closed block.
        XCTAssertFalse(ModelRunner.injectsOpener(
            "{%- if add_generation_prompt %}{{- '<think>\\n\\n</think>\\n\\n' }}{%- endif %}"))
    }

    func testAssistantToolCallsAreRenderedIntoHistory() {
        let call = ToolCallInfo(
            id: "call_1", type: "function",
            function: FunctionCall(name: "get_weather", arguments: #"{"city":"Oslo"}"#))
        let message = ChatMessage(role: "assistant", content: .string(""), tool_calls: [call])
        XCTAssertEqual(
            ModelRunner.contentWithToolCalls(message),
            "<tool_call>\n{\"arguments\":{\"city\":\"Oslo\"},\"name\":\"get_weather\"}\n</tool_call>")

        let plain = ChatMessage(role: "user", content: .string("hi"))
        XCTAssertEqual(ModelRunner.contentWithToolCalls(plain), "hi")
    }

    func testSseErrorFrameIsValidJson() throws {
        let json = sseErrorJSON("bad \"quote\"\nline")
        let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: String]
        XCTAssertEqual(object?["message"], "bad \"quote\"\nline")
    }
}
