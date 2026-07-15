# F1 Guest Shell Visual QA

## Accepted artifacts

- Concept: `../design/f1-guest-shell-concept.png`
- Desktop browser capture: `f1-desktop-1366x768.png`
- Mobile browser capture: `f1-mobile-360x800.png`

The concept image was inspected before implementation. Both final browser captures were inspected after the last code change.

## Concept comparison

1. **Global hierarchy preserved**: both use a compact brand/navigation row, command entry, restrained amber AI entry, synthetic-data notice, and a narrow index strip before the workspace.
2. **Desktop composition preserved**: the accepted page uses a 270 px left column, 740 px center column, 324 px right column, and a 1,350 px full-width Paper Blotter at 1366 x 768. The three columns do not overlap and the Blotter ends at the viewport bottom.
3. **Information hierarchy preserved**: every data panel follows title → literal outcome → explanation → provenance. Available fixture values use tabular amber numerals; unsupported and failed states contain no primary value.
4. **Visual language preserved**: matte near-black canvas, graphite surfaces, crisp one-pixel rules, off-white terminal text, amber action emphasis, cyan provenance, and text-plus-color state cues match the concept without using the raster as an application asset.
5. **Guest boundaries preserved**: Paper Trading, AI Assistant, and Paper Blotter show explicit login gates. There are no order, portfolio, provider-connection, alert, or layout-save mutations.
6. **Mobile intent preserved and corrected**: the 360 x 800 page is a 344 px aligned single column with a bounded 602 px workspace scroll area, five currently overflowing panel bodies with keyboard-accessible internal scrolling, a horizontal index strip, 44 px minimum application control height, and zero page-level horizontal overflow.

## Intentional differences

- The implementation removes decorative overflow menus and trading controls that would falsely imply finished behavior.
- The command surface includes an explicit accessible submit control and a polite read-only status announcement.
- The chart region is an honest F2 placeholder rather than a fake market chart.
- Scrollable regions are keyboard focusable and visibly outlined; the concept did not express those focus mechanics.
- The accepted prototype's index strip remains above the workspace for scanability, while the required Paper Blotter occupies the full-width bottom row.

## Measurements

- Desktop viewport/page: `1366 x 768` / `1366 x 768`; unsupported outcomes with primary values: `0`.
- Mobile viewport/page: `360 x 800` / `360 x 800`; panel alignment: all `x=8`, `width=344`; unsupported outcomes with primary values: `0`.
- Local release-build browser shell p95, fixed provider delay 20 ms, five warm-ups, no outlier removal: desktop cold/warm `169.14 / 126.78 ms`; mobile cold/warm `570.40 / 500.62 ms`.
- Performance sample sizes: 40 cold profiles and 100 warm navigations per viewport. Desktop uses CPU 2x with 10 Mbps/40 ms; mobile uses CPU 4x with 1.6 Mbps/150 ms.
- Automated browser gate: 10 passed, two duplicate mobile timing lanes intentionally skipped; desktop owns the exact 2 s / 10 s deadline and independent SSE update lanes.
- axe: critical, serious, and color-contrast violations `0` for both target viewports.

This F1 evidence exercises the release build and fixed browser lanes, but it does not claim the canonical dedicated 2 vCPU / 4 GiB release runner. F11 must reproduce the gate on the pinned release runner before shipment.
