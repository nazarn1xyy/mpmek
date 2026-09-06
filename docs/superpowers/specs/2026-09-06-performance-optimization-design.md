# Design: Web App Performance & Latency Optimization

## 1. Overview & Problem Statement
A thorough codebase and runtime performance audit of `mpmek.site` revealed key bottlenecks affecting first-paint latency, runtime CPU utilization, scroll fluidity, and cache efficiency. This design document establishes the architectural improvements to achieve true 0ms perceived latency and stutter-free 60–120 FPS performance across iOS PWA and desktop browsers.

---

## 2. Identified Bottlenecks & Evidence

### 2.1 Critical Startup ReferenceError (TDZ Bug)
- **Location**: `app/app.js` (lines 8–22).
- **Issue**: On app initialization, local schedule caching logic in `localStorage.getItem('cached_schedule_data')` attempts to write to `LESSON_TIMES` before its lexical declaration with `let LESSON_TIMES = { ... }`.
- **Impact**: In ES6 strict mode, assigning to a `let` variable before declaration throws a `ReferenceError: Cannot access 'LESSON_TIMES' before initialization` within the Temporal Dead Zone (TDZ). The surrounding `try/catch` block swallowed the error silently.
- **Consequence**: `scheduleData` was never restored from `localStorage`. Every single app visit was forced to wait for network roundtrip to `schedule.json` (300–800ms delay), completely breaking the designed instant first paint.

### 2.2 Unnecessary Full DOM Destruction & Layout Thrashing
- **Location**: `app/app.js` (lines 386–388 and 1013–1017).
- **Issue**: Every 60 seconds (live timer interval) and whenever the user returns to the app (`visibilitychange`), `renderSchedule()` is executed.
- **Impact**: Unconditionally clears `diaryContainer.innerHTML = ''`, completely destroying all DOM nodes, recalculating styles, rebuilding day cards, week navigation, and day chips, and re-initializing scroll listeners.
- **Consequence**: Disrupts user scroll positions, triggers paint flashes, and causes battery drain on mobile devices.

### 2.3 Suboptimal HTTP Cache Headers for Static Assets
- **Location**: `vercel.json` (lines 35–45).
- **Issue**: CSS and JS assets are configured with `Cache-Control: public, max-age=0, must-revalidate`.
- **Impact**: Even though asset URLs use version queries (e.g. `style.css?v=74`), browsers without active Service Workers must make conditional 304 revalidation roundtrips to Vercel edge on every load.

### 2.4 Layout Shifts from `content-visibility: auto` on Micro-Lists
- **Location**: `app/style.css` (lines 1683–1684).
- **Issue**: `.diary-day` elements use `content-visibility: auto; contain-intrinsic-size: 0 380px;`.
- **Impact**: For short lists (5 days, ~15–20 cards total), `content-visibility` provides negligible layout savings (<0.5ms) but causes height shifts and scroll jumps as cards abruptly resize when scrolled into view.

### 2.5 Orphaned Search CSS Rules
- **Location**: `app/style.css` (lines 1000–1180).
- **Issue**: ~180 lines of unused styles for the removed search modal, search filter chips, and search cards remain in the stylesheet.
- **Impact**: Bloats CSS size and selector parsing overhead.

### 2.6 Redundant Group Array Sorting on Every Keystroke
- **Location**: `app/app.js` (`renderGroupList`).
- **Issue**: Re-extracts and sorts 50+ group keys on every character typed into the onboarding filter input.

---

## 3. Proposed Architectural Changes

### 3.1 Instant First-Paint Fix
- Declare `let LESSON_TIMES` before the `localStorage` cache recovery block.
- Verify that valid cached data populates `scheduleData` synchronously on `DOMContentLoaded`.
- Call `renderSchedule()` synchronously before any network dispatch, achieving verified 0ms first paint.

### 3.2 Targeted DOM Live Status Updates
- Replace full `renderSchedule()` calls on the 60s timer with a lightweight `updateLessonLiveBadges()` function.
- `updateLessonLiveBadges()` queries existing `.diary-item` DOM elements and updates only the `.badge-now` and `.badge-next` elements in-place without touching the rest of the DOM.
- On `visibilitychange`, only re-render if the newly fetched schedule data contains actual content diffs.

### 3.3 HTTP Immutable Caching
- In `vercel.json`, configure versioned static assets to use `Cache-Control: public, max-age=31536000, immutable`.
- Preserve `no-cache` / `must-revalidate` exclusively for HTML documents and Service Worker scripts (`sw.js`).

### 3.4 Elimination of Scroll Jitter
- Remove `content-visibility: auto` and `contain-intrinsic-size` from `.diary-day`.
- All 5 day sections remain stably rendered, ensuring perfectly smooth `scrollIntoView` animations and deterministic focal scroll-spy calculations.

### 3.5 Style Sheet Purge
- Strip all dead search classes (`.search-sheet`, `.search-modal-input`, `.search-results-list`, etc.) from `app/style.css`.

### 3.6 Memoized Group Directory
- Pre-sort group names once when `scheduleData` is first loaded, and filter against the cached array on user input.

---

## 4. Verification Plan
- **Unit & Logic Checks**: Verify TDZ error elimination and instant cache recovery in Node.
- **Frame Rate & Scroll Jitter**: Verify 60–120 FPS continuous scroll without content pops.
- **Vercel Edge Deployment**: Verify HTTP cache headers and service worker cache hit ratios on `https://mpmek.site`.
