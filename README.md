# GLOBAL EPI LLC — Website

Corporate website for **GLOBAL EPI LLC**, a public health corporation founded in 2023
delivering evidence-based public health services to communities and populations.

## Stack

| Layer | Choice |
|---|---|
| Structure | Plain HTML5, semantic elements |
| Styling | Tailwind CSS via Play CDN — no build step |
| Behaviour | Vanilla JavaScript, zero dependencies |

## Files

```
index.html            Homepage
services.html         The seven service lines in detail
assets/js/main.js     Shared behaviour for every page
README.md
```

Brand tokens and the custom `@layer` block stay inline in each page's `<head>` —
with the Play CDN they must be parsed before first paint. Behaviour is shared: every
module in `main.js` guards on the presence of its own markup, so a page without a
form (or tab list, or canvas) simply skips that block.

**Adding a page:** copy the `<head>`, utility bar, header and footer from an existing
page verbatim, change only the `<title>`/description and the nav's `aria-current`,
and load `assets/js/main.js` at the end. The two existing pages are byte-identical
across those regions apart from hrefs.

## Brand tokens

Defined once in the `tailwind.config` block in `<head>` and copied verbatim into every
future page, so a palette or type change is a one-place edit.

| Token | Hex | Role |
|---|---|---|
| `navy-900` | `#061A2E` | Hero, footer, dark bands |
| `navy-800` | `#0A2540` | Primary dark surfaces |
| `navy-700` | `#123A5C` | Borders on dark |
| `teal-600` | `#0D9488` | Primary accent — actions, links |
| `teal-500` | `#14A89B` | Hover |
| `cyan-400` | `#22D3EE` | Data highlight only |
| slate 50–700 | — | Neutral surfaces and body copy |

Rule: **navy carries authority, teal carries action, cyan appears only where data is
being represented.**

Type: **Plus Jakarta Sans** (display) · **Inter** (body) · **Source Serif 4** (mission
and vision statements only).

## Page sections

**`index.html`** — 1. Utility bar · 2. Sticky header · 3. Hero · 4. Credibility strip ·
5. Mission & Vision · 6. Approach (Collect / Analyze / Translate) · 7. Core Values ·
8. Services overview · 9. Social Determinants of Health · 10. Who We Serve ·
11. Contact form · 12. Footer

**`services.html`** — page hero · sticky service index · seven detailed service
sections (`#service-1` … `#service-7`, each with core activities, typical deliverables,
and the Essential Public Health Services it maps to) · engagement models · CTA · footer

## Outstanding

- [ ] Replace the placeholder monogram with the final logo asset
- [ ] Confirm contact details — every placeholder is marked `[PLACEHOLDER]` in the markup
- [ ] Point the inquiry form at a real endpoint: set `FORM_ENDPOINT` in `index.html`
      (Formspree / Netlify Forms). Until then the form validates client-side and hands
      off to a `mailto:` draft.
- [ ] Confirm the service-to-EPHS mapping on `services.html` — it is our reading of
      the 2020 framework, not something you specified
- [ ] Confirm the four engagement models on `services.html` reflect how you actually contract
- [ ] Privacy Policy, Terms of Use and Accessibility pages (footer links are stubs)
- [ ] For production traffic, swap the Play CDN for a prebuilt Tailwind stylesheet —
      a one-line change in `<head>`

## Local development

No toolchain required. Open `index.html` in a browser, or serve it:

```bash
python3 -m http.server 8000
```
