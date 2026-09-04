# Design and validation

The design reference was generated with the built-in Image Gen tool before coding. Direction: a Chinese public personal application journal, warm off-white background, charcoal text, burnt-orange rejection count, open editorial layout, anonymous table, no invented career metrics.

## Visual implementation

- Header, wordmark, title, subtitle, oversized count, split status summary, filter strip, anonymous table and footer follow the generated reference.
- Corrected the header height, vertical rhythm, five-record page size and light Didot numeral treatment during direct screenshot comparison.
- Checked 1448 × 1086 desktop and 390 × 844 mobile. Mobile adapts the table to stacked rows and the four statistics to a single row; no horizontal overflow.
- Intentional functional differences: accessible status legend with names, accurate rounded percentages (9/28 is 32%, not the mockup's 31%), simplified previous/next pagination, zero-data and loading/error states, authenticated management actions.
- Existing and added functional copy were checked: title, subtitle, count caption, statistics, privacy line, table headers and footer remain consistent. Functional management and empty-state copy implement the requested interactions.
- Compared layout, text hierarchy, font treatment, palette, dividers, table density and controls via view_image on the concept and rendered screenshot. Generated typography is approximated using native system Chinese fonts and Didot/Times fallbacks, so glyph shapes vary by device.

## Browser verification

Used Codex IAB first for simulated-code login, add, edit, rejection-count correction, search, deletion confirmation and logout. IAB viewport capture produced scaling/tiling artifacts, so Chrome through the browser tool was used for final screenshot and responsive verification. Chrome's download-event API timed out, but the CSV files were actually downloaded; filesystem CSV parsing verified all 29 test records, seven columns, Chinese strings and private notes.

Verified on a completely separate, in-memory QA service. No demonstration records are written to the live database. Public/private API tests assert field whitelisting rather than merely hiding elements. Production entrypoint has no test code delivery or login bypass.

## Automated verification

Eight HTTP/SQLite test groups cover public field isolation, unauthenticated writes, full CRUD/count corrections, stale edits/deletes, email allowlist, one-use hashed codes, expiry/attempt limits, resend cooldown, CSRF, invalid dates/payloads, mail failures, restart persistence/session expiry and production cookie flags. TypeScript and Vite production build pass. npm production-dependency audit against the official registry reports zero known vulnerabilities at verification time.

SMTP authentication was verified from the local machine without logging credentials or sending a message. Production SMTP verification and HTTPS/live health checks are part of deployment acceptance.
