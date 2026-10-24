import Foundation
import Testing
import DsulCore

// The web's own answers for how a container looks (lib/accent-colors.ts,
// lib/category-icons.ts, and the token values in app/globals.css), checked
// against ContainerLook.swift: tests/fixtures/organize/look.json. Today's
// project dot (`projectAccent`, O15) is checked against the same sections:
// `projectColor` for the token, `tokens` and `colors` for what it draws.

private struct ThemeValue: Decodable, Sendable {
    let l: Double
    let c: Double
    let h: Double
    let hex: String
}

private struct TokenRow: Decodable, Sendable {
    let name: String
    let css: String
    let swatch: String?
    let light: ThemeValue
    let dark: ThemeValue
}

private struct AccentCase: Decodable, Sendable {
    let name: String
    let input: String
    let token: String
    let index: Int
}

private struct ProjectColorCase: Decodable, Sendable {
    let name: String
    let input: String
    let projects: [Project]
    let expected: String
}

private struct DrawnExpected: Decodable, Sendable {
    let source: String
    let token: String?
    let light: String
    let dark: String
}

private struct ColorCase: Decodable, Sendable {
    let name: String
    let color: String?
    let containerName: String
    let expected: DrawnExpected
}

private struct IconCase: Decodable, Sendable {
    let name: String
    let glyph: String?
    let containerName: String
    let expected: String
}

private struct HashCase: Decodable, Sendable {
    let name: String
    let input: String
    let hash: Int
    let index: Int
}

private struct NameIconRow: Decodable, Sendable {
    let key: String
    let icon: String
}

private struct KeywordIconRow: Decodable, Sendable {
    let keywords: [String]
    let icon: String
}

private struct Tables: Decodable, Sendable {
    let ramp: [String]
    let swatches: [String]
    let library: [String]
    let featured: [String]
    let categoryIcons: [String]
    let nameIcons: [NameIconRow]
    let keywordIcons: [KeywordIconRow]
}

private struct LookFixture: Decodable, Sendable {
    let tokens: [TokenRow]
    let accentForName: [AccentCase]
    let projectColor: [ProjectColorCase]
    let colors: [ColorCase]
    let icons: [IconCase]
    let hash: [HashCase]
    let tables: Tables
}

private func load() throws -> LookFixture {
    return try loadOrganizeFixture(LookFixture.self, "look.json")
}

/// Within one step of 255 on every channel, the fixture's tolerance for a
/// conversion done in another language's floating point.
private func near(_ a: SRGBColor, _ hex: String) -> Bool {
    guard let b = SRGBColor(hex: hex) else { return false }
    let step = 1.0 / 255 + 1e-9
    return abs(a.red - b.red) <= step && abs(a.green - b.green) <= step && abs(a.blue - b.blue) <= step
}

/// By UTF-16 code unit, as the web compares.
private func same(_ a: String?, _ b: String?) -> Bool {
    return a.map { Array($0.utf16) } == b.map { Array($0.utf16) }
}

