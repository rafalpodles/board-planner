# Board Planner — brand guide

The product is a Kanban workspace for small teams and coding agents. Its identity should feel clear, capable, and grounded in the work. This kit extends the existing identity in `public/logo.svg` and uses the palette from the application.

## Name and copy

Always write **Board Planner**, with two words and both initials capitalized. The public address is **board-planner.com**.

Primary line: **One board. Your team works it. So do your agents.**

Short description: **A shared Kanban workspace for people and coding agents.**

Longer description: **Plan tasks, run sprints, and follow progress on one board. Your team and your coding agents work with the same tasks, permissions, and history.**

Write direct, concrete sentences. Describe the action or outcome. Avoid promises that agents work without oversight or that every task runs automatically.

## Logo

The existing mark is a blue rounded square with three columns of staggered cards. Preserve the arrangement and the opacity of the cards. The primary mark uses `#3B82F6`; navy and reverse variants provide alternatives for monochrome layouts.

Use the horizontal logo when space allows and the mark alone at small sizes. Use the white wordmark on navy backgrounds and the navy wordmark on pale backgrounds. All logo PNGs have transparent backgrounds.

Leave clear space of at least one quarter of the mark's height around the whole logo. Recommended minimum mark size: 24 px; the included 16 px favicon is the small-size exception. Recommended minimum horizontal logo width: 190 px. Do not stretch, rotate, recolor individual cards, or add shadows to the logo.

## Color

| Role | Value | Use |
| --- | --- | --- |
| Brand blue | `#3B82F6` | Mark, highlights and graphics |
| Action blue | `#2563EB` | Buttons and links on pale backgrounds |
| Navy | `#0F172A` | Dark backgrounds and primary text |
| Slate | `#1E293B` | Dark cards and supporting surfaces |
| Paper | `#F8FAFC` | Light backgrounds and reverse text |
| Muted | `#475569` | Secondary text on light backgrounds |
| Review violet | `#C084FC` | Supporting review-state accent |
| Done green | `#4ADE80` | Supporting completion-state accent |

Brand blue, violet and green are graphic accents. For body copy on light surfaces use navy, muted slate, or action blue. Preserve the application's theme-specific semantic colors when implementing UI; these marketing tokens do not replace them.

## Typography

The kit uses **Arial**, with Helvetica and generic sans-serif fallbacks, to stay close to the application's system sans-serif style. Use bold for headlines and the product name; regular for body text. Keep line lengths comfortable and avoid all-caps body text.

SVGs retain editable text. They use locally installed fonts and may vary slightly across systems. PNG exports freeze the appearance and are the safest option when exact typography matters. Use the SVG mark for resolution-independent logo placement.

## Illustration and patterns

`illustrations/shared-board.png` is an AI-generated editorial illustration made with the built-in imagegen tool. It shows an abstract workflow; it is not a screenshot or a promise of specific interface behavior. Its original generation prompt is saved alongside it.

Use the illustration as hero or supporting campaign artwork. Keep overlaid copy away from the detailed board shapes and check its contrast. Board patterns are decorative backgrounds: place text on a separate solid surface.

## Asset sizes

| Asset | Dimensions | Intended placement |
| --- | --- | --- |
| Marks | 512 × 512 | Avatars, identity and logo placement |
| Horizontal logos | 760 × 128 | Navigation, documents and footers |
| Stacked logos | 560 × 304 | Centered covers |
| App icons | 16–1024 px | Favicons, touch icons and app manifests |
| Open Graph cards | 1200 × 630 | Website link previews |
| Square social cards | 1080 × 1080 | Posts and announcements |
| Community headers | 1500 × 500 | General banners; adapt to platform crop |
| Presentation covers | 1600 × 900 | 16:9 slides and video title cards |
| Board patterns | 1200 × 800 | Decorative backgrounds |

Social and banner board graphics are abstract marketing diagrams. They are not screenshots of the application. Light and dark alternatives are provided.

## Catalog and regeneration

Open `index.html` in a browser for previews, category filters and downloads. `manifest.json` lists every asset. `tokens.json` and `tokens.css` contain the reusable palette. The ZIP includes the catalog, guide, assets and generation sources.

Run `node branding/board-planner/build.mjs` from the project to regenerate SVGs, PNGs, icons, tokens, manifest and catalog using the project's existing `sharp` dependency. The generated illustration is preserved. Re-create the ZIP after changing the kit.
