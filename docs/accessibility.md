# Accessibility

CodeOutcome uses native HTML landmarks, controls, tables, headings, and links.
Playwright runs `@axe-core/playwright` against Overview, Sessions, Session
Detail, Tracking Runs, Tracking Detail, Test Runs, Test Detail, and Diagnostics.
The release gate allows no serious or critical axe violations.

## Keyboard operation

- Press Tab first to reveal **Skip to content**, then Enter to move to `main`.
- Use Tab/Shift+Tab for navigation, filters, refresh, theme, and pagination.
- Use Space/Enter for buttons and normal browser keys for native select inputs.
- Tables are focusable scroll regions; use horizontal scrolling on narrow
  screens or when columns exceed the viewport.

Focus has a visible high-contrast outline in light and dark themes. Statuses use
text, a marker shape, and color. Charts expose an accessible summary and a text
legend. Loading and errors use appropriate live status/alert semantics. Reduced
motion disables nonessential transitions and skeleton animation.

## Manual release checklist

- Navigate every primary route and modal-free interaction with keyboard only.
- Check focus visibility, order, and return behavior at 1440, 1280, 768, and
  390 CSS pixels.
- Inspect light, dark, and system themes with increased contrast where available.
- Confirm 200% zoom/reflow, table scroll discoverability, and large Token titles.
- Verify VoiceOver reads page headings, filter groups, table captions, badges,
  chart summaries, empty states, and error remediation in a useful order.
- Verify system reduced-motion preference removes decorative movement.

## Known limitations

Wide metadata tables intentionally scroll rather than collapsing columns. Exact
Token values are available in the DOM and on hover, but touch users may need a
detail page for comfortable reading. Automated axe checks cannot establish the
quality of every screen-reader announcement or the usability of every zoom and
OS contrast combination, so the manual checklist remains required.
