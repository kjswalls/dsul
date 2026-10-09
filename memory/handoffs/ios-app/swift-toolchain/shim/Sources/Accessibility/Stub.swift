import Foundation
// Linux stand-in for Apple's Accessibility framework: just what the app's
// non-UI files call.
public enum AnnouncementPriorityStub: Sendable { case high, low, `default` }
extension AttributedString {
    public var accessibilitySpeechAnnouncementPriority: AnnouncementPriorityStub? {
        get { nil }
        set { _ = newValue }
    }
}
public enum AccessibilityNotification {
    public struct Announcement {
        public init(_ text: AttributedString) {}
        public init(_ text: String) {}
        public func post() {}
    }
}
