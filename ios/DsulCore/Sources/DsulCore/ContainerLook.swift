import Foundation

// Port of how a container looks: its colour (lib/accent-colors.ts, with the
// grid's project rule `projectColorToken`, which lib/planner-store.ts
// `getProjectColor` answers through) and its glyph (lib/category-icons.ts
// `hashName`, `categoryIconName`, `resolveCategoryIconName`), plus each colour
// token's light and dark value from app/globals.css. Keep in step: a change
// there without the same change here is drift, and a container wears another
// colour or glyph on the phone than on the web. Checked against the web by
// LookFixtureTests (tests/fixtures/organize/look.json, whose writer reads the
// oklch values out of globals.css, so a token edit there fails Vitest until
// the fixture is regenerated).
//
// Foundation only: colours are sRGB components (`SRGBColor`), converted at
// runtime from each token's oklch triple with Björn Ottosson's OKLab matrices
// and the sRGB transfer curve, exactly as the fixture's reference does. The
// SwiftUI `Color` adapter is an app file (Organize/ContainerColor.swift).
//
// Two colour rules, ported as two functions, because the web has two:
// - `containerAccent(_:name:)`, Organize's tile: the stored colour, else
//   `accentColorForName` over the RAW name;
// - `projectColorToken(_:projects:)`, the grid's: the stored colour of the
//   project the name folds to, else a legacy `--habit-*` token, else
//   `accentColorForName` over the FOLDED name.
//
// Glyphs are Lucide names on the web. `ContainerLook.lucideToSymbol` maps each
// name in the curated library to an SF Symbol (Swift-only data, so it is not
// in the fixture; the tests check it covers every name the resolver can
// answer), and a kind's own symbol stands in for a name it lacks.
//
// Strings hash and fold as JavaScript does: UTF-16 code units, `jsTrim`,
// `jsLowercased`, and `hashName`'s ToInt32 arithmetic.

/// One colour as sRGB components in 0...1, gamma-encoded (what `UIColor`'s
/// `red:green:blue:` takes).
public struct SRGBColor: Sendable, Hashable {
    public var red: Double
    public var green: Double
    public var blue: Double

