import DsulCore
import SwiftUI

/// Organize's Trash page (O14, design §6.3), signed in only: the bin, newest
/// first, each row its glyph, its name, what comes back with it and when it
/// went ("Project · 3 items refile · 3d ago"), and Restore; under it, what
/// the bin is for. The row's words are `ShelfPageModel.trashRow` (pinned by
/// ShelfPageTests).
///
/// The bin is fetched on each arrival (and on a pull, which refreshes the
/// planner too) through the planner, which passes it through PlannerSync to
/// GET /api/app/trash; the rows stay
/// in this page's own state and never enter the planner's (the web's law). A
/// failed read says so, with Try again, and is never shown as an empty bin.
/// Restore shows a spinner in place of its button while it is out; once it
/// lands the row leaves the list and the planner's fetch brings the thing
/// back where it belongs. A refusal says why in the banner and keeps the row,
/// except a 404: it is no longer in the bin, so the banner says that and the
/// row goes too.
struct TrashPageView: View {
    private enum Bin: Equatable {
        case loading
        case failed
        case loaded(TrashList)
    }

    @Environment(SamplePlanner.self) private var planner
    @State private var bin: Bin = .loading
    /// The rows with a restore out, by `TrashRow.key`.
    @State private var restoring: Set<String> = []

    var body: some View {
        List {
            switch bin {
            case .loading:
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text(OrganizeModel.loadingText)
                            .foregroundStyle(Color.secondary)
                    }
                }
            case .failed:
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(OrganizeCopy.trashLoadFailed)
                            .foregroundStyle(Color.secondary)
                        Button(ShelfPageModel.retry) {
                            Task { @MainActor in await load(spinner: true) }
                        }
                        // A list row's button takes the tint, the lime
                        // accent, which is a mark, never text.
                        .tint(Color.primary)
                    }
                }
            case .loaded(let list):
                Section {
                    if list.entries.isEmpty {
                        PageQuietText(text: OrganizeCopy.nothingInTrash)
                    }
                    ForEach(list.entries, id: \.key) { entry in
                        TrashRowView(row: ShelfPageModel.trashRow(entry, now: planner.now()),
                                     restoring: restoring.contains(entry.key)) {
                            Task { @MainActor in await restore(entry) }
                        }
                    }
                } footer: {
                    Text(OrganizeCopy.trashTeaching)
                }
            }
        }
        .listStyle(.insetGrouped)
        // A pull reads the bin again and refreshes the planner under it, as
        // LiveRefresh does on every other page. The page shows only signed
        // in, so the planner is always live here.
        .refreshable {
            await load(spinner: false)
            await planner.refresh()
        }
        // A refused restore's sentence shows here.
        .plannerBanner()
        .navigationTitle(ShelfPageModel.trashTitle)
        .navigationBarTitleDisplayMode(.large)
        .task {
            await load(spinner: false)
        }
    }

    /// Reads the bin. A read cut short by leaving the page changes nothing;
    /// any other failure says so, never an empty bin.
    private func load(spinner: Bool) async {
        if spinner { bin = .loading }
        do {
            let list = try await planner.fetchTrash()
            bin = .loaded(list)
        } catch is CancellationError {
            return
        } catch {
            bin = .failed
        }
    }

    /// Restores `row`; once it lands, or is found gone from the bin, the row
    /// leaves the list.
    private func restore(_ row: TrashRow) async {
        guard !restoring.contains(row.key) else { return }
        restoring.insert(row.key)
        let leaves = await planner.restoreFromTrash(row)
        restoring.remove(row.key)
        if leaves, case .loaded(let list) = bin {
            bin = .loaded(list.removing(row))
        }
    }
}

/// One row of the bin: its glyph in its colour, its name, the meta under it,
/// and Restore (a spinner beside it while it is out). To VoiceOver the row's
/// words are one element and Restore another, named for its kind ("Restore
/// project Work"), so two rows of one name are told apart; while a restore is
/// out the button stays where VoiceOver's focus is, disabled, and says so.
private struct TrashRowView: View {
    let row: TrashListRow
    let restoring: Bool
    let restore: () -> Void

    /// The glyph's column grows with the glyph, as an Organize tile does.
    @ScaledMetric(relativeTo: .body) private var column: CGFloat = 30

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: row.symbol)
                    .font(.body.weight(.medium))
                    .foregroundStyle(row.accent.color)
                    .frame(width: column, height: column)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.row.name)
                        .foregroundStyle(Color.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Text(row.meta)
                        .font(.footnote)
                        .foregroundStyle(Color.secondary)
                        .multilineTextAlignment(.leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(row.spokenLabel))

            if restoring {
                ProgressView()
                    .accessibilityHidden(true)
            }
            Button(ShelfPageModel.restore, action: restore)
                .buttonStyle(ShelfPillStyle())
                .disabled(restoring)
                .accessibilityLabel(Text(row.restoreLabel))
                .accessibilityValue(Text(restoring ? ShelfPageModel.restoring : ""))
        }
    }
}
