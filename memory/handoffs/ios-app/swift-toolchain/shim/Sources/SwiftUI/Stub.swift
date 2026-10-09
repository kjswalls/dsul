// Linux stand-in for SwiftUI: just what ScheduleDrag.swift names.
public struct PresentationDetent: Hashable, Sendable {
    let id: String
    public static let medium = PresentationDetent(id: "medium")
    public static let large = PresentationDetent(id: "large")
}
