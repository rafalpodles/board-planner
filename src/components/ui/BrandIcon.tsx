"use client";

import {
  siCoda,
  siDiscord,
  siGithub,
  siGitlab,
  siModelcontextprotocol,
} from "simple-icons";

export type BrandId = "github" | "gitlab" | "slack" | "discord" | "coda" | "webhook" | "mcp";

interface Brand {
  title: string;
  /** simple-icons path, or undefined for the two marks drawn below */
  path?: string;
  /** The vendor's own colour, so a row is recognisable before its label is read */
  hex: string;
}

const BRANDS: Record<BrandId, Brand> = {
  github: { title: siGithub.title, path: siGithub.path, hex: `#${siGithub.hex}` },
  gitlab: { title: siGitlab.title, path: siGitlab.path, hex: `#${siGitlab.hex}` },
  discord: { title: siDiscord.title, path: siDiscord.path, hex: `#${siDiscord.hex}` },
  coda: { title: siCoda.title, path: siCoda.path, hex: `#${siCoda.hex}` },
  mcp: {
    title: siModelcontextprotocol.title,
    path: siModelcontextprotocol.path,
    hex: `#${siModelcontextprotocol.hex}`,
  },
  // Slack asked simple-icons to drop their mark, so there is no canonical path to ship.
  // A neutral glyph is honest; an approximation drawn from memory would be a wrong logo.
  slack: { title: "Slack", hex: "#4A154B" },
  webhook: { title: "Webhook", hex: "#64748b" },
};

/** GitHub's mark is nearly black; on the dark theme it needs the foreground instead. */
const NEEDS_THEME_COLOUR = new Set<BrandId>(["github", "mcp"]);

interface BrandIconProps {
  brand: BrandId;
  className?: string;
  /** Tint with the vendor's colour. Off inside a button that already carries a colour. */
  coloured?: boolean;
  /**
   * Inside a control whose text already names the thing. The vendor title would otherwise be
   * read first and become part of that control's name — "Slack Team channels Post board
   * events…" rather than "Team channels…" (BP-510).
   */
  decorative?: boolean;
}

export function BrandIcon({
  brand,
  className = "h-5 w-5",
  coloured = true,
  decorative = false,
}: BrandIconProps) {
  const meta = BRANDS[brand];
  const themed = NEEDS_THEME_COLOUR.has(brand);
  const fill = !coloured || themed ? "currentColor" : meta.hex;

  return (
    <svg
      role={decorative ? "presentation" : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : meta.title}
      viewBox="0 0 24 24"
      className={className}
      fill={fill}
    >
      {meta.path ? (
        <path d={meta.path} />
      ) : brand === "slack" ? (
        // Four rounded bars in a pinwheel — the arrangement Slack's own mark uses,
        // without claiming to be it
        <>
          <rect x="3" y="10.4" width="7.2" height="3.2" rx="1.6" />
          <rect x="10.4" y="13.8" width="3.2" height="7.2" rx="1.6" />
          <rect x="13.8" y="10.4" width="7.2" height="3.2" rx="1.6" />
          <rect x="10.4" y="3" width="3.2" height="7.2" rx="1.6" />
        </>
      ) : (
        // Webhook: a payload leaving for somewhere else
        <path d="M13 3a5 5 0 0 0-4.6 7l-2.6 4.5a3.5 3.5 0 1 0 1.7 1l3.2-5.6A3 3 0 1 1 13 13h6a1 1 0 0 0 0-2h-3.1A5 5 0 0 0 13 3ZM6.5 19.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm11 1.5a3.5 3.5 0 0 0 0-7h-4a1 1 0 0 0 0 2h4a1.5 1.5 0 1 1-1.3 2.2 1 1 0 0 0-1.8.9A3.5 3.5 0 0 0 17.5 21Z" />
      )}
    </svg>
  );
}

export function brandTitle(brand: BrandId): string {
  return BRANDS[brand].title;
}
