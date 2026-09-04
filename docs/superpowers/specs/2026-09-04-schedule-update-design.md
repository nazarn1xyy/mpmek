# Design: Schedule Update for Semester 1 (2026-2027)

## Overview
Update the college schedule for all 28 groups from `Розклад І семестр 26-27 н.р. на 01.09.26.xlsx` into `app/schedule.json` for mpmek.site, preserving existing suspensions (підвіски) and invalidating the service worker cache.

## Scope & Components
1. **app/schedule.json**:
   - 28 groups across 4 courses:
     - 1 Course: БО (Ф)-2026, КСМ-2026-1, КСМ-2026-2, МЕП-2026-1, МЕП-2026-2, БС-2026.
     - 2 Course: БО-2025, Ф-2025, КСМ-2025-1, КСМ-2025-2, МЕП-2025-1, МЕП-2025-2, БС-2025-1, БС-2025-2.
     - 3 Course: БО-2024, Ф-2024, КСМ-2024-1, КСМ-2024-2, МЕП-2024-1, МЕП-2024-2, БС-2024-1, БС-2024-2.
     - 4 Course: КСМ-2023-1, КСМ-2023-2, МЕП-2023-1, МЕП-2023-2, БС-2023-1, БС-2023-2.
   - Preserves 661 existing substitutions (підвіски) mapped to their corresponding groups.
   - Backward compatibility aliases for БО (Ф)-2025 and БС-2025.
   - Pair 0 on Thursday for БС-2026.

2. **app/sw.js**:
   - Bump cache version from `rozklad-v46` to `rozklad-v47` to purge stale client caches.

3. **parse_excel_schedule.py**:
   - Reproducible automation script for future Excel schedule imports.

## Verification
- Validate JSON schema and group availability.
- Ensure all groups render without errors.
