# Chrome Web Store listing — Website Page Auditor

Use this as the source of truth for the listing and dashboard disclosures. Keep it aligned with `privacy.html`, the in-product notice and extension behavior.

## Name

Website Page Auditor

## Short description

Audit the current page for layout, link, form, image, SEO and accessibility issues. Review findings and highlight elements to fix.

## Single purpose

Audit the webpage the user chooses and help them find and review quality issues.

## Category

Developer Tools

## Detailed description

Website Page Auditor checks one webpage you choose for common quality problems and shows where they appear. Run an audit, review the findings, and highlight an element to see its location and a suggested fix.

**How it works**

1. Open the webpage you want to review and click the extension icon.
2. Review the data notice and agree before the extension reads the page.
3. Choose **Check this page** or run one category.
4. Review findings grouped by status and severity.
5. Select a finding to highlight its element and review the evidence and suggested fix.

On first installation, a welcome page introduces the workflow and privacy choices. You can open an optional exit survey from Settings before uninstalling. If you submit it, Gmail opens a draft addressed to `example@gmail.com`; the user must press Send for the publisher to receive feedback. **Replace this temporary recipient before publishing.**

**Checks include**

- **Layout and responsive:** horizontal overflow, clipping, overlap, fixed bars, and selected viewport sizes.
- **Images:** broken, distorted, oversized or cropped images, alt text and dimensions.
- **Links:** missing destinations or accessible names, broken anchors, link status, and covered links.
- **Interactions and forms:** control names, keyboard focus, labels and validation. Interactive checks are off until you enable them in Settings.
- **Search:** search field behavior and, if enabled in Settings, a test query sent to the site's own search.
- **Accessibility:** ARIA references, duplicate IDs, document language, title, headings, roles, dialogs, and hidden focusable content.
- **Element sizes and search appearance:** oversized elements, page title and headings, image alt text, link preview image and related signals.
- **Inspect page:** temporarily outline headings, tables, positioned elements, external links, insecure resources and deprecated elements.

**Privacy and permissions**

The extension reads the selected page only after you agree to the in-product notice and start a page feature. Page content and results are processed on your device and are not sent to the developer or an extension server. Findings for a tab are kept in temporary browser storage and are cleared when the tab closes or navigates to another page. Image checks may reload image URLs already referenced by the page. The optional exit survey sends only the feedback you enter to Gmail to prepare a draft; Google receives it, and the developer receives it only if you press Send. Do not include sensitive information.

Optional checks that interact with the page or send requests are off by default. If enabled, same-site link checks use your existing session; test search sends your chosen query to the site and may navigate; form checks use sample values and block real submissions; tab and focus checks briefly open and close page controls. External link checks need optional site access and send cookie-free requests to linked sites.

Responsive checks use Chrome's required **debugger** permission. Chrome asks for this permission when you install the extension. It is attached only to the tab being audited, only while the relevant check runs, and then detached. Chrome may show a brief debugging notice. The browser window is not resized.

Automated checks find common issues on one page at a time. They do not test a whole site or guarantee accessibility or compliance with a standard; findings that need human review are labeled accordingly.

## Privacy practices tab — dashboard entry guide

### Permission justifications

| Permission | Justification |
|---|---|
| `activeTab` | Grants temporary access to the tab where the user invokes the extension. |
| `scripting` | Runs packaged audit code in that tab only after the user starts a page feature. No scripts are injected automatically. |
| `storage` | Stores settings and consent locally, and keeps audit findings for the active tab in temporary session storage. |
| `sidePanel` | Lets the user open the same dashboard in Chrome's side panel. |
| `debugger` | Required for responsive viewport emulation. Chrome requests it at install time. It attaches only to the audited tab while that feature runs and is detached afterward. |
| Optional host access `<all_urls>` | Requested only when the user allows access to a site or enables external link checks. It allows the selected checks to request pages; external link checks omit cookies. |

### Data usage

- **Data collected:** Website content from the page the user chooses, including its URL and title, visible text, structure, styles, dimensions, links, images, and form labels and settings. This content is processed locally to provide the audit and is stored locally only as described in `privacy.html`.
- **Data not collected:** The extension does not read typed form values, passwords, cookies, browsing history across tabs, or pages the user did not choose to audit. It has no account, analytics, advertising, or developer server.
- **Sharing:** Website content and findings are not sent to the developer or third parties. Page requests made by optional checks go only to the audited site or links the user chose to check. Optional user-entered exit feedback is passed to Gmail only when the user chooses that flow; the developer receives it only if the user sends the draft. Replace `example@gmail.com` with the monitored support address before publishing.
- **Remote code:** No. All executable code is packaged with the extension.
- **Limited Use certification:** Certify that website content and audit data are not sold or transferred to third parties, are not used or transferred for purposes unrelated to the extension's single purpose, and are not used or transferred to determine creditworthiness or for lending. Disclose the user-initiated Gmail feedback flow accurately in the dashboard data declarations.

### URLs and assets to enter

- **Privacy policy URL (required):** Publish `privacy.html` at a stable, publicly accessible HTTPS URL and enter that URL in the dashboard. For this repository, a candidate URL after enabling GitHub Pages for the `main` branch is `https://anjelikaharutyunyan.github.io/website-page-auditor/privacy.html`. Confirm that it loads publicly before entering it. The copy inside the extension is not a substitute for this dashboard field.
- **Support URL (recommended):** Add a public support or issue-report page that you monitor.
- **Website URL (recommended):** Add a public product or project page if one is available.
- **Store icon:** `icons/store-icon-128.png` (128 × 128 PNG).
- **Small promotional tile:** `store/promo-tile-440x280.png` (440 × 280 PNG; required by the current listing workflow).
- **Screenshots:** Upload up to five current, actual product screenshots at 1280 × 800. Refresh them with `npm run screenshots:store` before submission.

Do not submit until the public policy URL is live and the screenshots have been refreshed from the current extension. Do not upload mockups as product screenshots.
