import Foundation
import Testing
@testable import TtsLabFluidAudio

@Test func decodesGenericScalarParameters() throws {
    let request = try JSONDecoder().decode(
        Request.self,
        from: Data(#"{"id":"1","text":"hello","output":"out.wav","parameters":{"temperature":"stable","deEss":false}}"#.utf8)
    )
    #expect(request.parameters == ["temperature": .string("stable"), "deEss": .boolean(false)])
}

@Test func rejectsNonScalarParameterValues() {
    for (expectedID, data) in [
        ("nested", Data(#"{"id":"nested","text":"hello","output":"out.wav","parameters":{"value":{}}}"#.utf8)),
        ("null", Data(#"{"id":"null","text":"hello","output":"out.wav","parameters":{"value":null}}"#.utf8)),
        ("parameters-null", Data(#"{"id":"parameters-null","text":"hello","output":"out.wav","parameters":null}"#.utf8)),
    ] {
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(Request.self, from: data)
        }
        #expect(requestID(in: data) == expectedID)
    }
}

@Test func parsesKokoroParametersStrictlyAndDefaultsOldRequests() throws {
    #expect(try KokoroParameters.parse(nil) == 1.0)
    #expect(try KokoroParameters.parse(["speed": .number(1.2)]) == 1.2)
    #expect(throws: (any Error).self) {
        try KokoroParameters.parse(["temperature": .string("stable")])
    }
    #expect(throws: (any Error).self) {
        try KokoroParameters.parse(["speed": .string("1.0")])
    }
}

@Test func mapsPocketEnumsAndRejectsUnknownOrWrongValues() throws {
    #expect(try PocketParameters.parse(nil) == PocketParameters(temperature: 0.3, deEss: true))
    #expect(try PocketParameters.parse([
        "temperature": .string("deterministic"),
        "deEss": .boolean(false),
    ]) == PocketParameters(temperature: 0.0, deEss: false))
    #expect(try PocketParameters.parse(["temperature": .string("upstream")]).temperature == 0.7)
    #expect(throws: (any Error).self) {
        try PocketParameters.parse(["temperature": .number(0.3)])
    }
    #expect(throws: (any Error).self) {
        try PocketParameters.parse(["internal": .boolean(true)])
    }
}
