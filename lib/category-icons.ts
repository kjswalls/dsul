import {
  Activity, AlarmClock, Anchor, Apple, Archive, AtSign, Award, Baby,
  Banknote, Battery, Bed, Beef, Bell, BellRing, Bike, Bird,
  Book, BookOpen, Bookmark, Brain, Briefcase, Brush, Bug, Building2,
  Bus, Calculator, Calendar, CalendarCheck, CalendarDays, Camera, Car, Carrot,
  Cat, ChartColumn, ChartLine, ChartPie, Check, Church, CircleCheck, Clapperboard,
  ClipboardList, Clock, Cloud, CloudSun, Code, Coffee, Cog, Coins,
  Compass, Contact, Cookie, Cpu, CreditCard, Cross, Crown, CupSoda,
  Database, Dices, Dog, DollarSign, Drama, Droplets, Dumbbell, Eye,
  Feather, FileText, Film, Fish, Flag, Flame, Flower2, Folder,
  FolderOpen, Footprints, Gamepad2, Gift, Glasses, Globe, Goal, GraduationCap,
  Grid2x2, Guitar, Hammer, Handshake, Hash, Headphones, Heart, HeartPulse,
  Hourglass, House, Image, Inbox, Infinity, Key, Landmark, Layers,
  LayoutGrid, Leaf, Library, Lightbulb, Link, ListChecks, ListTodo, Lock,
  Mail, Map, MapPin, Medal, Megaphone, MessageCircle, MessageSquare, Mic,
  Moon, Mountain, Music, Music2, Navigation, Newspaper, NotebookPen, Package,
  Paintbrush, Palette, Paperclip, PawPrint, PenTool, Pencil, Percent, PersonStanding,
  Phone, Piano, PiggyBank, Pill, Pin, Pizza, Plane, Plug,
  Podcast, Puzzle, Radio, Rainbow, Receipt, Recycle, RefreshCw, Repeat,
  Repeat2, Rocket, Ruler, Salad, School, Scissors, Send, Server,
  Settings, Shield, ShieldCheck, Ship, Shirt, ShoppingBag, ShoppingBasket, ShoppingCart,
  Smile, Snowflake, Sparkle, Sparkles, Sprout, Star, Stethoscope, Store,
  Sun, Sunrise, Sunset, Syringe, Tag, Target, Terminal, Thermometer,
  Ticket, Timer, TramFront, TreePine, Trees, TrendingUp, Trophy, Tv,
  User, UserPlus, Users, Utensils, Video, Wallet, Waves, Wifi,
  Wind, Wrench, Zap,
  type LucideIcon,
} from 'lucide-react';
import { createElement } from 'react';
import { cn } from '@/lib/utils';

/**
 * Lucide icons for categories (projects + habit groups), Linear-style —
 * replaces the emoji palette in group headings, pills, and rows.
 *
 * A category's glyph is stored in its existing `emoji` free-text field (no DB
 * migration): either a real emoji (legacy data) OR an icon token
 * `icon:<PascalName>` written by the icon picker. Rendering ALWAYS resolves to
 * a Lucide icon — a stored icon token wins; otherwise the icon is derived from
 * the category name so legacy emoji rows still show a sensible icon.
 *
 * The library is a CURATED ~195-icon set (explicit named imports, so the
 * bundler tree-shakes to just these). Deliberately not the full ~1.6k
 * lucide-react barrel: that whole set is ~160KB gzipped and, because this
 * module is imported by hot-path components (group headings, pills), it would
 * land in the main first-load bundle for every user. If a user ever needs an
 * icon outside this set, add it here or switch the picker to lucide's lazy
 * `DynamicIcon` — the stored `icon:<name>` token format stays the same.
 */

export const ICON_TOKEN_PREFIX = 'icon:';

export function isIconToken(glyph: string | null | undefined): glyph is string {
  return !!glyph && glyph.startsWith(ICON_TOKEN_PREFIX);
}

export function makeIconToken(pascalName: string): string {
  return `${ICON_TOKEN_PREFIX}${pascalName}`;
}