@Suite struct LookFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try load()
        #expect(!f.tokens.isEmpty)
        #expect(!f.accentForName.isEmpty)
        #expect(!f.projectColor.isEmpty)
        #expect(!f.colors.isEmpty)
        #expect(!f.icons.isEmpty)
        #expect(!f.hash.isEmpty)
    }

    /// Every token, in order, with globals.css' exact oklch triples and the
    /// reference conversion's hex within a step.
    @Test func theTokensAreGlobalsCss() throws {
        let rows = try load().tokens
        #expect(ContainerLook.tokens.map(\.name) == rows.map(\.name))
        for row in rows {
            let token = try #require(ContainerLook.tokens.first { $0.name == row.name }, "no \(row.name)")
            #expect(token.css == row.css, "\(row.name): css")
            #expect(token.swatch == row.swatch, "\(row.name): swatch")
            #expect(ContainerLook.token(css: row.css) == token, "\(row.name): lookup")
            #expect(token.light == OKLCH(l: row.light.l, c: row.light.c, h: row.light.h), "\(row.name): light oklch")
            #expect(token.dark == OKLCH(l: row.dark.l, c: row.dark.c, h: row.dark.h), "\(row.name): dark oklch")
            #expect(near(token.light.srgb, row.light.hex), "\(row.name): light \(token.light.srgb.hex) vs \(row.light.hex)")
            #expect(near(token.dark.srgb, row.dark.hex), "\(row.name): dark \(token.dark.srgb.hex) vs \(row.dark.hex)")
        }
    }

    @Test func accentColorForNameMatchesTheWeb() throws {
        for c in try load().accentForName {
            #expect(accentColorForName(c.input) == c.token, "\(c.name)")
            #expect(ContainerLook.ramp[c.index - 1] == c.token, "\(c.name): index")
        }
    }

    @Test func projectColorTokenMatchesTheWeb() throws {
        for c in try load().projectColor {
            #expect(same(projectColorToken(c.input, projects: c.projects), c.expected), "\(c.name)")
        }
    }

    @Test func containerAccentMatchesTheWeb() throws {
        for c in try load().colors {
            let got = containerAccent(c.color, name: c.containerName)
            #expect(got.source.rawValue == c.expected.source, "\(c.name): source")
            #expect(same(got.token, c.expected.token), "\(c.name): token")
            #expect(near(got.light, c.expected.light), "\(c.name): light \(got.light.hex)")
            #expect(near(got.dark, c.expected.dark), "\(c.name): dark \(got.dark.hex)")
            if got.source == .hex {
                #expect(got.light.hex == c.expected.light, "\(c.name): hex kept exactly")
            }
        }
    }

    /// Today's project dot (O15) is the grid's token (`projectColor`, the
    /// web's `projectColorToken`) drawn with globals.css' values (`tokens`): a
    /// readable token is that token, and free text the phone cannot read is
    /// what the grid draws with no colour.
    @Test func projectAccentDrawsTheGridsToken() throws {
        let f = try load()
        for c in f.projectColor {
            let got = projectAccent(c.input, projects: c.projects)
            let folded = Array(jsLowercased(c.input).utf16)
            let stored = c.projects.first { Array(jsLowercased($0.name).utf16) == folded }?.color ?? ""
            if let token = ContainerLook.token(css: c.expected) {
                #expect(got.source == (stored.isEmpty ? .name : .token), "\(c.name): source")
                #expect(same(got.token, c.expected), "\(c.name): token")
                #expect(got.light == token.light.srgb && got.dark == token.dark.srgb, "\(c.name): value")
                let row = try #require(f.tokens.first { same($0.css, c.expected) }, "\(c.name): no row")
                #expect(near(got.light, row.light.hex), "\(c.name): light \(got.light.hex) vs \(row.light.hex)")
                #expect(near(got.dark, row.dark.hex), "\(c.name): dark \(got.dark.hex) vs \(row.dark.hex)")
            } else if SRGBColor(hex: c.expected) != nil {
                #expect(got.source == .hex, "\(c.name): source")
                #expect(got.light.hex == c.expected.lowercased() && got.dark == got.light, "\(c.name): hex")
            } else {
                // Stored free text ("blue"): the grid's no-colour answer.
                #expect(!stored.isEmpty, "\(c.name): free text is stored")
                #expect(got.source == .name, "\(c.name): source")
                #expect(got == projectAccent(c.input, projects: []), "\(c.name): as if uncoloured")
                #expect(same(got.token, projectColorToken(c.input, projects: [])), "\(c.name): token")
            }
        }
    }

    /// A project storing a colour Organize's tile reads (a theme token or a
    /// `#rrggbb`) draws the same dot on Today as the tile, whatever its name:
    /// every such `colors` row, through a project of that name. A row the
    /// tile cannot read (no colour, "", free text) draws the grid's own
    /// no-colour answer instead, which is the tile's only for some names
    /// (`theDotFollowsTheGridWhereTheTwoRulesDiffer`), so it is checked
    /// against that and never against the tile.
    @Test func projectAccentDrawsWhatTheTileDrawsForAStoredColour() throws {
        var readable = 0
        for c in try load().colors {
            let project = Project(id: "p", name: c.containerName, color: c.color)
            let got = projectAccent(c.containerName, projects: [project])
            guard c.expected.source != "name" else {
                #expect(got.source == .name, "\(c.name): source")
                #expect(got == projectAccent(c.containerName, projects: []), "\(c.name): as if uncoloured")
                continue
            }
            readable += 1
            #expect(got.source.rawValue == c.expected.source, "\(c.name): source")
            #expect(same(got.token, c.expected.token), "\(c.name): token")
            #expect(near(got.light, c.expected.light), "\(c.name): light \(got.light.hex)")
            #expect(near(got.dark, c.expected.dark), "\(c.name): dark \(got.dark.hex)")
            #expect(got == containerAccent(c.color, name: c.containerName), "\(c.name): the tile's")
        }
        #expect(readable > 0, "a readable stored colour")
    }

    /// Every token a project can store, the swatches, the lime and the legacy
    /// three alike, is its own dot. The README's check: a project coloured
    /// Teal on the web is teal on Today.
    @Test func everyStoredTokenIsItsOwnDot() throws {
        let f = try load()
        for row in f.tokens {
            let project = Project(id: "p", name: "Errands", color: row.css)
            let got = projectAccent("ERRANDS", projects: [project])
            #expect(got.source == .token, "\(row.name): source")
            #expect(same(got.token, row.css), "\(row.name): token")
            #expect(near(got.light, row.light.hex), "\(row.name): light \(got.light.hex) vs \(row.light.hex)")
            #expect(near(got.dark, row.dark.hex), "\(row.name): dark \(got.dark.hex) vs \(row.dark.hex)")
        }
        let teal = try #require(f.tokens.first { $0.swatch == "Teal" })
        let dot = projectAccent("Home", projects: [Project(id: "p-home", name: "Home", color: teal.css)])
        #expect(dot.source == .token && dot.token == "var(--accent-2)")
        #expect(near(dot.light, teal.light.hex) && near(dot.dark, teal.dark.hex))
    }

    /// Where the grid's rule and Organize's differ, the dot follows the
    /// grid's, as the web's own grid and tiles differ.
    @Test func theDotFollowsTheGridWhereTheTwoRulesDiffer() {
        // An uncoloured "Work" is the legacy token on the grid, plum on its tile.
        let work = [Project(id: "p-work", name: "Work")]
        #expect(projectAccent("Work", projects: work).token == "var(--habit-work)")
        #expect(projectAccent("Work", projects: work).source == .name)
        #expect(containerAccent(nil, name: "Work").token == "var(--accent-4)")
        for (key, token) in ContainerLook.legacyProjectTokens {
            #expect(projectAccent(key.uppercased(), projects: []).token == token, "\(key)")
        }
        // "" is no colour, as the web's truthiness says.
        #expect(projectAccent("work", projects: [Project(id: "p", name: "Work", color: "")]).token == "var(--habit-work)")
        // An unreadable colour is the grid's no-colour answer, legacy first.
        #expect(projectAccent("Work", projects: [Project(id: "p", name: "Work", color: "blue")]).token == "var(--habit-work)")
        // The FOLDED name's step: U+0100 sums to step 1, its lowercase U+0101
        // to step 2. The tile hashes the raw name.
        let macron = "\u{0100}"
        #expect(projectAccent(macron, projects: []).token == "var(--accent-2)")
        #expect(projectAccent(macron, projects: [Project(id: "p", name: macron, color: "blue")]).token == "var(--accent-2)")
        #expect(containerAccent("blue", name: macron).token == "var(--accent-1)")
        // A name no project row folds to still has a colour: its step, never gray.
        #expect(projectAccent("Fitness", projects: work).token == "var(--accent-5)")
        // Two rows that fold equal: the first wins, as the web's `find` does.
        let twins = [Project(id: "a", name: "home", color: "var(--accent-7)"),
                     Project(id: "b", name: "Home", color: "var(--accent-2)")]
        #expect(projectAccent("HOME", projects: twins).token == "var(--accent-7)")
        // A raw hex, lowercased and the same in both themes.
        let hex = projectAccent("x", projects: [Project(id: "p", name: "X", color: "#1A2B3C")])
        #expect(hex.source == .hex && hex.token == nil && hex.light.hex == "#1a2b3c" && hex.dark == hex.light)
    }

    @Test func resolveCategoryIconNameMatchesTheWeb() throws {
        for c in try load().icons {
            #expect(resolveCategoryIconName(c.glyph, c.containerName) == c.expected, "\(c.name)")
        }
    }

    @Test func hashNameMatchesTheWeb() throws {
        let f = try load()
        for c in f.hash {
            #expect(hashName(c.input) == c.hash, "\(c.name)")
            #expect(hashName(c.input) % ContainerLook.categoryIcons.count == c.index, "\(c.name): index")
        }
        // The int32 edge: -2^31's absolute value is past Int32.
        #expect(f.hash.contains { $0.hash == 2_147_483_648 })
    }

    /// The tables are the web's, so the phone's are pinned, not hand-copied.
    @Test func theTablesAreTheWebs() throws {
        let t = try load().tables
        #expect(ContainerLook.ramp == t.ramp)
        #expect(ContainerLook.swatches == t.swatches)
        #expect(ContainerLook.library == t.library)
        #expect(ContainerLook.featured == t.featured)
        #expect(ContainerLook.categoryIcons == t.categoryIcons)
        #expect(ContainerLook.nameIcons.map(\.key) == t.nameIcons.map(\.key))
        #expect(ContainerLook.nameIcons.map(\.icon) == t.nameIcons.map(\.icon))
        #expect(ContainerLook.keywordIcons.map(\.keywords) == t.keywordIcons.map(\.keywords))
        #expect(ContainerLook.keywordIcons.map(\.icon) == t.keywordIcons.map(\.icon))
        // The swatches name the ramp's tokens, step for step.
        #expect(ContainerLook.tokens.prefix(ContainerLook.rampSize).map(\.swatch) == t.swatches)
        for name in t.library { #expect(ContainerLook.isIconName(name), "\(name)") }
    }

    /// Every name the resolver can answer, and every name the picker offers,
    /// has an SF Symbol; and the map names nothing outside the library.
    @Test func everyGlyphHasASymbol() throws {
        let t = try load().tables
        let reachable = Set(t.library + t.featured + t.categoryIcons + t.nameIcons.map(\.icon) + t.keywordIcons.map(\.icon))
        for name in reachable.sorted() {
            let symbol = ContainerLook.lucideToSymbol[name]
            #expect(symbol != nil && symbol?.isEmpty == false, "no symbol for \(name)")
        }
        #expect(Set(ContainerLook.lucideToSymbol.keys) == Set(t.library))
        for symbol in ContainerLook.lucideToSymbol.values {
            #expect(symbol.unicodeScalars.allSatisfy { $0.isASCII } && !symbol.contains(" "), "\(symbol)")
        }
    }

    @Test func aContainerWearsItsResolvedSymbol() throws {
        for c in try load().icons {
            for kind in OrganizeKind.allCases {
                #expect(containerSymbol(glyph: c.glyph, name: c.containerName, kind: kind) == ContainerLook.lucideToSymbol[c.expected], "\(c.name)")
            }
        }
        #expect(OrganizeKind.routine.fallbackSymbol == "repeat")
        #expect(OrganizeKind.season.fallbackSymbol == "calendar")
        #expect(OrganizeKind.goal.fallbackSymbol == "target")
        #expect(OrganizeKind.project.fallbackSymbol == "folder")
    }

    /// The JavaScript edges the port must keep: a token is matched case for
    /// case, a lookalike of a library name is not one, and a keyword is found
    /// by code unit.
    @Test func theStringEdgesAreJavaScripts() {
        // U+212A KELVIN SIGN is canonically "K"; JavaScript keeps them apart.
        #expect(!ContainerLook.isIconName("\u{212A}ey"))
        #expect(resolveCategoryIconName("icon:\u{212A}ey", "Errands") == categoryIconName("Errands"))
        #expect(resolveCategoryIconName("icon:Key", "Errands") == "Key")
        // "book" + a combining acute: JavaScript still finds "book" in it.
        #expect(categoryIconName("Book\u{301}") == "BookOpen")
        // No colour and an empty colour draw alike: the name's step.
        #expect(containerAccent(nil, name: "Errands").token == containerAccent("", name: "Errands").token)
        #expect(containerAccent("#AABBCC", name: "x").light.hex == "#aabbcc")
        #expect(containerAccent("#AABBCC\n", name: "x").source == .name)
    }
}
