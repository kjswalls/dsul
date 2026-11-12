import Foundation
import Testing
import DsulCore

// LoginHeadlines.swift: the web's sign-in headline pool
// (lib/login-headlines.ts). tests/unit/login-headlines.test.ts checks the
// lines themselves against the web's.

@Test func loginHeadlineDefaultIsInThePool() {
    #expect(LoginHeadlines.all.contains(LoginHeadlines.defaultLine))
}

@Test func loginHeadlinePickCoversBothEnds() {
    #expect(LoginHeadlines.pick(random: { 0 }) == LoginHeadlines.all.first)
    #expect(LoginHeadlines.pick(random: { 0.9999 }) == LoginHeadlines.all.last)
}
