# Chrome Web Store listing — Website Page Auditor

Everything below must stay consistent with `privacy.html`, the in-product notice in `popup.html` and the extension's actual behavior. Update all of them together.

## Name

Website Page Auditor

## Short description (manifest, 130 of 132 characters)

Audit the current page for layout, link, form, image, SEO and accessibility issues. Review findings and highlight elements to fix.

## Single purpose

Audit the webpage you're viewing and help you find and review quality issues.

## Category

Developer Tools

## Detailed description

Website Page Auditor checks the webpage you're viewing for common quality problems and shows you exactly where they are.

How it works
1. Open the webpage you want to review and click the extension icon.
2. Read the short notice about what the extension reads, and agree to continue.
3. Press “Check this page”, or run a single category such as Links or Forms.
4. Review the findings, grouped as Issue found, Possible issue, Review manually and No issue found.
5. Click a finding to highlight its element on the page and see the suggested fix.

What it checks
• Layout: page-wide horizontal overflow, clipped or overflowing text, overlapping elements, and content hidden behind fixed headers or footers.
• Responsive: repeats the main checks at the screen sizes you choose.
• Images: broken, distorted, upscaled or oversized images, missing alt text and missing width/height, with a list of the page's images.
• Links: links without a usable destination or accessible name, broken in-page anchors, malformed URLs, links covered by other elements, and broken links on the same site.
• Interactions: controls without an accessible name, clickable-looking elements without proper semantics, and elements that can't get keyboard focus.
• Forms: fields without labels or names, unsuitable input types, error messages not tied to their fields and interactive validation (on by default; can be turned off in Settings).
• Search: whether the site search can be used and whether a test query returns results (on by default; can be turned off in Settings).
• Accessibility: ARIA references, duplicate ids, page language and title, heading structure, roles, dialogs, and focusable content hidden from assistive technology.
• Element sizes: elements wider than their parent, large empty containers, and an overview of the page's size.
• Search appearance: page title length, H1 and H2 headings, image alt attributes, links without an address, the Google tag and the image used in link previews.

Inspect page
Outline headings, tables, positioned or floated elements, external links, insecure resources and deprecated elements to review them visually.

What it doesn't do
Automated checks find common problems on one page at a time. They don't test a whole site, don't guarantee accessibility or compliance with any standard, and don't replace human review. Findings marked “Possible issue” or “Review manually” need a person to confirm them.

Privacy
The extension reads a page only after you agree, and only on the tab where you use it. Findings stay in your browser and are deleted when the tab closes. Nothing is sent to the developer. Additional checks are enabled by default and can be turned off in Settings. Search checks send a real query to the site; external link checks require permission to access all sites. Privacy policy: <PRIVACY_POLICY_URL>

## Privacy practices tab

### Permission justifications

| Permission | Justification |
|---|---|
| activeTab | Runs the audit on the tab where the user clicks the extension icon. |
| scripting | Injects the audit code into that tab when the user starts a check, opens the Search appearance tab or uses an Inspect page tool. Nothing is injected automatically. |
| storage | Keeps the current tab's findings in session storage and the user's settings and consent locally on the device. |
| sidePanel | Lets the user keep the dashboard open in the side panel while interacting with the page. |
| debugger | Required for responsive viewport emulation. Chrome requests it at install time; it is attached only to the audited tab while the responsive check runs. The browser window is not resized. |
| Optional host permission `<all_urls>` | Requested when the user chooses “Allow access to this site” or clicks “Allow access to all sites” for external link checks, which send cookie-free HEAD requests to linked sites. |

Remote code: No. All code is packaged with the extension.

### Data usage

Data collected: **Website content** (page text, structure, styles, links, images, form field labels and settings of the page the user chooses to audit).

Not collected: personally identifiable information, health, financial and payment information, authentication information, personal communications, location, web history, user activity.

Certify:
- Data is not sold or transferred to third parties.
- Data is not used or transferred for purposes unrelated to the single purpose.
- Data is not used or transferred to determine creditworthiness or for lending purposes.

Website content is processed only in the user's browser and is never transmitted to the developer.

Privacy policy URL: host `privacy.html` (it ships inside the extension too) and enter its address here.

## Screenshots (1280×800)

Generated from the real extension by `npm run test:extension` into `store/screenshots/`:

1. `1-page-audit.png` — a completed audit on the Page audit tab with findings grouped by status.
2. `2-finding-details.png` — an expanded finding with its location, details and suggested fix.
3. `3-highlighted-element.png` — the page with the finding's element highlighted.
4. `4-search-appearance.png` — the Search appearance tab with its summary and results.
5. `5-settings-disclosures.png` — Settings showing the optional checks and responsive viewport options.

Before submitting, check that each screenshot still matches the current interface.