/** Curated library keyed by PascalCase name (shorthand — keys match imports). */
const ICON_LIBRARY = {
  Activity, AlarmClock, Anchor, Apple, Archive, AtSign, Award, Baby,
  Banknote, Battery, Bed, Beef, Bell, BellRing, Bike, Bird,
  Book, BookOpen, Bookmark, Brain, Briefcase, Brush, Bug, Building2,
  Bus, Calculator, Calendar, CalendarCheck, CalendarDays, Camera, Car, Carrot,
  Cat, ChartColumn, ChartLine, ChartPie, Check, Church, CircleCheck, Clapperboard,
  ClipboardList, Clock, Cloud, CloudSun, Code, Coffee, Cog, Coins,
  Compass, Contact, Cookie, Cpu, CreditCard, Cross, Crown, CupSoda,
  Database, Dices, Dog, DollarSign, Drama, Droplets, Dumbbell, Eye,
  Feather, FileText, Film, Fish, Flag, Flame, Flower2, Folder,
  FolderOpen, Footprints, Gamepad2, Gift, Glasses, Globe, Goal, GraduationCap,
  Grid2x2, Guitar, Hammer, Handshake, Hash, Headphones, Heart, HeartPulse,
  Hourglass, House, Image, Inbox, Infinity, Key, Landmark, Layers,
  LayoutGrid, Leaf, Library, Lightbulb, Link, ListChecks, ListTodo, Lock,
  Mail, Map, MapPin, Medal, Megaphone, MessageCircle, MessageSquare, Mic,
  Moon, Mountain, Music, Music2, Navigation, Newspaper, NotebookPen, Package,
  Paintbrush, Palette, Paperclip, PawPrint, PenTool, Pencil, Percent, PersonStanding,
  Phone, Piano, PiggyBank, Pill, Pin, Pizza, Plane, Plug,
  Podcast, Puzzle, Radio, Rainbow, Receipt, Recycle, RefreshCw, Repeat,
  Repeat2, Rocket, Ruler, Salad, School, Scissors, Send, Server,
  Settings, Shield, ShieldCheck, Ship, Shirt, ShoppingBag, ShoppingBasket, ShoppingCart,
  Smile, Snowflake, Sparkle, Sparkles, Sprout, Star, Stethoscope, Store,
  Sun, Sunrise, Sunset, Syringe, Tag, Target, Terminal, Thermometer,
  Ticket, Timer, TramFront, TreePine, Trees, TrendingUp, Trophy, Tv,
  User, UserPlus, Users, Utensils, Video, Wallet, Waves, Wifi,
  Wind, Wrench, Zap,
} satisfies Record<string, LucideIcon>;

/** A name in the curated library: what an `icon:<name>` token names. */
export type IconName = keyof typeof ICON_LIBRARY;

/**
 * Own keys only: a bare `ICON_LIBRARY[name]` answers `icon:constructor` with
 * Object's constructor, which no renderer can draw.
 */
export function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(ICON_LIBRARY, name);
}

/** Exact-name lookup in the curated library; undefined if the name is unknown. */
export function getIconByName(pascalName: string): LucideIcon | undefined {
  return isIconName(pascalName) ? ICON_LIBRARY[pascalName] : undefined;
}

/** All library entries, sorted — the icon picker iterates this. */
export const ALL_ICON_ENTRIES: [string, LucideIcon][] = Object.entries(ICON_LIBRARY).sort(
  (a, b) => a[0].localeCompare(b[0])
);

/** Nice defaults shown before the user types a search in the icon picker. */
export const FEATURED_ICON_NAMES: string[] = [
  'Briefcase', 'House', 'Leaf', 'HeartPulse', 'Heart', 'Dumbbell', 'BookOpen',
  'GraduationCap', 'Target', 'Star', 'Flame', 'Sparkles', 'Rocket', 'Lightbulb',
  'Brain', 'Pencil', 'Palette', 'Music', 'Gamepad2', 'Footprints', 'Apple',
  'Coffee', 'Sprout', 'DollarSign', 'ChartColumn', 'Wrench', 'Code', 'Bell',
  'Gift', 'Rainbow', 'Sun', 'Moon', 'Clock', 'Calendar', 'CircleCheck', 'Repeat',
] satisfies IconName[];

/*
 * The derivation is stated in library NAMES, and the icon functions below are
 * lookups over it, so the iPhone (ios/DsulCore ContainerLook.swift, which draws
 * an SF Symbol per name) derives the same glyph from the same name. The tables
 * and the answers are pinned by tests/fixtures/organize/look.json.
 */

/** Curated set for name-derivation hashing (a broad, recognizable subset). */
export const CATEGORY_ICON_NAMES: readonly IconName[] = [
  'Briefcase', 'Leaf', 'House', 'BookOpen', 'Dumbbell', 'Target', 'Star', 'Heart', 'Flame',
  'Sparkles', 'Palette', 'Music', 'Footprints', 'Brain', 'Lightbulb', 'Pencil', 'Gamepad2',
  'Apple', 'Coffee', 'Sprout', 'Bell', 'ChartColumn', 'Wrench', 'GraduationCap', 'DollarSign',
  'Rainbow', 'Rocket', 'Gift', 'Sun', 'Moon',
];

