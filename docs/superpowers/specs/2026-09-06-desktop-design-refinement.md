# Design: Desktop Version Refinement (Native macOS Aesthetic)

## 1. Overview
Elevate the desktop experience of `mpmek.site` to match native macOS application design standards (Apple Calendar, Notes, Settings). Eliminate awkward wide gaps in week navigation, replace stretched oval day pills with a centered segmented control, remove clumsy background pads from SVGs, and establish clean typographic hierarchy on lesson cards.

---

## 2. Desktop UI Pain Points Addressed

1. **Week Navigation Disconnect**:
   - Previous: Arrows (`<` and `>`) were pushed 700px apart to opposite edges of the screen while dates sat in the center.
   - Solution: Group arrows and dates tightly into a single centered toolbar widget (`[ ‹ ] Наступний тиждень · 07.09 — 11.09 [ › ]`).

2. **Day Selector Bar Stretching**:
   - Previous: 5 day pills stretched across the full 720px container with excessive empty space.
   - Solution: Constrain Day Selector Bar to a compact 480px segmented control with clean `8px` radius and refined active pill indicator.

3. **"No Background Pads on SVGs" (Без подложек под SVG)**:
   - Clean, naked SVG icons for navigation, share, and arrows with subtle, modern hover states (`rgba(120, 120, 128, 0.1)`), removing heavy circular/square backing blobs.

4. **Lesson Card Readability**:
   - High-contrast subject headings (`1.05rem`, `font-weight: 600`).
   - Distinct room badge (`diary-item-room`) with subtle pill styling for quick visual scanning.
   - Left accent line (`3px solid #38bdf8`) for active "ЗАРАЗ" pairs.
   - Refined semi-transparent borders (`1px solid rgba(255, 255, 255, 0.06)`) in dark mode and clean crisp cards in light mode.

5. **Native macOS Sidebar**:
   - Remove harsh `1px` card border from active nav item; use soft, translucent native highlight (`rgba(255, 255, 255, 0.08)`).
   - Group badge at bottom styled as an interactive macOS status chip.

---

## 3. Verification & Isolation
- All changes are scoped strictly to `@media (min-width: 768px)`. Mobile styles remain completely untouched and ergonomic.
- Verified in dark and light modes.