    public init(red: Double, green: Double, blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    /// A 6-digit `#rrggbb` (any case), the only raw colour the phone draws;
    /// nil for anything else, `#abc` included.
    public init?(hex: String) {
        let units = Array(hex.utf16)
        guard units.count == 7, units[0] == 0x23 else { return nil }
        var bytes: [Int] = []
        for i in stride(from: 1, to: 7, by: 2) {
            guard let hi = hexDigit(units[i]), let lo = hexDigit(units[i + 1]) else { return nil }
            bytes.append(hi * 16 + lo)
        }
        self.init(red: Double(bytes[0]) / 255, green: Double(bytes[1]) / 255, blue: Double(bytes[2]) / 255)
    }

    /// "#rrggbb", lowercase, each channel `Math.round(x * 255)`.
    public var hex: String {
        func byte(_ x: Double) -> Int { Int((min(1, max(0, x)) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", byte(red), byte(green), byte(blue))
    }
}

private func hexDigit(_ unit: UInt16) -> Int? {
    switch unit {
    case 0x30...0x39: return Int(unit - 0x30)
    case 0x41...0x46: return Int(unit - 0x41) + 10
    case 0x61...0x66: return Int(unit - 0x61) + 10
    default: return nil
    }
}

/// A colour as globals.css writes it: `oklch(l c h)`, h in degrees.
public struct OKLCH: Sendable, Hashable {
    public var l: Double
    public var c: Double
    public var h: Double

    public init(l: Double, c: Double, h: Double) {
        self.l = l
        self.c = c
        self.h = h
    }

    /// Ottosson's OKLab → linear sRGB, then the sRGB transfer curve, clamped
    /// to 0...1 (every token is in gamut, so the clamp changes nothing).
    public var srgb: SRGBColor {
        let hr = h * Double.pi / 180
        let a = c * cos(hr)
        let b = c * sin(hr)
        let l_ = l + 0.3963377774 * a + 0.2158037573 * b
        let m_ = l - 0.1055613458 * a - 0.0638541728 * b
        let s_ = l - 0.0894841775 * a - 1.291485548 * b
        let L = l_ * l_ * l_
        let M = m_ * m_ * m_
        let S = s_ * s_ * s_
        func gamma(_ x: Double) -> Double {
            let encoded = x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
            return min(1, max(0, encoded))
        }
        return SRGBColor(
            red: gamma(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
            green: gamma(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
            blue: gamma(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S)
        )
    }
}

/// One theme colour token a container can name, with its value in each theme.
public struct ColorToken: Sendable, Hashable {
    /// "accent-1" … "accent-8", "habit-wellness", "habit-work", "habit-personal".
    public var name: String
    /// What a container stores: "var(--accent-1)".
    public var css: String
    /// The colour picker's name (`ACCENT_NAMES`) for a ramp step; nil for the
    /// three legacy tokens, which the picker never offers.
    public var swatch: String?
    /// globals.css `:root`.
    public var light: OKLCH
    /// globals.css `.dark`.
    public var dark: OKLCH

    public init(name: String, swatch: String?, light: OKLCH, dark: OKLCH) {
        self.name = name
        self.css = "var(--\(name))"
        self.swatch = swatch
        self.light = light
        self.dark = dark
    }
}

/// How Organize draws a container's colour (`containerAccent`): where it came
/// from, the token when it is one, and the value in each theme.
public struct ContainerAccent: Sendable, Hashable {
    public enum Source: String, Sendable, Hashable {
        /// A stored theme token.
        case token
        /// A stored `#rrggbb`, the same in both themes.
        case hex
        /// No usable stored colour: the name's ramp step.
        case name
    }

    public var source: Source
    /// The token drawn ("var(--accent-3)"); nil for a raw hex.
    public var token: String?
    public var light: SRGBColor
    public var dark: SRGBColor

    public init(source: Source, token: String?, light: SRGBColor, dark: SRGBColor) {
        self.source = source
        self.token = token
        self.light = light
        self.dark = dark
    }
}

/// The tables, as the web declares them.
public enum ContainerLook {
    /// lib/accent-colors.ts `ACCENT_RAMP_SIZE`.
    public static let rampSize = 8

    /// lib/accent-colors.ts `ACCENT_RAMP`: "var(--accent-1)" … "var(--accent-8)".
    public static let ramp: [String] = (1...rampSize).map { "var(--accent-\($0))" }

    /// lib/accent-colors.ts `ACCENT_NAMES`: the picker's names for the ramp.
    public static let swatches: [String] = ["Moss", "Teal", "Indigo", "Plum", "Coral", "Honey", "Slate", "Lime"]

    /// The ramp, then the three legacy tokens, with globals.css' oklch values
    /// (`:root` and `.dark`).
    public static let tokens: [ColorToken] = [
        ColorToken(name: "accent-1", swatch: "Moss", light: OKLCH(l: 0.68, c: 0.11, h: 140), dark: OKLCH(l: 0.66, c: 0.10, h: 140)),
        ColorToken(name: "accent-2", swatch: "Teal", light: OKLCH(l: 0.68, c: 0.10, h: 190), dark: OKLCH(l: 0.66, c: 0.09, h: 190)),
        ColorToken(name: "accent-3", swatch: "Indigo", light: OKLCH(l: 0.62, c: 0.11, h: 265), dark: OKLCH(l: 0.64, c: 0.11, h: 265)),
        ColorToken(name: "accent-4", swatch: "Plum", light: OKLCH(l: 0.66, c: 0.11, h: 320), dark: OKLCH(l: 0.66, c: 0.10, h: 320)),
        ColorToken(name: "accent-5", swatch: "Coral", light: OKLCH(l: 0.68, c: 0.13, h: 30), dark: OKLCH(l: 0.66, c: 0.12, h: 30)),
        ColorToken(name: "accent-6", swatch: "Honey", light: OKLCH(l: 0.75, c: 0.11, h: 85), dark: OKLCH(l: 0.72, c: 0.10, h: 85)),
        ColorToken(name: "accent-7", swatch: "Slate", light: OKLCH(l: 0.60, c: 0.04, h: 250), dark: OKLCH(l: 0.62, c: 0.04, h: 250)),
        ColorToken(name: "accent-8", swatch: "Lime", light: OKLCH(l: 0.78, c: 0.14, h: 125), dark: OKLCH(l: 0.76, c: 0.13, h: 125)),
        ColorToken(name: "habit-wellness", swatch: nil, light: OKLCH(l: 0.72, c: 0.10, h: 160), dark: OKLCH(l: 0.62, c: 0.09, h: 160)),
        ColorToken(name: "habit-work", swatch: nil, light: OKLCH(l: 0.65, c: 0.09, h: 250), dark: OKLCH(l: 0.62, c: 0.09, h: 250)),
        ColorToken(name: "habit-personal", swatch: nil, light: OKLCH(l: 0.70, c: 0.09, h: 320), dark: OKLCH(l: 0.64, c: 0.08, h: 320)),
    ]

    /// The token a stored colour names, matched exactly ("var(--accent-3)").
    public static func token(css: String) -> ColorToken? {
        return tokens.first { $0.css.utf16.elementsEqual(css.utf16) }
    }

    /// lib/accent-colors.ts `LEGACY_PROJECT_TOKENS`, by folded project name.
    public static let legacyProjectTokens: [String: String] = [
        "wellness": "var(--habit-wellness)",
        "work": "var(--habit-work)",
        "personal": "var(--habit-personal)",
    ]

    /// lib/category-icons.ts `ICON_TOKEN_PREFIX`.
    public static let iconTokenPrefix = "icon:"

    /// lib/category-icons.ts `ICON_LIBRARY`'s names, sorted by code unit: the
    /// names an `icon:<name>` token may pick.
    public static let library: [String] = [
        "Activity", "AlarmClock", "Anchor", "Apple", "Archive", "AtSign", "Award", "Baby",
        "Banknote", "Battery", "Bed", "Beef", "Bell", "BellRing", "Bike", "Bird",
        "Book", "BookOpen", "Bookmark", "Brain", "Briefcase", "Brush", "Bug", "Building2",
        "Bus", "Calculator", "Calendar", "CalendarCheck", "CalendarDays", "Camera", "Car", "Carrot",
        "Cat", "ChartColumn", "ChartLine", "ChartPie", "Check", "Church", "CircleCheck", "Clapperboard",
        "ClipboardList", "Clock", "Cloud", "CloudSun", "Code", "Coffee", "Cog", "Coins",
        "Compass", "Contact", "Cookie", "Cpu", "CreditCard", "Cross", "Crown", "CupSoda",
        "Database", "Dices", "Dog", "DollarSign", "Drama", "Droplets", "Dumbbell", "Eye",
        "Feather", "FileText", "Film", "Fish", "Flag", "Flame", "Flower2", "Folder",
        "FolderOpen", "Footprints", "Gamepad2", "Gift", "Glasses", "Globe", "Goal", "GraduationCap",
        "Grid2x2", "Guitar", "Hammer", "Handshake", "Hash", "Headphones", "Heart", "HeartPulse",
        "Hourglass", "House", "Image", "Inbox", "Infinity", "Key", "Landmark", "Layers",
        "LayoutGrid", "Leaf", "Library", "Lightbulb", "Link", "ListChecks", "ListTodo", "Lock",
        "Mail", "Map", "MapPin", "Medal", "Megaphone", "MessageCircle", "MessageSquare", "Mic",
        "Moon", "Mountain", "Music", "Music2", "Navigation", "Newspaper", "NotebookPen", "Package",
        "Paintbrush", "Palette", "Paperclip", "PawPrint", "PenTool", "Pencil", "Percent", "PersonStanding",
        "Phone", "Piano", "PiggyBank", "Pill", "Pin", "Pizza", "Plane", "Plug",
        "Podcast", "Puzzle", "Radio", "Rainbow", "Receipt", "Recycle", "RefreshCw", "Repeat",
        "Repeat2", "Rocket", "Ruler", "Salad", "School", "Scissors", "Send", "Server",
        "Settings", "Shield", "ShieldCheck", "Ship", "Shirt", "ShoppingBag", "ShoppingBasket", "ShoppingCart",
        "Smile", "Snowflake", "Sparkle", "Sparkles", "Sprout", "Star", "Stethoscope", "Store",
        "Sun", "Sunrise", "Sunset", "Syringe", "Tag", "Target", "Terminal", "Thermometer",
        "Ticket", "Timer", "TramFront", "TreePine", "Trees", "TrendingUp", "Trophy", "Tv",
        "User", "UserPlus", "Users", "Utensils", "Video", "Wallet", "Waves", "Wifi",
        "Wind", "Wrench", "Zap",
    ]

    private static let librarySet = Set(library)

    /// Is `name` exactly a library name? Code unit for code unit: every name
    /// is ASCII, so a Swift `Set` hit on a non-ASCII string (canonically
    /// equal, as "\u{212A}ey" is to "Key") is not one, as `hasOwnProperty`
    /// would say.
    public static func isIconName(_ name: String) -> Bool {
        return name.unicodeScalars.allSatisfy(\.isASCII) && librarySet.contains(name)
    }

    /// lib/category-icons.ts `FEATURED_ICON_NAMES`: the icon picker's grid, in order.
    public static let featured: [String] = [
        "Briefcase", "House", "Leaf", "HeartPulse", "Heart", "Dumbbell", "BookOpen",
        "GraduationCap", "Target", "Star", "Flame", "Sparkles", "Rocket", "Lightbulb",
        "Brain", "Pencil", "Palette", "Music", "Gamepad2", "Footprints", "Apple",
        "Coffee", "Sprout", "DollarSign", "ChartColumn", "Wrench", "Code", "Bell",
        "Gift", "Rainbow", "Sun", "Moon", "Clock", "Calendar", "CircleCheck", "Repeat",
    ]

    /// lib/category-icons.ts `CATEGORY_ICON_NAMES`: the set a name's hash picks from.
    public static let categoryIcons: [String] = [
        "Briefcase", "Leaf", "House", "BookOpen", "Dumbbell", "Target", "Star", "Heart", "Flame",
        "Sparkles", "Palette", "Music", "Footprints", "Brain", "Lightbulb", "Pencil", "Gamepad2",
        "Apple", "Coffee", "Sprout", "Bell", "ChartColumn", "Wrench", "GraduationCap", "DollarSign",
        "Rainbow", "Rocket", "Gift", "Sun", "Moon",
    ]

    /// lib/category-icons.ts `NAME_ICON_NAMES`: an exact (trimmed, folded) name.
    public static let nameIcons: [(key: String, icon: String)] = [
        ("work", "Briefcase"),
        ("wellness", "HeartPulse"),
        ("personal", "House"),
        ("tasks", "CircleCheck"),
        ("habits", "Repeat"),
        ("no project", "Inbox"),
        ("anytime", "Clock"),
    ]

    /// lib/category-icons.ts `KEYWORD_ICON_NAMES`: a substring, first row wins.
    public static let keywordIcons: [(keywords: [String], icon: String)] = [
        (["gym", "fitness", "workout", "exercise", "strength"], "Dumbbell"),
        (["read", "book"], "BookOpen"),
        (["money", "finance", "budget", "invest"], "DollarSign"),
        (["health", "wellness", "care"], "HeartPulse"),
        (["home", "house", "chore"], "House"),
        (["work", "job", "office"], "Briefcase"),
        (["study", "school", "learn", "course", "class"], "GraduationCap"),
        (["write", "writing", "journal", "note"], "Pencil"),
        (["run", "walk", "steps"], "Footprints"),
        (["music", "song", "practice"], "Music"),
        (["art", "design", "draw", "paint"], "Palette"),
        (["game", "gaming", "play"], "Gamepad2"),
        (["food", "meal", "nutrition", "diet", "cook"], "Apple"),
        (["coffee"], "Coffee"),
        (["garden", "plant"], "Sprout"),
        (["code", "dev", "build", "project"], "Wrench"),
        (["idea", "brainstorm", "think"], "Lightbulb"),
        (["goal", "focus"], "Target"),
        (["morning"], "Sun"),
        (["night", "evening", "sleep"], "Moon"),
        (["launch", "ship", "startup"], "Rocket"),
    ]

    /// Lucide name → SF Symbol, for every library name. Swift-only data: the
    /// nearest system symbol, never a brand logo. Where the system has no
    /// match the nearest meaning stands in (Rocket is a paper plane, Pizza a
    /// fork and knife). The hosted OrganizeLookTests checks each symbol exists.
    public static let lucideToSymbol: [String: String] = [
        "Activity": "waveform.path.ecg",
        "AlarmClock": "alarm",
        "Anchor": "sailboat",
        "Apple": "carrot",
        "Archive": "archivebox",
        "AtSign": "at",
        "Award": "rosette",
        "Baby": "stroller",
        "Banknote": "banknote",
        "Battery": "battery.100",
        "Bed": "bed.double",
        "Beef": "fork.knife",
        "Bell": "bell",
        "BellRing": "bell.badge",
        "Bike": "bicycle",
        "Bird": "bird",
        "Book": "book.closed",
        "BookOpen": "book",
        "Bookmark": "bookmark",
        "Brain": "brain",
        "Briefcase": "briefcase",
        "Brush": "paintbrush.pointed",
        "Bug": "ladybug",
        "Building2": "building.2",
        "Bus": "bus",
        "Calculator": "plus.forwardslash.minus",
        "Calendar": "calendar",
        "CalendarCheck": "calendar.badge.checkmark",
        "CalendarDays": "calendar",
        "Camera": "camera",
        "Car": "car",
        "Carrot": "carrot",
        "Cat": "cat",
        "ChartColumn": "chart.bar",
        "ChartLine": "chart.line.uptrend.xyaxis",
        "ChartPie": "chart.pie",
        "Check": "checkmark",
        "Church": "building.columns",
        "CircleCheck": "checkmark.circle",
        "Clapperboard": "film",
        "ClipboardList": "doc.on.clipboard",
        "Clock": "clock",
        "Cloud": "cloud",
        "CloudSun": "cloud.sun",
        "Code": "chevron.left.forwardslash.chevron.right",
        "Coffee": "cup.and.saucer",
        "Cog": "gearshape",
        "Coins": "dollarsign.circle",
        "Compass": "location.north",
        "Contact": "person.crop.rectangle",
        "Cookie": "fork.knife",
        "Cpu": "cpu",
        "CreditCard": "creditcard",
        "Cross": "cross",
        "Crown": "crown",
        "CupSoda": "takeoutbag.and.cup.and.straw",
        "Database": "cylinder.split.1x2",
        "Dices": "die.face.5",
        "Dog": "dog",
        "DollarSign": "dollarsign",
        "Drama": "theatermasks",
        "Droplets": "drop",
        "Dumbbell": "dumbbell",
        "Eye": "eye",
        "Feather": "pencil.tip",
        "FileText": "doc.text",
        "Film": "film",
        "Fish": "fish",
        "Flag": "flag",
        "Flame": "flame",
        "Flower2": "camera.macro",
        "Folder": "folder",
        "FolderOpen": "folder",
        "Footprints": "figure.walk",
        "Gamepad2": "gamecontroller",
        "Gift": "gift",
        "Glasses": "eyeglasses",
        "Globe": "globe",
        "Goal": "scope",
        "GraduationCap": "graduationcap",
        "Grid2x2": "square.grid.2x2",
        "Guitar": "guitars",
        "Hammer": "hammer",
        "Handshake": "hand.raised",
        "Hash": "number",
        "Headphones": "headphones",
        "Heart": "heart",
        "HeartPulse": "bolt.heart",
        "Hourglass": "hourglass",
        "House": "house",
        "Image": "photo",
        "Inbox": "tray",
        "Infinity": "infinity",
        "Key": "key",
        "Landmark": "building.columns",
        "Layers": "square.stack.3d.up",
        "LayoutGrid": "square.grid.2x2",
        "Leaf": "leaf",
        "Library": "books.vertical",
        "Lightbulb": "lightbulb",
        "Link": "link",
        "ListChecks": "checklist",
        "ListTodo": "list.bullet",
        "Lock": "lock",
        "Mail": "envelope",
        "Map": "map",
        "MapPin": "mappin",
        "Medal": "medal",
        "Megaphone": "megaphone",
        "MessageCircle": "bubble.left",
        "MessageSquare": "text.bubble",
        "Mic": "mic",
        "Moon": "moon",
        "Mountain": "mountain.2",
        "Music": "music.note",
        "Music2": "music.quarternote.3",
        "Navigation": "location",
        "Newspaper": "newspaper",
        "NotebookPen": "square.and.pencil",
        "Package": "shippingbox",
        "Paintbrush": "paintbrush",
        "Palette": "paintpalette",
        "Paperclip": "paperclip",
        "PawPrint": "pawprint",
        "PenTool": "pencil.and.outline",
        "Pencil": "pencil",
        "Percent": "percent",
        "PersonStanding": "figure.stand",
        "Phone": "phone",
        "Piano": "pianokeys",
        "PiggyBank": "banknote",
        "Pill": "pill",
        "Pin": "pin",
        "Pizza": "fork.knife",
        "Plane": "airplane",
        "Plug": "powerplug",
        "Podcast": "antenna.radiowaves.left.and.right",
        "Puzzle": "puzzlepiece",
        "Radio": "radio",
        "Rainbow": "rainbow",
        "Receipt": "doc.plaintext",
        "Recycle": "arrow.3.trianglepath",
        "RefreshCw": "arrow.clockwise",
        "Repeat": "repeat",
        "Repeat2": "arrow.2.squarepath",
        "Rocket": "paperplane",
        "Ruler": "ruler",
        "Salad": "carrot",
        "School": "graduationcap",
        "Scissors": "scissors",
        "Send": "paperplane",
        "Server": "server.rack",
        "Settings": "gearshape",
        "Shield": "shield",
        "ShieldCheck": "checkmark.shield",
        "Ship": "ferry",
        "Shirt": "tshirt",
        "ShoppingBag": "bag",
        "ShoppingBasket": "basket",
        "ShoppingCart": "cart",
        "Smile": "face.smiling",
        "Snowflake": "snowflake",
        "Sparkle": "sparkle",
        "Sparkles": "sparkles",
        "Sprout": "leaf",
        "Star": "star",
        "Stethoscope": "stethoscope",
        "Store": "storefront",
        "Sun": "sun.max",
        "Sunrise": "sunrise",
        "Sunset": "sunset",
        "Syringe": "syringe",
        "Tag": "tag",
        "Target": "target",
        "Terminal": "terminal",
        "Thermometer": "thermometer.medium",
        "Ticket": "ticket",
        "Timer": "timer",
        "TramFront": "tram",
        "TreePine": "tree",
        "Trees": "tree",
        "TrendingUp": "chart.line.uptrend.xyaxis",
        "Trophy": "trophy",
        "Tv": "tv",
        "User": "person",
        "UserPlus": "person.badge.plus",
        "Users": "person.2",
        "Utensils": "fork.knife",
        "Video": "video",
        "Wallet": "wallet.pass",
        "Waves": "water.waves",
        "Wifi": "wifi",
        "Wind": "wind",
        "Wrench": "wrench.adjustable",
        "Zap": "bolt",
    ]
}

extension OrganizeKind {
    /// The symbol a container of this kind wears when its glyph's name has no
    /// SF Symbol in `ContainerLook.lucideToSymbol`.
    public var fallbackSymbol: String {
        switch self {
        case .routine: return "repeat"
        case .season: return "calendar"
        case .goal: return "target"
        case .project: return "folder"
        }
    }
}

/// lib/accent-colors.ts `accentColorForName`: the ramp token a name hashes to,
/// the sum of its UTF-16 code units mod 8. The RAW name: no trim, no fold, so
/// "Café" (precomposed) and "Cafe\u{301}" can differ.
public func accentColorForName(_ name: String) -> String {
    let sum = name.utf16.reduce(0) { $0 + Int($1) }
    return "var(--accent-\(sum % ContainerLook.rampSize + 1))"
}

/// lib/accent-colors.ts `projectColorToken` (the grid's `getProjectColor`):
/// the stored colour of the project `name` folds to, when it has one (passed
/// through untouched, free text included); else the legacy `--habit-*` token
/// for a folded "wellness", "work" or "personal"; else the folded name's ramp
/// step. Not Organize's rule (`containerAccent`).
public func projectColorToken(_ name: String, projects: [Project]) -> String {
    let folded = jsLowercased(name)
    let foldedUnits = Array(folded.utf16)
    let project = projects.first { jsLowercased($0.name).utf16.elementsEqual(foldedUnits) }
    if let color = project?.color, !color.isEmpty { return color }
    if let legacy = ContainerLook.legacyProjectTokens.first(where: { $0.key.utf16.elementsEqual(foldedUnits) }) {
        return legacy.value
    }
    return accentColorForName(folded)
}

/// Organize's tile colour (the web's `color ?? accentColorForName(name)`),
/// as the phone draws it: a stored theme token from `ContainerLook.tokens`; a
/// stored `#rrggbb`, lowercased and the same in both themes; anything else (a
/// CSS name, `#abc`, an unknown token, "") is the RAW name's ramp step, where
/// the web would hand CSS a value it cannot read.
public func containerAccent(_ color: String?, name: String) -> ContainerAccent {
    func ramp(_ source: ContainerAccent.Source) -> ContainerAccent {
        // accentColorForName always names a ramp step, so the token is there.
        let token = ContainerLook.token(css: accentColorForName(name)) ?? ContainerLook.tokens[0]
        return ContainerAccent(source: source, token: token.css, light: token.light.srgb, dark: token.dark.srgb)
    }
    guard let color else { return ramp(.name) }
    if let token = ContainerLook.token(css: color) {
        return ContainerAccent(source: .token, token: token.css, light: token.light.srgb, dark: token.dark.srgb)
    }
    if let raw = SRGBColor(hex: color) {
        return ContainerAccent(source: .hex, token: nil, light: raw, dark: raw)
    }
    return ramp(.name)
}

/// lib/category-icons.ts `hashName`: djb2 over UTF-16 code units, with
/// JavaScript's arithmetic. `h * 33` is truncated to int32 before the `^`
/// (ToInt32), and `Math.abs` of -2^31 is 2^31, so the answer is taken in 64
/// bits and is never negative.
public func hashName(_ name: String) -> Int {
    var h: Int32 = 5381
    for unit in name.utf16 {
        h = Int32(truncatingIfNeeded: Int64(h) &* 33) ^ Int32(unit)
    }
    return Int(abs(Int64(h)))
}

/// `haystack.includes(needle)` in JavaScript: by UTF-16 code unit.
private func jsIncludes(_ haystack: [UInt16], _ needle: [UInt16]) -> Bool {
    if needle.isEmpty { return true }
    guard haystack.count >= needle.count else { return false }
    for start in 0...(haystack.count - needle.count) where haystack[start] == needle[0] {
        if haystack[start..<(start + needle.count)].elementsEqual(needle) { return true }
    }
    return false
}

/// lib/category-icons.ts `categoryIconName`: the library name a container's
/// name derives to, so every name has a glyph. Trimmed and folded, then an
/// exact default name, then the first keyword row with a substring in it,
/// then the hash into `ContainerLook.categoryIcons`.
public func categoryIconName(_ name: String) -> String {
    let key = jsLowercased(jsTrim(name))
    let units = Array(key.utf16)
    if let exact = ContainerLook.nameIcons.first(where: { $0.key.utf16.elementsEqual(units) }) {
        return exact.icon
    }
    for row in ContainerLook.keywordIcons where row.keywords.contains(where: { jsIncludes(units, Array($0.utf16)) }) {
        return row.icon
    }
    return ContainerLook.categoryIcons[hashName(key) % ContainerLook.categoryIcons.count]
}

/// lib/category-icons.ts `resolveCategoryIconName`: a stored `icon:<name>`
/// token naming a library icon wins (case-sensitive); anything else (a
/// legacy emoji, an empty or missing glyph, a token outside the library such
/// as the web's default season glyph `icon:CalendarRange`) derives from the
/// name. A project's glyph is its `emoji` field.
public func resolveCategoryIconName(_ glyph: String?, _ name: String) -> String {
    if let glyph, glyph.utf16.starts(with: ContainerLook.iconTokenPrefix.utf16) {
        let picked = String(String.UnicodeScalarView(glyph.unicodeScalars.dropFirst(ContainerLook.iconTokenPrefix.unicodeScalars.count)))
        if ContainerLook.isIconName(picked) { return picked }
    }
    return categoryIconName(name)
}

/// The SF Symbol a container wears: its resolved Lucide name's symbol, or its
/// kind's own (`OrganizeKind.fallbackSymbol`) for a name the map lacks.
public func containerSymbol(glyph: String?, name: String, kind: OrganizeKind) -> String {
    return ContainerLook.lucideToSymbol[resolveCategoryIconName(glyph, name)] ?? kind.fallbackSymbol
}
