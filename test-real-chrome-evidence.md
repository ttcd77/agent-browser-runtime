# Real-Chrome end-to-end evidence for Step 1-5

Recorded 2026-06-21. Verifies multi-browser routing + read_page DOM walker +
click_ref against the live worktree extension loaded into the user's daily
Chrome via chrome://extensions > Developer mode > Load unpacked.

## Setup

- Worktree bridge: HTTP 17347, WS 17346 (PERSONAL_CHROME_HTTP_PORT/WS_PORT env override)
- Worktree extension: C:\Users\Tong\project\abr-slim\extension (ID bcojflddljdlpgmglpofdjckgjcgigjo)
- Production extension also loaded (ID clpgddncaildipkfklffjianoeocjmbb, connects to 17337 production bridge — untouched)

## Verified live

1. `personal_chrome_list_browsers` → returned worktree extension as
   `name=Windows-fe8c instance=fe8c9c0e-cb46-4ea0-b35f-9fe2049b5303`. Step 1-3 ✓.

2. `personal_chrome_select_browser {browser:"Windows-fe8c"}` → set active. ✓

3. `personal_chrome_open {url:"https://example.com", newTab:true}` → tab opened in worktree Chrome.

4. **`personal_chrome_read_page` on example.com** → returned:
   ```
   heading "Example Domain" [ref_1]
   link "Learn more" [ref_2]
   refCount=2, elementsScanned=6, truncated=false
   ```
   DOM walker ran correctly: tag→role mapping (h1→heading, a→link),
   visibility filter skipped non-interactive nodes, WeakRef map populated.

5. **`personal_chrome_click_ref {ref:"ref_2"}`** → `{ok:true, ref:"ref_2", tag:"a"}`.
   Application-layer `el.click()` triggered the real link.

## Real-SPA stress

- **GitHub Dashboard (logged-in)**: refs=55, elementsScanned=200 (cap),
  user `@ttcd77` content surfaced including avatar / Copilot button / feed
  articles. ARIA role detection correct on banner / navigation / list /
  listitem / button / link / article / heading. Authenticated session
  preserved through the walker.

- **BBC homepage**: refs=96, elementsScanned=300 (cap), truncated=true.
  Deep nesting (link > image + heading + heading + button "Save")
  correctly indented. Bounds (truncated=true) reported faithfully.

## Known limitations (acceptable)

- Walker does not pierce closed Shadow DOM (ABR limitation predates
  this change; existing snapshot tools also don't).
- `chrome://` and `about:` URLs do not trigger content_scripts so
  read_page can't read those (same as Claude in Chrome).
- Chrome 137+ `--load-extension` command-line flag is silently blocked
  by Google; extension must be loaded via chrome://extensions UI
  (Developer mode → Load unpacked). One-time setup per Chrome instance.
