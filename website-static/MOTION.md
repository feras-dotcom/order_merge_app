# MergeShip homepage — design and motion specification

This document is the source of truth for the premium homepage redesign on the
`website/premium-motion-redesign` branch. It covers page composition, the
animated introduction, the product demonstration ("combine stage"), the shared
motion system, triggers, cleanup, and the reduced-motion / no-JS fallbacks.

Everything is plain HTML, CSS, and vanilla JavaScript. No animation library is
used: the sequence is short and almost entirely transform/opacity based (the combine also animates max-height to collapse the cancelled order's item body), and the one step
that needs measurement (the logo flight into the header) is a FLIP animation
driven by the Web Animations API.

## Files

| File | Role |
| --- | --- |
| `index.html` | Homepage. All copy is in the HTML; motion only hides/reveals it. |
| `site.css` | Shared tokens, header, buttons, footer, guides, demo, 404, reveal system. |
| `home.css` | Homepage-only sections (intro, hero, stage, trailer, steps, safety, use cases, pricing, FAQ, final CTA). |
| `site.js` | Shared behaviour: header scroll state, mobile navigation, scroll reveals, video facade, analytics events, footer year. |
| `home.js` | Homepage-only behaviour: intro controller, hero combine stage, scroll-driven steps stage, FAQ height animation. |
| `MOTION.md` | This document. |

All stylesheet and script URLs carry a `?v=` token that must be bumped whenever
the file changes, because nginx serves `.css`/`.js` with a seven-day immutable
cache (`/site.css` alone is served with `expires -1`).

## Design tokens

Colours and type are taken from the approved production assets, not invented.

| Token | Value | Use |
| --- | --- | --- |
| `--ink` | `#0b1736` | Deep navy headings and body |
| `--ink-deep` | `#07142f` | Final CTA band and footer |
| `--ink-soft` | `#52617d` | Secondary text |
| `--ink-faint` | `#7e8aa1` | Captions |
| `--blue` | `#086bff` | MergeShip blue (logo, primary actions) |
| `--blue-dark` | `#0559d7` | Hover |
| `--blue-soft` | `#eaf2ff` | Tints |
| `--green` / `--green-soft` | `#158466` / `#e9f8f2` | "Combined" state |
| `--amber` / `--amber-soft` | `#8a5a00` / `#fff0c9` | "Left untouched" state |
| `--surface` / `--surface-alt` | `#ffffff` / `#f5f7fb` | Product surfaces / page |
| `--line` / `--line-strong` | `#dfe5ef` / `#cad4e3` | Hairlines |
| Font | Inter (Shopify CDN) | Everything |

Easing tokens:

| Token | Curve | Use |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Entrances (expo-out) |
| `--ease-inout` | `cubic-bezier(0.7, 0, 0.2, 1)` | Flights, position changes |
| `--ease-soft` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Hover, small state changes |

Durations: micro `160ms`, reveal `640ms`, flight `700ms`, word rise `700ms`.

## Page composition (top to bottom)

1. **Header** — logo lockup, centred navigation, "Try free for 30 days".
   Sticky; gains a hairline and white background after 10px of scroll.
   Below 960px the navigation collapses into a disclosure panel opened by a
   menu button (`aria-expanded`, `aria-controls`); it closes on link click,
   Escape, or outside click and returns focus to the button. The header CTA
   stays beside the toggle (compact label) down to 680px; below 680 it hides
   and the panel's own CTA takes over. The homepage carries five Shopify App
   Store links: header, panel CTA, hero, pricing, final.
2. **Hero** — single centred column: H1 "Stop shipping the same customer
   twice." (dominant), approved lead, primary CTA "Try free for 30 days"
   (Shopify App Store), secondary CTA "See how it works" (`#how-it-works`),
   one quiet facts line ("Shopify app · $19/month after a 30-day free trial ·
   Unlimited automatic combines · No per-combine fees"). Below the copy sits
   the **combine stage** (section 5 below), which plays once after the hero
   settles.
3. **Trailer** — "See a combine happen in 24 seconds." with the existing
   24-second trailer facade (poster + play, video element created on click — without JS the facade keeps its play button and a `<noscript>` link to /demo,
   `preload="none"`) and a link to the four-minute `/demo`.
4. **How it works** (`#how-it-works`) — two columns: four numbered steps on the
   left (places more than one order → detects the repeat → checks eligibility
   → combines before fulfillment), a sticky combine stage on the right whose
   state follows the step nearest the viewport centre.
5. **Safety and eligibility** (`#safety`) — statement "If MergeShip cannot
   verify that a combine is safe, it leaves the orders alone." Two outcome
   panels (checks pass → combined; a check fails → left untouched), a "what is
   verified" list, and a "what MergeShip does not do" list (no automatic
   refunds including duplicate shipping charges, no shipping-charge changes,
   automatic combining is merchant-controlled).
6. **Use cases** (`#use-cases`) — "Built for short buying windows." with a
   buying-window timeline (drop opens → order #1104 → order #1105 → combine
   window closes → fulfillment) and six scenarios as a typographic grid with
   hairline dividers: product drops, preorders, live sales, limited releases,
   launches, restocks.
7. **Pricing** (`#pricing`) — one panel: $19/month, 30-day free trial, five
   inclusions, CTA. No tiers, no invented offers.
8. **FAQ** (`#faq`) — the six approved questions; `<details>` with animated
   height.
9. **Final CTA** — full-bleed navy band: "One customer. One order to fulfill."
   (replaces "One shipment", which implied a single-package guarantee), light
   button, "Install through Shopify. 30-day free trial, then $19/month."
10. **Footer** — navy, continuous with the CTA band; all existing links.

Removed from the previous homepage: the four-badge offer strip, the pill grid
of use cases, the three illustrated workflow cards, the amber "left untouched"
card, the blue CTA card, and the custom pointer.

## Animated introduction (homepage only)

### Boot

An inline script in `<head>` runs before first paint:

```
html.has-js                      always (replaces the old deferred class)
html.nav-pending                 set with has-js; removed by site.js once the
                                 disclosure listeners are bound — keeps the
                                 collapsed mobile nav hidden during boot so it
                                 doesn't render then collapse (CLS fix)
html.intro-pending               first visit this session, motion allowed
html.intro-seen                  sessionStorage["ms-intro"] === "1", motion allowed
(no class)                       prefers-reduced-motion: reduce, or no JS
```

`html.nav-ready` is added by site.js only after the nav listeners are wired —
the ≤960px disclosure-panel styles are gated on it, so a blocked site.js
leaves the nav as a static, always-visible list. `html.reveal-ready` gates the
hidden-start reveal styles the same way. `html.home-ready` is added after the
scroll-step observer binds and gates the generous step min-heights; without it
(or under `prefers-reduced-motion`) the steps render compact and fully
readable.

The intro overlay (`.intro`) is `display: none` unless `html.intro-pending`.
Hero elements are fully visible unless `html.intro-pending` or
`html.intro-seen` is present, so crawlers, no-JS visitors, and reduced-motion
users always get the final layout immediately.

Two independent guards cover a blocked or delayed `home.js`: a 4000ms inline
`setTimeout` (`__msIntroFallback`) removes `intro-pending`, reveals the header
brand and hides the overlay; and named delegated `pointerdown`/`keydown`
listeners skip the intro immediately. When `home.js` is present it exports
`__msIntroController` (the real `finishIntro`, which cancels the logo flight
and timers), so the inline handler delegates to it and cleans up via
`__msIntroCleanup`. If `home.js` arrives after the fallback fired, it finds no
`intro-pending` and does not replay the intro.

### Timeline — first visit (desktop; `--t0: 1300ms`)

Times are milliseconds from first paint. Every hero delay is written as
`calc(var(--t0) + offset)` so the whole hero reveal shifts with one variable.
JS timers are anchored to the CSS animation clock: `base` is the
`.intro-mark` animation's `startTime` (fallback `document.timeline.currentTime`)
and each timed event below fires via `setTimeout` at
`base + T − document.timeline.currentTime`, so the deferred-script offset
cannot skew the sequence.

| Time | Element | Motion |
| --- | --- | --- |
| 0 | `.intro` | Visible, same light gradient as the hero so there is no cut. |
| 80–680 | `.intro-mark` (logo) | opacity 0→1, scale 0.9→1, rise 12px, `--ease-out`. |
| 420–1000 | `.intro-word` ("MergeShip") | clip-path inset right 100%→0 plus translateX −14px→0, `--ease-inout`. |
| 300 | `.intro-skip` | Fades in (bottom-right, "Skip intro"). |
| 1000–1150 | lockup | Hold. |
| 1150–1850 | lockup | **FLIP flight** to the header brand (JS, Web Animations API, `--ease-inout`). The lockup is a 2.67× replica of the header brand, so a single translate+scale lands it exactly on the header logo. Scale factor is measured from the two `img` rects at flight start. |
| 1200–1700 | `.intro-backdrop` | opacity 1→0. |
| 1300 + 55·n | H1 words | Each word (`.w > span`) rises translateY 110%→0 inside an overflow-hidden mask, 700ms `--ease-soft`; six words, last finishes ≈2275. |
| 1750 | header nav + header CTA | opacity 0→1, 300ms. The header brand stays `opacity: 0` while `intro-pending` is set; JS adds `html.intro-landed` on flight finish (or on skip), revealing it the same frame the lockup is hidden. |
| 1900 | `.hero-lead` | opacity + translateY 16→0, 600ms. |
| 2050 | `.hero-actions` | same, 600ms. |
| 2150 | `.hero-facts` | opacity only, 500ms. |
| 2250–3050 | `.hero-stage` | opacity + translateY 28→0 + scale 0.98→1, 800ms. |
| 3100 | combine stage | Autoplay begins (see below). |
| 3200 | `html` | `intro-pending` → `intro-done` + `intro-landed`; `.intro` gets `hidden`. No visual change: all animations have already reached their `forwards` fill. |

Mobile (<680px): the lockup mark is 72px instead of 96px and the same timeline
runs with `--t0: 1100ms`.

### Timeline — return visit in the same session (`html.intro-seen`, `--t0: 0`)

No overlay. The same hero keyframes run with `--t0: 0`, so the headline rises
immediately, the lead follows at 600ms, actions at 750ms, the stage at 950ms.
Autoplay starts at ≈1800ms.

### Skip

`finishIntro({ skipped: true })` runs on: the "Skip intro" button, any
`pointerdown` on the document during the intro (the overlay is
`pointer-events: none`, so clicks pass through), Escape/Enter/Space, or the
4000ms safety timer. It cancels the flight animation, removes `intro-pending`,
adds `intro-done` and `intro-landed` (the header brand appears), hides
`.intro`, removes the keydown/pointerdown listeners, and starts the stage
autoplay. Because every hero animation lives under
`html.intro-pending`/`html.intro-seen`, removing the class snaps every element
to its final, fully visible state in one frame.

### Guarantees

- The overlay has `pointer-events: none` except the skip button; the header is
  interactive from the moment it is visible (1750ms).
- A pure-CSS fallback (`animation: intro-fallback 1ms 4s forwards`) hides the
  overlay even if `home.js` never runs after the inline boot script.
- `sessionStorage["ms-intro"] = "1"` is written when the intro completes or is
  skipped, so it plays once per browsing session.
- No layout is animated — only `transform`, `opacity`, and `clip-path`.
- The H1 is real text split into word spans in the HTML (not by JS), so there
  is no layout shift and nothing is hidden from assistive technology.

## Combine stage (product demonstration)

One component, `.stage`, is used twice: in the hero (`data-stage="auto"`) and
in "How it works" (`data-stage="scroll"`). Its appearance is driven entirely by
`data-state` on the root; `home.js` only changes that attribute.

| `data-state` | What the visitor sees |
| --- | --- |
| `orders` | Two separate order cards from Sarah M.: #1104 (Premium Hoodie, Light Blue / M, $84.55, placed 10:02) and #1105 (Canvas Tote, Natural / Navy, $46.55, placed 10:09). Both Paid · Unfulfilled. |
| `detect` | A customer chip ("Sarah M. · 2 open orders" — in `combined` it switches to "Sarah M. · 1 combined order" via state-driven spans) appears above the cards and connector lines appear at each card (solid stroke, opacity 0→0.75; the second connector is staggered 140ms). The SVG viewBox and path `d` attributes are set by a ResizeObserver so the same geometry stays correct in desktop, stacked-mobile and compact-scroll variants (resize-event fallback). Label: "Repeat order detected". |
| `check` | An eligibility panel slides in; rows tick in sequence (350ms apart): Same customer · Shipping address and method · Paid, open, and unfulfilled · "+ additional safety checks". Label: "Eligibility checked before anything changes". |
| `combined` | The tote line item travels into #1104, whose badge becomes "Unfulfilled (2)" and gains "Ready to fulfill"; #1105's item body collapses to header-only as it shrinks, dims, moves behind and reads "Cancelled · closed". Label: "Combined before fulfillment". |

The stage box is `aspect-ratio: 2/1` (scene coordinates are `cqw` percentages
of a 100×50 grid). On the autoplay transition into `combined`, home.js runs a
measured FLIP for the tote row: it records `.card-b .order-item`'s rect,
flips `data-state`, forces reflow, reads `.card-a .order-slot .order-item`'s
rect, then animates `.tote-fly` from `translate(from−to)` to identity over
600ms `--ease-inout`. On finish the stage gets `.is-landed` (the real slotted
row fades in, the fly element hides). Rail jumps, the scroll stage, and
reduced motion skip the flight entirely and land instantly.

Deliberately **not** shown: shipping charges, refunds, packages, undo. The
copy never implies that identical customer details alone make a pair eligible.

Below the hero stage (`data-stage="auto"`) a step rail (hidden until the stage controls are bound) lists the four states as buttons
(`aria-pressed`). Clicking one jumps to that state and pauses autoplay; a
"Replay" button appears once the sequence has finished.

Autoplay (hero only): `orders` 1100ms → `detect` 1400ms → `check` 1900ms →
`combined` (hold). It runs once per page load, pauses while
`document.hidden`, and never loops on its own. Under reduced motion the hero
stage renders `combined` directly, with transitions disabled; the buttons
still switch states instantly.

Scroll stage ("How it works"): an `IntersectionObserver` with
`rootMargin: "-45% 0px -45% 0px"` watches the four step items; the one crossing
the viewport centre sets the stage state and `aria-current="step"`. Normal
scrolling only — nothing is hijacked. Below 960px the stage sits sticky under
the header at a reduced height and the steps scroll beneath it.

## Shared motion system

- **Scroll reveals** — `[data-reveal]` elements start at `opacity: 0;
  translateY(14px)` only when `html.reveal-ready` is present (set by site.js only after the observer is wired, so a blocked site.js leaves content visible) and get `.is-visible`
  from one `IntersectionObserver` (`threshold: 0.08`, `rootMargin: 0 0 -10%`),
  then are unobserved. `[data-reveal-group]` staggers direct children by
  `--i × 70ms`.
- **Timeline draw** (use cases) — the track scales from the left and the
  markers pop in, triggered by the same reveal observer.
- **Hover/focus** — buttons lift 1px and deepen their shadow; nav links slide a
  1px underline in; all transitions 160ms `--ease-soft`. `:focus-visible` rings
  are 3px MergeShip blue at 36% on every interactive element.
- **FAQ** — `<details>` content height is animated with the Web Animations API
  (260ms) and falls back to the native instant toggle.
- **Header** — `.is-scrolled` after 10px; the mobile panel fades/slides 200ms.

## Reduced motion and fallbacks

`@media (prefers-reduced-motion: reduce)`:

- The boot script adds neither `intro-pending` nor `intro-seen`; `.intro` stays
  `display: none`.
- All hero elements are visible immediately; the hero stage shows `combined`.
- `[data-reveal]` elements are visible; all transitions and animations are
  shortened to 1ms; `scroll-behavior` is `auto`.
- Stage state changes still happen but snap instantly — under reduce the hero
  stage renders `combined` immediately, the rail and Replay stay functional
  (rail jumps switch states, Replay re-settles `combined`), and a live media
  switch into reduce cancels pending timers and any tote flight, settles the
  stage to `combined`, and finishes the intro. Removing reduce restarts
  nothing.
- Manual controls still work: rail buttons switch states (instantly), Replay
  settles `combined`, the mobile nav and FAQ toggles behave normally.

No JavaScript: no classes are added, so the full page renders statically with
every section visible (reveal rules never apply), the trailer facade keeps its
poster and play button plus a `<noscript>` link to `/demo`, the collapsed nav
stays a static stacked list, and `<details>` work natively.

## Cleanup

- Intro: the flight `Animation` is cancelled on skip; timers are cleared; the
  overlay is `hidden` and the controller releases its references.
- Stage autoplay timers are cleared on skip/jump and on `visibilitychange`.
- Reveal observers unobserve after first reveal; the steps observer is created
  once and never re-observes.
- No `scroll` listeners other than the passive header one.
