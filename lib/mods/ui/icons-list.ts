/**
 * The icons a mod may draw (memory/plans/mods.md, build order 9): the icon
 * picker's library (ALL_ICON_ENTRIES in lib/category-icons.ts) minus
 * MOD_ICON_DENY. A literal tuple, so this file imports nothing and the tree
 * schema (./tree.ts) and the manifest schema can take it as an enum without
 * pulling lucide in. tests/unit/mods-ui-tree.test.ts holds it to the library.
 */

/**
 * Icons that could pass for the app's own chrome or for something a mod must
 * never seem to ask for: access, settings and the host's mod glyph (Puzzle),
 * AI, identity, money, contact and network, and machines. A name the library
 * does not hold is simply absent from both lists.
 */
export const MOD_ICON_DENY = Object.freeze([
  // Access
  'Key', 'KeyRound', 'Lock', 'LockKeyhole', 'Unlock', 'Shield', 'ShieldCheck', 'Fingerprint', 'Eye', 'EyeOff',
  'ScanFace',
  // Settings and host chrome
  'Settings', 'Settings2', 'Cog', 'SlidersHorizontal', 'Puzzle', 'Hammer', 'Wrench', 'Bell', 'BellRing',
  // AI-like
  'Sparkle', 'Sparkles', 'WandSparkles', 'Brain', 'Bot', 'MessageCircle', 'MessageSquare', 'MessagesSquare',
  // Identity
  'User', 'UserPlus', 'UserCheck', 'Users', 'Contact', 'CircleUser', 'IdCard',
  // Money
  'CreditCard', 'Wallet', 'Landmark', 'Banknote', 'Coins', 'DollarSign', 'Euro', 'PoundSterling', 'PiggyBank',
  'Receipt',
  // Contact and network
  'Mail', 'AtSign', 'Send', 'Phone', 'Link', 'Link2', 'ExternalLink', 'Globe', 'Wifi', 'Plug', 'Share', 'Share2',
  // Machines
  'Terminal', 'Code', 'Server',
] as const);

export const MOD_ICON_NAMES = Object.freeze([
  'Activity', 'AlarmClock', 'Anchor', 'Apple', 'Archive', 'Award', 'Baby', 'Battery', 'Bed',
  'Beef', 'Bike', 'Bird', 'Book', 'Bookmark', 'BookOpen', 'Briefcase', 'Brush', 'Bug', 'Building2',
  'Bus', 'Calculator', 'Calendar', 'CalendarCheck', 'CalendarDays', 'Camera', 'Car', 'Carrot',
  'Cat', 'ChartColumn', 'ChartLine', 'ChartPie', 'Check', 'Church', 'CircleCheck', 'Clapperboard',
  'ClipboardList', 'Clock', 'Cloud', 'CloudSun', 'Coffee', 'Compass', 'Cookie', 'Cpu', 'Cross',
  'Crown', 'CupSoda', 'Database', 'Dices', 'Dog', 'Drama', 'Droplets', 'Dumbbell', 'Feather',
  'FileText', 'Film', 'Fish', 'Flag', 'Flame', 'Flower2', 'Folder', 'FolderOpen', 'Footprints',
  'Gamepad2', 'Gift', 'Glasses', 'Goal', 'GraduationCap', 'Grid2x2', 'Guitar', 'Handshake', 'Hash',
  'Headphones', 'Heart', 'HeartPulse', 'Hourglass', 'House', 'Image', 'Inbox', 'Infinity',
  'Layers', 'LayoutGrid', 'Leaf', 'Library', 'Lightbulb', 'ListChecks', 'ListTodo', 'Map',
  'MapPin', 'Medal', 'Megaphone', 'Mic', 'Moon', 'Mountain', 'Music', 'Music2', 'Navigation',
  'Newspaper', 'NotebookPen', 'Package', 'Paintbrush', 'Palette', 'Paperclip', 'PawPrint',
  'Pencil', 'PenTool', 'Percent', 'PersonStanding', 'Piano', 'Pill', 'Pin', 'Pizza', 'Plane',
  'Podcast', 'Radio', 'Rainbow', 'Recycle', 'RefreshCw', 'Repeat', 'Repeat2', 'Rocket', 'Ruler',
  'Salad', 'School', 'Scissors', 'Ship', 'Shirt', 'ShoppingBag', 'ShoppingBasket', 'ShoppingCart',
  'Smile', 'Snowflake', 'Sprout', 'Star', 'Stethoscope', 'Store', 'Sun', 'Sunrise', 'Sunset',
  'Syringe', 'Tag', 'Target', 'Thermometer', 'Ticket', 'Timer', 'TramFront', 'TreePine', 'Trees',
  'TrendingUp', 'Trophy', 'Tv', 'Utensils', 'Video', 'Waves', 'Wind', 'Zap',
] as const);
export type ModIconName = (typeof MOD_ICON_NAMES)[number];
