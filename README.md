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
about.html            The firm and its founders
services.html         The seven service lines in detail
contact.html          Contact details and inquiry form
privacy.html          Privacy Policy
terms.html            Terms of Use
accessibility.html    Accessibility Statement
assets/logo.svg       Full lockup, vectorised from the supplied artwork
assets/*.jpg          Founder portraits, cropped square for a round frame
assets/favicon.svg    The mark alone, cells clipped to the disc
assets/og-image.png   Social sharing card, 1200x630
assets/js/main.js     Shared behaviour for every page
field-app/            EPI Collect — offline field data collection (pilot)
README.md
```

## EPI Collect (`field-app/`)

A survey tool, not an app with a survey inside it. Anyone can build an instrument —
sections, question types, validation rules, conditional logic — preview it exactly as
an interviewer will see it, and then run it in the field with no connectivity.
Installable to a phone home screen from `/field-app/`.

**The builder.** Fourteen question types: short and long text, whole number, decimal,
choose one, dropdown, choose many, yes/no, rating scale, matrix, ranking, date,
confirmation, location. Per question you set wording, hint, required, and the rules
that fit its type — input masks, ranges, character and selection limits, a cap against
an earlier numeric answer, matrix rows, and scale end labels. Option order can be
randomised per response to reduce order bias. Conditional visibility is offered only
against questions that come earlier, so a rule can never depend on an answer that has
not been given. Sections and questions reorder with up and down controls and can be
duplicated; duplicating a section rewrites the copied questions' ids and repoints any
rule that referenced them.

**Analysis and export.** Every survey has a summary screen: response and collector
counts, the collection date range, and a per-question summary shaped by the question —
frequency bars with percentages for categorical answers, mean, median, min, max and a
histogram for numeric ones, mean rating per row for a matrix, mean position for a
ranking, recent answers for free text. Charts are single-series horizontal bars with
direct labels rather than hover, because this runs on a phone in the field. The bar
hue was chosen by running a palette validator, not by eye.

Responses download as CSV with a UTF-8 BOM so Excel reads accented place names
correctly. Matrix rows and ranking positions each get their own column; multi-select
answers are semicolon-joined; geopoints split into latitude and longitude.

A survey cannot be run until every question is answerable; the library shows it as a
draft and lists what is missing. Surveys export and import as JSON, so they move
between devices without a server.

**Collection.** Works with no network — every asset is precached and there are no
third-party requests at all, not even a font host. Responses are encrypted on the
device with AES-256-GCM under a key derived from the user's passphrase via PBKDF2;
the key is never stored. Each operation carries a UUIDv7 idempotency key and an HMAC
signature. History is append-only: a correction adds a version, nothing is
overwritten. Divergent edits are flagged for a human rather than resolved
automatically. An operation leaves the outbox only after a durable acknowledgement.

**What is simulated.** The server is a local IndexedDB store, so the protocol can be
exercised end to end without a backend. Replacing it is one function, `transmit`.

**Scope.** Non-identifying data only. There are no BAAs and no server-side controls,
so this must not be used for PHI. The app states this on its About screen. The page is
`noindex` and is deliberately not linked from the marketing site.

`instruments/chna-screener.json` seeds the library on first run as a worked example.
It is an ordinary survey: editable, duplicable and deletable like any other.

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

Every rendered text node on every page was checked against WCAG AA, and all of them
pass. The logotype is artwork rather than text, so the one former exception is gone.

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

**`about.html`** — page hero · why the firm exists · founder profiles
(`#luis`, `#jomary`) · mission and vision · CTA

**`contact.html`** — page hero · contact details and what helps an inquiry ·
the inquiry form, lifted from the homepage so the two cannot drift · what happens next

## Social sharing

`assets/og-image.png` is the card that appears when a page is shared on LinkedIn,
WhatsApp, Slack or X. It is generated by a script rather than hand-drawn: fonts are
embedded from local copies so the render cannot fall back silently, and the data
surface uses the same field function as the hero canvas in `main.js`.

`og:image` must be an **absolute** URL, so pages carry a base:

```
https://globalepillc.com/
```

The domain is written in exactly two places: `CNAME`, which tells GitHub Pages what
to serve, and the base above in `index.html`, from which every generated page takes
its `og:url` and `<link rel="canonical">`. Changing domain means changing both and
regenerating.

## Outstanding

- [x] The real logo is in use. `assets/logo.svg` was vectorised from the 5000px
      source: the mark measured and emitted as exact circles, the wordmark traced,
      so the letterforms are the logo's own rather than a substitute typeface
- [x] Email and phone are live: `global.epi.consulting@gmail.com` · (939) 401-4402
- [x] Mailing address is live: Sierra Bayamón 81-37, Calle 68, Bayamón, Puerto Rico 00961
- [x] The inquiry form posts to Formspree (`FORM_ENDPOINT` in `assets/js/main.js`) and
      delivery to the inbox is confirmed end to end. If the request fails the visitor
      still gets a `mailto:` draft, so no inquiry is silently lost.
- [x] Founder portraits are in place, cropped to circles in `assets/`
- [x] The service-to-EPHS mapping is confirmed by the founder. Research & Development
      gained EPHS 4, Needs Assessment gained 7, Capacity Building gained 9
- [x] The four engagement models are confirmed as how the firm contracts
- [x] Privacy Policy, Terms of Use and Accessibility pages are live and linked from the footer
- [ ] **Have an attorney review `privacy.html` and `terms.html`.** They are drafted to
      describe accurately what this site does, but they are not legal advice and have
      not been reviewed by a lawyer licensed in Puerto Rico
- [ ] For production traffic, swap the Play CDN for a prebuilt Tailwind stylesheet —
      a one-line change in `<head>`

## Local development

No toolchain required. Open `index.html` in a browser, or serve it:

```bash
python3 -m http.server 8000
```
