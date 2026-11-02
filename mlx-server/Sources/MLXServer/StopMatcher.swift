import Foundation

/// Applies OpenAI `stop` / Anthropic `stop_sequences` to streamed text.
/// Holds back the last (longest stop - 1) characters so a stop string split
/// across chunks is never emitted. Empty stop strings are ignored.
struct StopMatcher {
    private let stops: [String]
    private let holdback: Int
    private var buffer = ""
    private(set) var matched: String?

    init(stops: [String]) {
        self.stops = stops.filter { !$0.isEmpty }
        self.holdback = max((self.stops.map { $0.count }.max() ?? 1) - 1, 0)
    }

    var isActive: Bool { !stops.isEmpty }

    /// Returns text that is safe to emit. After a match `matched` is set and
    /// the caller must stop generating.
    mutating func feed(_ chunk: String) -> String {
        guard isActive, matched == nil else { return chunk }
        buffer += chunk
        var best: (range: Range<String.Index>, stop: String)?
        for stop in stops {
            guard let r = buffer.range(of: stop) else { continue }
            if let b = best {
                if r.lowerBound < b.range.lowerBound
                    || (r.lowerBound == b.range.lowerBound && stop.count > b.stop.count) {
                    best = (r, stop)
                }
            } else {
                best = (r, stop)
            }
        }
        if let best = best {
            let out = String(buffer[..<best.range.lowerBound])
            matched = best.stop
            buffer = ""
            return out
        }
        if buffer.count <= holdback { return "" }
        let cut = buffer.index(buffer.endIndex, offsetBy: -holdback)
        let out = String(buffer[..<cut])
        buffer = String(buffer[cut...])
        return out
    }

    /// Emits any held-back tail (generation ended without a match).
    mutating func flush() -> String {
        let out = buffer
        buffer = ""
        return out
    }
}
