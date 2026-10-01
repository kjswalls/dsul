import CoreTransferable
import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    /// In-app only: a drag carries the item's id, never the item.
    /// Declared in Info.plist under UTExportedTypeDeclarations (project.yml).
    static let dsulItemRef = UTType(exportedAs: "app.dsul.item-ref")
}

struct ItemRef: Codable, Transferable, Identifiable, Hashable, Sendable {
    let id: UUID

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: .dsulItemRef)
    }
}

extension PresentationDetent {
    /// The braindump sheet's smallest size: one row's peek above the tab bar.
    static let peek = Self.height(96)
}
