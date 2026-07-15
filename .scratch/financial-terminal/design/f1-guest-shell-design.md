# F1 Guest Terminal Design System

Reference: `f1-guest-shell-concept.png`

The concept is an implementation reference only. The application must reproduce it with semantic HTML and CSS; the raster image is never rendered by the product.

## Visual tokens

- Canvas: matte near-black `#070909`.
- Elevated surface: graphite `#0d1213`; secondary surface `#111718`.
- Divider: crisp 1 px `#2a3334`; active divider `#465052`.
- Primary text: `#f2f4f1`; secondary text: `#aeb8b4`; muted text must remain at least WCAG AA against its surface.
- Accent: restrained amber `#f2a900`; information accent `#55d6e8`.
- Positive and negative colors are secondary to literal state text and never carry meaning alone.
- Terminal chrome uses a compact monospace stack; explanatory Korean uses the system sans-serif stack.
- Corners are square or 2-4 px. No gradients, glow, glass, floating cards, decorative imagery, or fake charts.

## Density and hierarchy

- Desktop target is 1366 x 768: 44 px header, 28 px synthetic notice, 52 px horizontally scrollable index strip, then a 20% / flexible / 24% workstation with a full-width Paper Blotter.
- Panel order is title, primary outcome, explanation, provenance. Available values use tabular numerals.
- Compact panel padding is 10-12 px, row height is at least 32 px on desktop, and interactive controls are at least 44 px on mobile.
- Only `available` outcomes render a primary value. Unavailable and failed outcomes render literal Korean status, provenance where applicable, and retryability without a fabricated number.

## Responsive behavior

- At 720 px and below, the header becomes two rows, the index strip owns horizontal scrolling, and panels form one column.
- The page itself never overflows horizontally. Each long mobile panel has a bounded internal vertical scroll region instead of creating an unbounded prototype page.
- Source order remains header, synthetic notice, index strip, market panels, center information panels, personal gates, Paper Blotter.

## Accessibility and interaction

- Use semantic `header`, `nav`, `main`, `section`, `aside`, and status landmarks.
- Every control has an accessible name and a visible 2 px focus ring. Status changes use a polite atomic live region and never steal focus.
- State is communicated with text plus color. Reduced-motion disables nonessential transitions.
- Guest personal features are explicit `login_required` access states, not Information Outcomes and not active product flows.

## Fidelity decisions

- Keep the concept's high-density grid, restrained amber focus, provenance table, synthetic marker, and explicit status cards.
- Replace decorative/inert concept controls with honest disabled or non-interactive surfaces.
- The concept shows the index strip above the workstation and the ticket calls for a bottom strip; F1 keeps the index strip above the workspace for scanability and adds the required full-width Paper Blotter at the bottom, matching the accepted prototype decision.
