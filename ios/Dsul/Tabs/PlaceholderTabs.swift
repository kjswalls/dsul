import SwiftUI

struct AskView: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView("Ask arrives later", systemImage: "sparkles",
                                   description: Text("Chat with your own model about your day."))
                .navigationTitle("Ask")
        }
    }
}

struct OrganizeView: View {
    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        NavigationStack {
            List(planner.projects, id: \.self) { project in
                Label(project, systemImage: "folder")
            }
            .navigationTitle("Organize")
        }
    }
}

struct SearchView: View {
    @Environment(SamplePlanner.self) private var planner
    @State private var query = ""

    private var results: [SampleItem] {
        let all = planner.items
        guard !query.isEmpty else { return all }
        return all.filter { $0.title.localizedStandardContains(query) }
    }

    var body: some View {
        NavigationStack {
            List(results) { item in
                Text(item.title)
            }
            .navigationTitle("Search")
            .searchable(text: $query)
        }
    }
}
