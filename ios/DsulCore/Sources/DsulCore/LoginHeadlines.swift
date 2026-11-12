import Foundation

// The sign-in screen's headline, picked fresh each time the screen appears.
// Port of lib/login-headlines.ts: the same pool, in the same order, so the
// iPhone and the web say the same lines. Keep in step: a line added or cut
// there without the same change here is drift, and
// tests/unit/login-headlines.test.ts fails on it.

public enum LoginHeadlines {
    /// login-headlines.ts `DEFAULT_LOGIN_HEADLINE`: the fallback.
    public static let defaultLine = "ok! what are we doing today?"

    /// login-headlines.ts `LOGIN_HEADLINES`.
    public static let all: [String] = [
        // pool:start
        "ok! what are we doing today?",
        "what stuff should we do today?",
        "one thing at a time. maybe two.",
        "stuff won’t do itself. sadly. unless..?",
        "do some stuff first, then snacks.",
        "a plan is just a list with dreams.",
        "brain too full? empty it here.",
        "tiny steps are still steps!",
        "future you is proud as hell.",
        "ok. where were we?",
        "ok, what’s the move?",
        "hi. got stuff?",
        "pick a thing. any thing.",
        "let’s wrangle some stuff.",
        "the checkboxes miss you.",
        "tiny plan, big snack.",
        "stuff goes in. done stuff comes out.",
        "a to-do list walks into a bar...",
        // pool:end
    ]

    /// login-headlines.ts `pickLoginHeadline`. `random` returns a value in
    /// 0..<1 and is injectable so tests can pin the pick.
    public static func pick(random: () -> Double = { Double.random(in: 0..<1) }) -> String {
        let index = Int((random() * Double(all.count)).rounded(.down))
        return all.indices.contains(index) ? all[index] : defaultLine
    }
}
