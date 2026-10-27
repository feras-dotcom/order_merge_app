// Homepage behaviour: intro controller, scroll-driven combine stage,
// FAQ height animation.

const docEl = document.documentElement;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const introPending = docEl.classList.contains("intro-pending");
const t0 = introPending ? (window.innerWidth < 680 ? 1100 : 1300) : 0;

/* ---------- Combine stage ---------- */

// The scroll stage transitions are instant state sets; the slotted tote
// row inside card A is revealed by is-landed in the combined state.
const setStageState = (stage, state) => {
  stage.dataset.state = state;
  stage.classList.toggle("is-landed", state === "combined");
};

/* Keep connector coordinates in the same uniform grid as the cards. */

const DESKTOP_D = { a: "M50 8.6 C 45 10 33 11.5 25 13.5", b: "M50 8.6 C 55 10 67 11.5 75 13.5" };
const STACKED_D = { a: "M50 15.4 L50 18", b: "M50 15.4 C 76 26 94 44 91 66" };
const COMPACT_D = { a: "M50 10.6 C 45 12.5 34 16 25 19", b: "M50 10.6 C 55 12.5 66 16 75 19" };

const fitStageLinks = (box, rect) => {
  const svg = box.querySelector(".stage-links");
  if (!svg) return;
  const width = rect?.width ?? box.clientWidth;
  const height = rect?.height ?? box.clientHeight;
  if (!(width > 0 && height > 0)) return;
  const h = (100 * height) / width;
  svg.setAttribute("viewBox", `0 0 100 ${h.toFixed(3)}`);
  const narrow = window.matchMedia("(max-width: 680px)").matches;
  const kind = box.closest("[data-stage]")?.dataset.stage;
  const paths = narrow
    ? kind === "scroll"
      ? COMPACT_D
      : STACKED_D
    : DESKTOP_D;
  svg.querySelector(".link-a")?.setAttribute("d", paths.a);
  svg.querySelector(".link-b")?.setAttribute("d", paths.b);
};

const stageBoxes = Array.from(document.querySelectorAll(".stage-box"));
if ("ResizeObserver" in window) {
  const linksObserver = new ResizeObserver((entries) =>
    entries.forEach((entry) => fitStageLinks(entry.target, entry.contentRect)),
  );
  stageBoxes.forEach((box) => linksObserver.observe(box));
} else {
  const fitAll = () => stageBoxes.forEach(fitStageLinks);
  window.addEventListener("resize", fitAll);
  fitAll();
}

/* ---------- Scroll-driven stage ("How it works") ---------- */

const scrollStage = document.querySelector('.stage[data-stage="scroll"]');
const stepItems = Array.from(document.querySelectorAll("[data-step]"));

if (scrollStage && stepItems.length && "IntersectionObserver" in window) {
  const stepObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        stepItems.forEach((item) => item.removeAttribute("aria-current"));
        entry.target.setAttribute("aria-current", "step");
        setStageState(scrollStage, entry.target.dataset.step);
      });
    },
    { rootMargin: "-45% 0px -45% 0px", threshold: 0 },
  );
  stepItems.forEach((item) => stepObserver.observe(item));
  docEl.classList.add("home-ready");
} else {
  stepItems.forEach((item) => item.setAttribute("aria-current", "step"));
}

/* ---------- Intro controller ---------- */

const intro = document.querySelector(".intro");

