/** =====================================================================
 *  Brand tokens, derived from the GLOBAL EPI logo. This file is the
 *  source of truth for the identity; a palette or type change is a
 *  one-place edit here, then `npm run build:css`.
 *
 *    brand  #06BD95  the wordmark green — actions and accents
 *    lime   #B4C908  the mark's chartreuse — dark surfaces only
 *    navy            corporate / data ground
 *    gray            neutrals, biased green so they sit with the accent
 *
 *  Contrast rules baked into the scale, not left to chance:
 *    brand-500 is too light to carry text on white (2.4:1) — it is a
 *    FILL, and anything on top of it is navy-900 (7.3:1). Text and
 *    links on light surfaces use brand-700 (5.4:1). lime-500 is legible
 *    on navy (9.5:1) and invisible on white (1.9:1), so it never
 *    appears on a light surface.
 *  ===================================================================== */
module.exports = {
  /* main.js is scanned, not just the markup: it adds classes at run time
     that appear nowhere in the HTML — the form-error border, the sticky
     header shadow, the active tab and service-index states. Leave it out
     and those styles are simply absent, which is invisible until a
     visitor trips the exact state that needs them. */
  content: ['./*.html', './assets/js/*.js'],

  /* field-app/ and study-design/ are deliberately absent: they are
     self-contained tools with their own stylesheet and no Tailwind. */

  theme: {
    extend: {
      colors: {
        navy:  { 700: '#123A5C', 800: '#0A2540', 900: '#061A2E' },
        brand: { 50: '#E8FBF5', 400: '#2FD3AF', 500: '#06BD95', 600: '#059B7B', 700: '#047963', 800: '#036452' },
        lime:  { 500: '#B4C908' },
        gray:  { 50: '#F6F8F7', 100: '#EDF1EF', 200: '#DEE5E2', 300: '#C5CFCB',
                 400: '#87918D', 500: '#69736F', 600: '#4E5854', 700: '#39413E', 800: '#272D2B' },
      },
      fontFamily: {
        display: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        sans:    ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        serif:   ['"Source Serif 4"', 'Georgia', 'serif'],
      },
      maxWidth: { content: '72ch' },
    },
  },
};