/** Exact (case-insensitive) name → icon, covering the default categories. */
export const NAME_ICON_NAMES: Readonly<Record<string, IconName>> = {
  work: 'Briefcase',
  wellness: 'HeartPulse',
  personal: 'House',
  tasks: 'CircleCheck',
  habits: 'Repeat',
  'no project': 'Inbox',
  anytime: 'Clock',
};

/** Substring keyword → icon, first match wins. */
export const KEYWORD_ICON_NAMES: readonly (readonly [readonly string[], IconName])[] = [
  [['gym', 'fitness', 'workout', 'exercise', 'strength'], 'Dumbbell'],
  [['read', 'book'], 'BookOpen'],
  [['money', 'finance', 'budget', 'invest'], 'DollarSign'],
  [['health', 'wellness', 'care'], 'HeartPulse'],
  [['home', 'house', 'chore'], 'House'],
  [['work', 'job', 'office'], 'Briefcase'],
  [['study', 'school', 'learn', 'course', 'class'], 'GraduationCap'],
  [['write', 'writing', 'journal', 'note'], 'Pencil'],
  [['run', 'walk', 'steps'], 'Footprints'],
  [['music', 'song', 'practice'], 'Music'],
  [['art', 'design', 'draw', 'paint'], 'Palette'],
  [['game', 'gaming', 'play'], 'Gamepad2'],
  [['food', 'meal', 'nutrition', 'diet', 'cook'], 'Apple'],
  [['coffee'], 'Coffee'],
  [['garden', 'plant'], 'Sprout'],
  [['code', 'dev', 'build', 'project'], 'Wrench'],
  [['idea', 'brainstorm', 'think'], 'Lightbulb'],
  [['goal', 'focus'], 'Target'],
  [['morning'], 'Sun'],
  [['night', 'evening', 'sleep'], 'Moon'],
  [['launch', 'ship', 'startup'], 'Rocket'],
];

/**
 * Small stable string hash (djb2) so fallback icons never shuffle.
 *
 * JS semantics, which a port must keep: the string is walked in UTF-16 code
 * units, `^` truncates `h * 33` to int32 (ToInt32), and Math.abs of -2^31 is
 * 2^31, past int32. Exported for the fixture that pins those cases.
 */
export function hashName(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = (h * 33) ^ name.charCodeAt(i);
  return Math.abs(h);
}

/** The library name a category's name derives to: every name resolves to something. */
export function categoryIconName(name: string): IconName {
  const key = name.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NAME_ICON_NAMES, key)) return NAME_ICON_NAMES[key];
  for (const [keywords, icon] of KEYWORD_ICON_NAMES) {
    if (keywords.some((k) => key.includes(k))) return icon;
  }
  return CATEGORY_ICON_NAMES[hashName(key) % CATEGORY_ICON_NAMES.length];
}

/**
 * The library name a category's glyph resolves to: a stored `icon:<name>`
 * token naming a library icon wins; anything else (a legacy emoji, an empty
 * glyph, a token for an icon outside the library) derives from the name.
 */
export function resolveCategoryIconName(glyph: string | null | undefined, name: string): IconName {
  if (isIconToken(glyph)) {
    const picked = glyph.slice(ICON_TOKEN_PREFIX.length);
    if (isIconName(picked)) return picked;
  }
  return categoryIconName(name);
}

/** Deterministic icon for a category name — every name resolves to something. */
export function getCategoryIcon(name: string): LucideIcon {
  return ICON_LIBRARY[categoryIconName(name)];
}

/**
 * Resolve a category's glyph to a Lucide icon: a stored `icon:<name>` token
 * wins; otherwise derive from the name (legacy emoji rows fall through here).
 */
export function resolveCategoryIcon(glyph: string | null | undefined, name: string): LucideIcon {
  return ICON_LIBRARY[resolveCategoryIconName(glyph, name)];
}

/**
 * Category glyph for group headings, pills, and rows — ALWAYS a Lucide icon.
 * Pass the stored glyph (`project.emoji` / `group.emoji`) as `glyph` to honor
 * a picked icon; `name` drives the derived fallback. createElement (not
 * <Icon />) so the React Compiler doesn't read the dynamic lookup as a
 * component created during render.
 *
 * Color knob: the default `text-muted-foreground` below sets the Linear-style
 * gray; callers pass `className="text-primary"` to render lime (group headings
 * do this).
 */
export function CategoryIcon({
  glyph,
  name,
  className,
}: {
  glyph?: string | null;
  name: string;
  className?: string;
}) {
  return createElement(resolveCategoryIcon(glyph, name), {
    className: cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', className),
  });
}
