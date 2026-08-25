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
study-design/         Research Design Algorithm — study design wizard
README.md
```

## EPI Collect (`field-app/`)

A survey tool, not an app with a survey inside it. Anyone can build an instrument —
sections, question types, validation rules, conditional logic — preview it exactly as
an interviewer will see it, and then run it in the field with no connectivity, or hand
it to anyone as a link. Installable to a phone home screen from `/field-app/`.

The library starts **empty**. There is no bundled example to delete or work around —
the first screen is an invitation to build.

**The builder.** Eighteen question types: short and long text, whole number, decimal,
choose one, dropdown, yes/no, choose many, rating scale, NPS, stars, slider, allocate
a fixed total, matrix, ranking, date, confirmation, location. Per question you set
wording, hint, required, and the rules that fit its type — input masks, ranges,
character and selection limits, a cap against an earlier numeric answer, matrix rows,
scale end labels, star count, slider step, and the total to allocate. Choice questions
can offer **“Other, please describe”**, whose text lands in its own answer key so it
exports as its own column instead of being buried in the choice.

Question wording supports **piping**: `{{question_id}}` inside a label or hint is
replaced by that respondent's earlier answer, so a later question can quote them back
to themselves. Option order can be randomised per response to reduce order bias —
once per response, not per render, so the list does not reshuffle under a finger.

Logic works at two levels. **Conditional visibility** hides a question until an earlier
answer matches, and is offered only against questions that come earlier, so a rule can
never depend on an answer that has not been given. **Section branching** sends the
respondent to another section, or ends the survey early, when a chosen answer matches;
rules are evaluated in order and the first match wins. Back-navigation follows the path
actually taken rather than the section numbering.

Sections and questions reorder with up and down controls and can be duplicated;
duplicating a section rewrites the copied questions' ids and repoints any rule that
referenced them.

**Sharing by link.** A survey can be handed to anyone as a link. The whole
questionnaire is gzipped and carried inside the URL fragment, which browsers never send
to a server, so publishing a link publishes nothing: the definition is decoded and run
entirely in the respondent's browser. There is no unlock and no access to anything on
the owner's device.

Answers are the separate problem, and the app is explicit about it: **a link on its own
cannot send answers back.** Set a collection address on the survey — any URL that
accepts a JSON POST — and the respondent's answers post there when they finish. The
address must be `https` (plain `http` is accepted only against localhost, which is the
one case where it is a test rather than a leak), and the field says so as you type.
Leave it empty and the respondent is told up front, then at the end downloads a small
answer file to send back; the owner drops that file into **Import file**, where it is
encrypted and joins the library like any other response. Re-importing the same file
does not duplicate it.

**Analysis and export.** Every survey has a summary screen: response and collector
counts, the collection date range, and a per-question summary shaped by the question —
frequency bars with percentages for categorical answers plus the verbatim “Other”
write-ins, mean, median, min, max and a histogram for numeric ones, the NPS computed
the published way (promoters minus detractors as a share of those who answered, not an
average of 0–10) with its promoter/passive/detractor split, mean amount per option for
an allocation, mean rating per row for a matrix, mean position for a ranking, and
recent answers for free text. Charts are single-series horizontal bars with direct
labels rather than hover, because this runs on a phone in the field. The bar hue was
chosen by running a palette validator, not by eye.

Responses download as CSV with a UTF-8 BOM so Excel reads accented place names
correctly. Matrix rows, ranking positions and allocation options each get their own
column; an NPS question also exports its promoter/passive/detractor group and an
“Other” question its write-in text; multi-select answers are semicolon-joined;
geopoints split into latitude and longitude. A `source` column records whether a
response was taken in an interview or came back from a share link.

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

**One workspace per client.** A consulting firm runs surveys for several clients from
one device, and commingling them is both a confidentiality problem and a contract
problem. Each client gets a workspace with its own passphrase, so the key derived from
it is a *different key*: Client A's passphrase does not decrypt Client B's responses or
Client B's questionnaires. Two clients cannot even share a passphrase — the app refuses,
because that would make the separation a label rather than a boundary.

The isolation lives in the storage layer, not on the screens. Every row in `events`,
`outbox`, `audit`, `instruments` and `server` is stamped with its workspace id, `DB.put`
stamps it and `DB.all` filters by it, and with no workspace open those stores read empty
— fail closed. A rule that depends on thirty call sites remembering a filter is not a
rule, so there is exactly one place to get it right. Questionnaires are encrypted too,
not merely scoped: a survey's wording tells you what the engagement is about.

A backup covers one workspace and can only contain one, so it is safe to hand to that
client. Erasing a workspace leaves the others untouched. Restoring a backup re-creates
its workspace on a device that lacks it, and refuses to merge into a workspace whose key
material differs.

Client *names* are readable before anything is unlocked — they have to be, to offer the
list — so the app says so and advises naming workspaces that give nothing away. Devices
enrolled before workspaces existed migrate on first launch: the old salt and verifier
become the first workspace, every existing record is stamped with it, plaintext
questionnaires are re-saved encrypted, and the original passphrase still opens it.

**Where the data lives, and how long it stays.** Responses are held in IndexedDB on the
device that collected them, encrypted under the passphrase. That survives closing the
browser and rebooting the phone — verified by driving a real browser profile, closing
the browser entirely, and reopening it.

What it does not survive by default is the browser deciding it needs the space. Storage
is "best-effort" until a site asks for better, and iOS evicts a site untouched for about
a week unless it was installed to the home screen. So the app calls
`navigator.storage.persist()` at unlock — while the passphrase screen is still up, since
Firefox prompts for this and a prompt mid-interview is a prompt at the worst possible
moment — and then **reports what the browser actually answered** rather than assuming it
was granted. If it was not, the home screen says so in those words and offers to ask
again.

**Backup and restore.** Persistent storage still does not survive a lost phone or
"clear site data", so the whole device backs up to one file: surveys, responses, outbox
and audit log. Response payloads are already ciphertext, so the file carries no readable
answers; it also carries the salt and verifier, which are not secret, so the same
passphrase opens it on a new device. The passphrase is in neither the file nor the app.

Restoring onto a fresh device adopts its key material, so the next screen asks for the
passphrase that device used instead of offering to create a new one. Restoring onto a
device that already holds ciphertext from a *different* passphrase is refused with the
reason, rather than half-completing and leaving records nothing there can open.
Re-restoring the same file changes nothing. The home screen tracks how many responses
exist beyond the last backup and says so.

**There is no account.** Nothing to sign in to from another phone or computer: the data
is on the device that collected it, and a backup file is how it moves. A workspace
passphrase separates clients on one device; it is not a login. Accounts that follow a
client across devices need a hosted backend — a different build, not a setting. The app
says this on its About screen rather than leaving it to be discovered.

**What is simulated, and what the app says about it.** There is no collection server.
`transmit()` writes to an object store in the same browser so the delivery protocol —
signatures, duplicate rejection, conflict detection — can be exercised end to end
without a backend.

That is useful in development and dishonest in the field. A collector who reads "Synced"
concludes the response is off the phone and safe, and then trusts a device that is in
fact the only copy. So no screen claims a delivery that did not happen: responses are
tagged **On this device**, the responses screen carries "Nothing here has left this
device" with the reason, the sync button reads **Run delivery check**, and the save toast
says **Saved on this device** and nothing more. One constant, `SERVER_IS_REAL`, drives
every one of those strings, so the day `transmit()` posts to a real endpoint the wording
becomes true in one edit rather than in fifteen.

**Scope.** Non-identifying data only. There are no BAAs and no server-side controls,
so this must not be used for PHI. The app states this on its About screen. The page is
`noindex` and is deliberately not linked from the marketing site.

## Research Design Algorithm (`study-design/`)

A single self-contained page — no build, no dependencies, no external requests beyond
the two Google Fonts families, which fall back cleanly — that walks a researcher through
GLOBAL EPI's own decision algorithms and hands back a study design, a variable
structure, and the statistical test that fits.

**The algorithms are transcribed, not invented.** The design tree comes from *Study
Design for Public Health Research* (Research Design Algorithm, adapted from ADA 2010);
the test tree from *Statistical Test by Variable*. The second document is flattened
artwork with no extractable text, so its three flowcharts were read from rendered
images, and the A–D evidence classes were recovered by sampling the fill colour of every
terminal box against the Class Key rather than judged by eye.

**It looks like the rest of GLOBAL EPI because it uses the same tokens, not similar
ones.** The palette carries the same names and the same hex values as the
`tailwind.config` block on every page of the site and as the custom properties in
`field-app/index.html`, and it loads the same Google Fonts request the marketing site
makes, so a visitor arriving from globalepillc.com already has Inter and Plus Jakarta
Sans cached. It is deliberately single-theme: the site and EPI Collect are both light
only, and a tool that flipped to a dark palette for a viewer whose system is dark would
stop looking like the rest of the firm. Every colour is painted explicitly, background
included. Unlike the marketing pages it has no CDN dependency at all — the type
degrades to the system stack and the layout is hand-written CSS, so it renders correctly
even where the Play CDN is unreachable.

**Logic is separated from rendering, as a file boundary rather than a convention.** The
first half of the script holds two decision graphs as data plus pure functions over them
and touches no DOM; the second half reads them and draws, and contains no decision rule.
Editing the algorithm means editing data. The progress bar is computed, not hardcoded:
it walks the graph to find the longest branch still ahead, which is why it stays honest
on a tree whose paths run from four questions to eight — including the real cycle where
a descriptive study that compares groups is sent back to question 3.

**What the result gives the researcher**, beyond the design name: the evidence class in
the source's own colours, the path of answers as the justification, the variable
structure (independent/exposure, dependent/outcome, confounders with typical candidates,
effect measure, unit of analysis), the design's critical failure points, and an optional
four-question sub-wizard for the statistical test. A plain-text report copies to the
clipboard, with a visible textarea fallback for when the browser blocks it.

**Two nodes are reproduced faithfully and flagged.** The source sends "subjects serve as
their own controls → yes" to *Randomized Controlled Trial* where the literature would
say crossover, and names the ordinal correlation *Pearson's rho* where the convention is
Spearman's. Both are implemented exactly as drawn, each with a short sourced note on the
result screen, so the tool matches the document while the reader is told where to look.

Verified by a Playwright suite that walks all 20 terminal routes of the design tree
against the diagram, checks each evidence class against the sampled Class Key, and
confirms the progress bar reaches 100 % without ever moving backwards.

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
