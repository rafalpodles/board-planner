import { PROJECT_ICONS } from "@/types";

export interface IconGroup {
  name: string;
  icons: { icon: string; keywords: string }[];
}

export const ICON_GROUPS: IconGroup[] = [
  {
    name: "Planning",
    icons: [
      { icon: "📋", keywords: "clipboard board plan list" },
      { icon: "📝", keywords: "notes writing memo" },
      { icon: "📊", keywords: "chart report analytics" },
      { icon: "📈", keywords: "growth metrics trend" },
      { icon: "🗂️", keywords: "files archive index" },
      { icon: "⏰", keywords: "time deadline schedule" },
      { icon: "🎯", keywords: "goal target objective" },
      { icon: "🏆", keywords: "win milestone award" },
    ],
  },
  {
    name: "Building",
    icons: [
      { icon: "🚀", keywords: "launch release ship" },
      { icon: "🏗️", keywords: "construction platform infra" },
      { icon: "🛠️", keywords: "tools maintenance" },
      { icon: "🔧", keywords: "fix wrench config" },
      { icon: "⚙️", keywords: "settings engine system" },
      { icon: "🧩", keywords: "plugin module integration" },
      { icon: "⚡", keywords: "performance speed fast" },
      { icon: "✨", keywords: "polish new feature" },
    ],
  },
  {
    name: "Engineering",
    icons: [
      { icon: "💻", keywords: "code laptop dev" },
      { icon: "🗄️", keywords: "database storage" },
      { icon: "🌐", keywords: "web network api" },
      { icon: "🔐", keywords: "security auth secrets" },
      { icon: "📦", keywords: "package build artifact" },
      { icon: "🔍", keywords: "search discovery audit" },
      { icon: "🧪", keywords: "testing experiment qa" },
      { icon: "🐛", keywords: "bug defect fix" },
    ],
  },
  {
    name: "Product",
    icons: [
      { icon: "📱", keywords: "mobile app phone" },
      { icon: "🎨", keywords: "design ui brand" },
      { icon: "🎮", keywords: "game play" },
      { icon: "🛒", keywords: "shop commerce checkout" },
      { icon: "💰", keywords: "billing revenue pricing" },
      { icon: "📚", keywords: "docs knowledge library" },
      { icon: "🎬", keywords: "video media film" },
      { icon: "🎵", keywords: "audio music sound" },
    ],
  },
  {
    name: "Other",
    icons: [
      { icon: "💡", keywords: "idea proposal concept" },
      { icon: "🤖", keywords: "agent automation bot" },
      { icon: "🧠", keywords: "ai research thinking" },
      { icon: "🌱", keywords: "growth seed early" },
      { icon: "🔥", keywords: "urgent hot incident" },
      { icon: "🏥", keywords: "health medical care" },
      { icon: "🏠", keywords: "home internal house" },
      { icon: "✈️", keywords: "travel logistics" },
    ],
  },
];

export function iconGroupsCoverWhitelist(): boolean {
  const grouped = ICON_GROUPS.flatMap((g) => g.icons.map((i) => i.icon));
  return (
    grouped.length === PROJECT_ICONS.length &&
    new Set(grouped).size === grouped.length &&
    grouped.every((icon) => PROJECT_ICONS.includes(icon))
  );
}

export function searchIcons(query: string): IconGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return ICON_GROUPS;
  return ICON_GROUPS.map((group) => ({
    name: group.name,
    icons: group.icons.filter(
      (i) => i.keywords.includes(q) || group.name.toLowerCase().includes(q) || i.icon === q
    ),
  })).filter((group) => group.icons.length > 0);
}
