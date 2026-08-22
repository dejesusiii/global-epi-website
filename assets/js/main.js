/* =====================================================================
   GLOBAL EPI LLC — shared site behaviour
   ---------------------------------------------------------------------
   Loaded by every page. Each module guards on the presence of its own
   markup, so a page that has no form (or no tab list, or no canvas)
   simply skips that block rather than throwing.
   No dependencies.
===================================================================== */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- Current year in the footer ------------------------------------ */
  var yearEl = document.getElementById('year');
  if (yearEl) { yearEl.textContent = String(new Date().getFullYear()); }

  /* --- Mobile navigation --------------------------------------------- */
  var navToggle = document.getElementById('nav-toggle');
  var mobileNav = document.getElementById('mobile-nav');
  var iconOpen  = document.getElementById('icon-open');
  var iconClose = document.getElementById('icon-close');

  if (navToggle && mobileNav && iconOpen && iconClose) {
    var setNav = function (open) {
      mobileNav.classList.toggle('hidden', !open);
      iconOpen.classList.toggle('hidden', open);
      iconClose.classList.toggle('hidden', !open);
      navToggle.setAttribute('aria-expanded', String(open));
      navToggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    };

    navToggle.addEventListener('click', function () {
      setNav(mobileNav.classList.contains('hidden'));
    });

    // Close the panel after tapping a link, and on Escape
    mobileNav.addEventListener('click', function (e) {
      if (e.target.closest('a')) { setNav(false); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !mobileNav.classList.contains('hidden')) {
        setNav(false);
        navToggle.focus();
      }
    });
  }

  /* --- Header shadow once the page is scrolled ------------------------ */
  var header = document.getElementById('site-header');
  if (header) {
    var onScroll = function () {
      header.classList.toggle('shadow-md', window.scrollY > 8);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* --- Scroll reveal --------------------------------------------------- */
  var revealables = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(revealables, function (el) { el.classList.add('is-visible'); });
  } else {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });
    Array.prototype.forEach.call(revealables, function (el) { observer.observe(el); });
  }

  /* --- Social determinants tab list · homepage ------------------------- */
  var SDOH = [
    { title: 'Economic Stability',
      body: 'Employment, income, expenses, debt, and food security shape health long before a clinical encounter takes place. We quantify economic exposure at the neighborhood level and build it directly into program design, rather than controlling it away.' },
    { title: 'Education Access & Quality',
      body: 'Literacy, language access, and early childhood development are among the strongest predictors of life-course health. Our assessments treat educational access as a health indicator in its own right, not a background variable.' },
    { title: 'Health Care Access & Quality',
      body: 'Coverage, provider supply, linguistic and cultural concordance, and continuity of care. We map precisely where access breaks down, then evaluate whether an intervention actually closed the gap it was funded to close.' },
    { title: 'Neighborhood & Built Environment',
      body: 'Housing quality, transportation, environmental exposure, and food access. Geospatial analysis locates the physical conditions that concentrate risk inside specific blocks, not broad averages.' },
    { title: 'Social & Community Context',
      body: 'Social cohesion, civic participation, discrimination, and structural racism. We measure these determinants directly and report them, rather than treating them as unmeasurable context.' }
  ];

  var tabs      = Array.prototype.slice.call(document.querySelectorAll('.sdoh-tab'));
  var domainEl  = document.getElementById('sdoh-domain');
  var headingEl = document.getElementById('sdoh-heading');
  var bodyEl    = document.getElementById('sdoh-body');
  var panelEl   = document.getElementById('sdoh-panel');

  if (tabs.length && domainEl && headingEl && bodyEl && panelEl) {
    // Class sets kept as arrays so the active/inactive states stay symmetrical
    var ACTIVE   = ['border-brand-600', 'bg-navy-800', 'text-white'];
    var INACTIVE = ['border-navy-700', 'text-gray-300'];

    var selectTab = function (index) {
      tabs.forEach(function (tab, i) {
        var on = i === index;
        tab.setAttribute('aria-selected', String(on));
        tab.classList.remove.apply(tab.classList, on ? INACTIVE : ACTIVE);
        tab.classList.add.apply(tab.classList, on ? ACTIVE : INACTIVE);
      });
      domainEl.textContent  = 'Domain ' + (index + 1) + ' of ' + SDOH.length;
      headingEl.textContent = SDOH[index].title;
      bodyEl.textContent    = SDOH[index].body;
      panelEl.setAttribute('aria-labelledby', 'sdoh-tab-' + index);
    };

    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () { selectTab(i); });
      // Arrow-key navigation, per the WAI-ARIA tabs pattern
      tab.addEventListener('keydown', function (e) {
        var next = null;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { next = (i + 1) % tabs.length; }
        if (e.key === 'ArrowUp'   || e.key === 'ArrowLeft')  { next = (i - 1 + tabs.length) % tabs.length; }
        if (e.key === 'Home') { next = 0; }
        if (e.key === 'End')  { next = tabs.length - 1; }
        if (next !== null) { e.preventDefault(); selectTab(next); tabs[next].focus(); }
      });
    });
  }

  /* --- Service index highlighting · services page ----------------------
     Marks the pill for whichever service section is currently in view.
  --------------------------------------------------------------------- */
  var indexLinks = Array.prototype.slice.call(document.querySelectorAll('[data-service-link]'));
  if (indexLinks.length && 'IntersectionObserver' in window) {
    var ON  = ['border-brand-600', 'bg-brand-500', 'text-white'];
    var OFF = ['border-gray-400', 'bg-white', 'text-gray-600'];

    var mark = function (id) {
      indexLinks.forEach(function (link) {
        var on = link.getAttribute('href') === '#' + id;
        link.classList.remove.apply(link.classList, on ? OFF : ON);
        link.classList.add.apply(link.classList, on ? ON : OFF);
        if (on) { link.setAttribute('aria-current', 'true'); }
        else    { link.removeAttribute('aria-current'); }
      });
    };

    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { mark(entry.target.id); }
      });
    }, { rootMargin: '-45% 0px -45% 0px' });

    indexLinks.forEach(function (link) {
      var section = document.querySelector(link.getAttribute('href'));
      if (section) { spy.observe(section); }
    });
  }

  /* --- Inquiry form ----------------------------------------------------
     Submissions POST to Formspree, which forwards them to the address on
     the account and keeps a copy in its dashboard. If that request fails
     for any reason, the visitor is not left stranded: the mailto: branch
     below still runs as a fallback so the inquiry can be sent by hand.
  --------------------------------------------------------------------- */
  var FORM_ENDPOINT = 'https://formspree.io/f/xoeabyyq';
  var CONTACT_EMAIL = 'global.epi.consulting@gmail.com';

  var form   = document.getElementById('inquiry-form');
  var status = document.getElementById('form-status');

  if (form && status) {
    var RULES = [
      { id: 'f-name',    message: 'Please enter your full name.' },
      { id: 'f-org',     message: 'Please enter your organization.' },
      { id: 'f-email',   message: 'Please enter a valid work email address.',
        test: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); } },
      { id: 'f-service', message: 'Please select a service.' },
      { id: 'f-message', message: 'Please tell us how we can help.',
        test: function (v) { return v.length >= 10; } },
      { id: 'f-consent', message: 'Consent is required so that we can reply to you.' }
    ];

    var showFieldError = function (id, message) {
      var field = document.getElementById(id);
      var note  = document.querySelector('[data-error-for="' + id + '"]');
      field.setAttribute('aria-invalid', 'true');
      if (field.type !== 'checkbox') {
        field.classList.remove('border-gray-400');
        field.classList.add('border-red-500');
      }
      if (note) { note.textContent = message; note.classList.remove('hidden'); }
    };

    var clearFieldError = function (id) {
      var field = document.getElementById(id);
      var note  = document.querySelector('[data-error-for="' + id + '"]');
      field.removeAttribute('aria-invalid');
      if (field.type !== 'checkbox') {
        field.classList.remove('border-red-500');
        field.classList.add('border-gray-400');
      }
      if (note) { note.textContent = ''; note.classList.add('hidden'); }
    };

    var setStatus = function (kind, message) {
      status.textContent = message;
      status.classList.remove('hidden', 'border-brand-600', 'bg-brand-50', 'text-brand-700',
                              'border-red-300', 'bg-red-50', 'text-red-700',
                              'border-gray-300', 'bg-gray-50', 'text-gray-700');
      if (kind === 'success') {
        status.classList.add('border-brand-600', 'bg-brand-50', 'text-brand-700');
      } else if (kind === 'pending') {
        status.classList.add('border-gray-300', 'bg-gray-50', 'text-gray-700');
      } else {
        status.classList.add('border-red-300', 'bg-red-50', 'text-red-700');
      }
    };

    // Clear a field's error as soon as the visitor starts correcting it
    RULES.forEach(function (rule) {
      var field = document.getElementById(rule.id);
      if (!field) { return; }
      field.addEventListener('input',  function () { clearFieldError(rule.id); });
      field.addEventListener('change', function () { clearFieldError(rule.id); });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var firstInvalid = null;
      RULES.forEach(function (rule) {
        var field = document.getElementById(rule.id);
        var value = field.type === 'checkbox' ? field.checked : field.value.trim();
        var valid = field.type === 'checkbox'
          ? value === true
          : (value !== '' && (!rule.test || rule.test(value)));

        if (valid) {
          clearFieldError(rule.id);
        } else {
          showFieldError(rule.id, rule.message);
          if (!firstInvalid) { firstInvalid = field; }
        }
      });

      if (firstInvalid) {
        setStatus('error', 'Please correct the highlighted fields and submit again.');
        firstInvalid.focus();
        return;
      }

      var data = {
        name:    document.getElementById('f-name').value.trim(),
        organization: document.getElementById('f-org').value.trim(),
        email:   document.getElementById('f-email').value.trim(),
        phone:   document.getElementById('f-phone').value.trim() || 'Not provided',
        service: document.getElementById('f-service').value,
        message: document.getElementById('f-message').value.trim()
      };

      // Compose the plain-text version once: it is both the mailto: body and
      // the fallback if the POST fails.
      var subject = 'Consulting Inquiry: ' + data.service;
      var body = [
        'Name: ' + data.name,
        'Organization: ' + data.organization,
        'Email: ' + data.email,
        'Phone: ' + data.phone,
        'Service of interest: ' + data.service,
        '',
        'Message:',
        data.message
      ].join('\n');

      var mailtoHref = 'mailto:' + CONTACT_EMAIL +
        '?subject=' + encodeURIComponent(subject) +
        '&body='    + encodeURIComponent(body);

      if (FORM_ENDPOINT) {
        var submitBtn = form.querySelector('button[type="submit"]');
        var honeypot  = document.getElementById('f-gotcha');

        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-60');
        setStatus('pending', 'Sending your inquiry…');

        fetch(FORM_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            name:         data.name,
            organization: data.organization,
            email:        data.email,
            phone:        data.phone,
            service:      data.service,
            message:      data.message,
            _subject:     subject,
            _replyto:     data.email,
            _gotcha:      honeypot ? honeypot.value : ''
          })
        }).then(function (res) {
          if (!res.ok) { throw new Error('HTTP ' + res.status); }
          form.reset();
          setStatus('success', 'Thank you. Your inquiry has been received — we respond within two business days.');
        }).catch(function () {
          // Never strand the visitor: hand them the same inquiry as an email draft.
          setStatus('error', 'We could not send the form automatically. Your email client is opening with the inquiry ready — or write to ' + CONTACT_EMAIL + ' directly.');
          window.location.href = mailtoHref;
        }).then(function () {
          submitBtn.disabled = false;
          submitBtn.classList.remove('opacity-60');
        });
        return;
      }

      // No endpoint configured — compose the inquiry as an email draft
      window.location.href = mailtoHref;

      setStatus('success', 'Your email client is opening with this inquiry ready to send. If nothing happens, email ' + CONTACT_EMAIL + ' directly.');
    });
  }

  /* --- Hero data surface · homepage -------------------------------------
     A decorative field rendered on <canvas>: a smooth value surface
     sampled onto a grid and coloured navy -> teal -> cyan. It represents
     no real dataset and is labelled as illustrative in the markup.
  --------------------------------------------------------------------- */
  var canvas = document.getElementById('hero-surface');
  if (canvas && canvas.getContext) {
    var ctx  = canvas.getContext('2d');
    var COLS = 24, ROWS = 16;

    // navy-700 -> brand-500 -> lime-500
    var STOPS = [[18, 58, 92], [6, 189, 149], [180, 201, 8]];

    var ramp = function (t) {
      t = Math.max(0, Math.min(1, t));
      var seg = t < 0.5 ? 0 : 1;
      var k = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
      var a = STOPS[seg], b = STOPS[seg + 1];
      return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * k) + ',' +
                      Math.round(a[1] + (b[1] - a[1]) * k) + ',' +
                      Math.round(a[2] + (b[2] - a[2]) * k) + ')';
    };

    // Smooth pseudo-random field: layered sines, deterministic and cheap
    var field = function (x, y, t) {
      var v = Math.sin(x * 0.55 + t) * 0.5
            + Math.sin(y * 0.75 - t * 0.7) * 0.35
            + Math.sin((x + y) * 0.32 + t * 0.45) * 0.4
            + Math.sin(Math.sqrt(x * x + y * y) * 0.5 - t * 0.6) * 0.45;
      return (v / 1.6 + 1) / 2; // normalise to 0..1
    };

    var draw = function (t) {
      var w = canvas.width / COLS;
      var h = canvas.height / ROWS;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (var r = 0; r < ROWS; r++) {
        for (var c = 0; c < COLS; c++) {
          var v = field(c, r, t);
          ctx.fillStyle = ramp(v);
          ctx.globalAlpha = 0.25 + v * 0.75;
          ctx.fillRect(c * w + 1, r * h + 1, w - 2, h - 2);
        }
      }
      ctx.globalAlpha = 1;
    };

    if (reduceMotion) {
      draw(0);
    } else {
      var start = null;
      (function frame(ts) {
        if (start === null) { start = ts; }
        draw((ts - start) / 3500);
        requestAnimationFrame(frame);
      })(performance.now());
    }
  }
})();
