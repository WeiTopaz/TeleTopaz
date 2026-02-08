const ICON_POOL = ["💎", "🔸", "🔹", "♦️", "🔶", "🔷", "💠", "✨", "🔻", "🔺"];

export function pickIcon(used: Set<string>): string {
  for (const icon of ICON_POOL) {
    if (!used.has(icon)) return icon;
  }
  return ICON_POOL[Math.floor(Math.random() * ICON_POOL.length)] ?? "💎";
}

export function getIconPool(): string[] {
  return [...ICON_POOL];
}
