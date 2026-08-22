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
index.html    Homepage — markup, brand config, styles and behaviour in one file
README.md
```

Everything is inline by design: with the Play CDN there is no bundler, so a single
file keeps the brand tokens, the markup they style, and the JS that toggles them in
one place. Split `assets/css` and `assets/js` out once a second page exists.

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

## Homepage sections

1. Utility bar · 2. Sticky header · 3. Hero · 4. Credibility strip ·
5. Mission & Vision · 6. Approach (Collect / Analyze / Translate) · 7. Core Values ·
8. Services (7 official service lines) · 9. Social Determinants of Health ·
10. Who We Serve · 11. Contact form · 12. Footer

## Outstanding

- [ ] Replace the placeholder monogram with the final logo asset
- [ ] Confirm contact details — every placeholder is marked `[PLACEHOLDER]` in the markup
- [ ] Point the inquiry form at a real endpoint: set `FORM_ENDPOINT` in `index.html`
      (Formspree / Netlify Forms). Until then the form validates client-side and hands
      off to a `mailto:` draft.
- [ ] Privacy Policy, Terms of Use and Accessibility pages (footer links are stubs)
- [ ] For production traffic, swap the Play CDN for a prebuilt Tailwind stylesheet —
      a one-line change in `<head>`

## Local development

No toolchain required. Open `index.html` in a browser, or serve it:

```bash
python3 -m http.server 8000
```