if (intro && introPending && !reduceMotion.matches) {
  const lockup = intro.querySelector(".intro-lockup");
  const mark = intro.querySelector(".intro-mark");
  const skipButton = intro.querySelector(".intro-skip");
  const headerBrandImg = document.querySelector(".site-header .brand img");
  const timers = [];
  let flight = null;
  let done = false;

  // Anchor every timer to the CSS animation clock so the deferred-script
  // offset cannot skew the sequence.
  const markAnim = mark?.getAnimations?.()[0];
  const base = markAnim?.startTime ?? document.timeline.currentTime;
  const at = (T, fn) =>
    timers.push(
      window.setTimeout(
        fn,
        Math.max(0, base + T - document.timeline.currentTime),
      ),
    );

  const onKey = (event) => {
    if (
      event.key === "Escape" ||
      event.key === "Enter" ||
      event.key === " "
    ) {
      finishIntro({ skipped: true });
    }
  };
  const onPointerDown = () => finishIntro({ skipped: true });

  const finishIntro = ({ skipped = false } = {}) => {
    if (done) return;
    done = true;
    if (flight) {
      flight.cancel();
      flight = null;
    }
    timers.forEach((id) => window.clearTimeout(id));
    if (window.__msIntroFallback) window.clearTimeout(window.__msIntroFallback);
    window.__msIntroCleanup?.();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", onPointerDown);
    docEl.classList.remove("intro-pending");
    docEl.classList.add("intro-done", "intro-landed");
    if (lockup) lockup.style.visibility = "hidden";
    intro.hidden = true;
    try {
      sessionStorage.setItem("ms-intro", "1");
    } catch (error) {
      /* storage unavailable — intro just plays again next page view */
    }
  };

  // 1150–1850: FLIP flight of the lockup onto the header brand
  at(1150, () => {
    if (!lockup || !headerBrandImg) return;
    const from = lockup.querySelector("img").getBoundingClientRect();
    const to = headerBrandImg.getBoundingClientRect();
    if (!from.width || !to.width) return;
    const scale = to.width / from.width;
    const dx = to.left - from.left;
    const dy = to.top - from.top;
    flight = lockup.animate(
      [
        { transform: "translate(0px, 0px) scale(1)" },
        {
          transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
        },
      ],
      {
        duration: 700,
        easing: "cubic-bezier(0.7, 0, 0.2, 1)",
        fill: "forwards",
      },
    );
    flight.onfinish = () => {
      lockup.style.visibility = "hidden";
      docEl.classList.add("intro-landed");
      flight = null;
    };
  });

  // The film lands at t0 + 2125 (t1+350 start + 800ms). intro-done and the
  // safety skip stay as literals so they can't drift from the CSS clock.
  at(t0 + 2300, () => finishIntro());
  at(t0 + 3100, () => finishIntro({ skipped: true }));

  window.__msIntroController = finishIntro;
  skipButton?.addEventListener("click", () => finishIntro({ skipped: true }));
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", onPointerDown);
}

reduceMotion.addEventListener?.("change", (ev) => {
  if (!ev.matches) return; // do not restart anything when reduce is removed
  if (window.__msIntroController) window.__msIntroController({ skipped: true });
  else if (window.__msIntroFinish) window.__msIntroFinish();
});

/* ---------- FAQ: animated details height ---------- */

document.querySelectorAll(".faq-list details").forEach((details) => {
  const summary = details.querySelector("summary");
  if (!summary) return;
  let animating = false;

  summary.addEventListener("click", (event) => {
    if (animating) {
      event.preventDefault();
      return;
    }
    if (reduceMotion.matches || typeof details.animate !== "function") {
      return; // native toggle
    }
    event.preventDefault();
    animating = true;

    const summaryHeight = summary.offsetHeight;
    const animation = { duration: 260, easing: "cubic-bezier(0.7, 0, 0.2, 1)" };

    if (details.open) {
      // closing: animate down to the summary height, then remove `open`
      const startHeight = details.offsetHeight;
      details.style.overflow = "hidden";
      const anim = details.animate(
        [{ height: `${startHeight}px` }, { height: `${summaryHeight}px` }],
        animation,
      );
      anim.onfinish = anim.oncancel = () => {
        details.open = false;
        details.style.overflow = "";
        animating = false;
      };
    } else {
      details.open = true;
      const endHeight = details.offsetHeight;
      details.style.overflow = "hidden";
      const anim = details.animate(
        [{ height: `${summaryHeight}px` }, { height: `${endHeight}px` }],
        animation,
      );
      anim.onfinish = anim.oncancel = () => {
        details.style.overflow = "";
        animating = false;
      };
    }
  });
});
