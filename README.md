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

Derived from the GLOBAL EPI logo and defined once in the `tailwind.config` block in
`<head>`, copied verbatim into every page, so a palette change is a one-place edit.

| Token | Hex | Source | Role |
|---|---|---|---|
| `brand-500` | `#06BD95` | logo wordmark | Fills, and accents on navy |
| `brand-700` | `#047963` | derived | Links and eyebrows on light surfaces |
| `brand-400` | `#2FD3AF` | derived | Fill hover |
| `lime-500` | `#B4C908` | logo mark | Highlights on navy only |
| `navy-900` | `#061A2E` | — | Hero, footer, dark bands |
| `navy-800` | `#0A2540` | — | Dark surfaces |
| `navy-700` | `#123A5C` | — | Borders on dark |
| `gray-50…800` | `#F6F8F7` … `#272D2B` | logo dots `#A3A3A3` | Neutrals, biased green |

Rules, which the scale enforces rather than leaving to judgement:

- **`brand-500` is a fill, never text on white** — it reaches only 2.4:1 there. Anything
  sitting on a `brand-500` fill is `text-navy-900` (7.3:1).
- **Text and links on light surfaces use `brand-700`** (5.4:1).
- **`lime-500` never appears on a light surface** — 9.5:1 on navy, 1.9:1 on white.
- **Navy carries authority, brand green carries action, lime marks data.**

Every rendered text node on both pages was checked against WCAG AA. The only element
below threshold is the "Global Epi" logotype itself, which WCAG 1.4.3 exempts.

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

- [ ] Supply the logo as vector (SVG/AI/EPS). The mark is traced faithfully from the
      supplied PNG, but the wordmark is set in Plus Jakarta Sans rather than the
      logo's own typeface
- [x] Email and phone are live: `global.epi.consulting@gmail.com` · (939) 401-4402
- [x] Mailing address is live: Sierra Bayamón 81-37, Calle 68, Bayamón, Puerto Rico 00961
- [x] The inquiry form posts to Formspree (`FORM_ENDPOINT` in `assets/js/main.js`).
      If that request fails the visitor still gets a `mailto:` draft, so no inquiry is
      silently lost.
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
