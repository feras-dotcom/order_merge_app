// Homepage behaviour: intro controller, hero combine-stage autoplay,
// scroll-driven steps stage, FAQ height animation.

const docEl = document.documentElement;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const introPending = docEl.classList.contains("intro-pending");
const t0 = introPending ? (window.innerWidth < 680 ? 1100 : 1300) : 0;

/* ---------- Combine stage ---------- */

const STAGE_SEQUENCE = [
  ["detect", 1100],
  ["check", 1400],
  ["combined", 1900],
];

const railsOf = (stage) =>
  Array.from(stage.querySelectorAll(".stage-step[data-step-target]"));

const syncRail = (stage) =>
  railsOf(stage).forEach((button) =>
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.stepTarget === stage.dataset.state),
    ),
  );

// The tote row's flight into #1104 is a measured FLIP, only on the
// autoplay-driven transition. Instant transitions (rail jumps, scroll
// stage, reduced motion) reveal the slotted row directly via is-landed.
const setStageState = (stage, state, { animateFly = false } = {}) => {
  const scene = stage.querySelector(".stage-scene");
  const fly = stage.querySelector(".tote-fly");
  const source = stage.querySelector(".card-b .order-item");
  const target = stage.querySelector(".card-a .order-slot .order-item");
  const enteringCombined =
    state === "combined" && stage.dataset.state !== "combined";

  if (!enteringCombined) {
    if (stage._flyAnim) {
      stage._flyAnim.cancel();
      stage._flyAnim = null;
    }
    stage.dataset.state = state;
    if (state !== "combined") stage.classList.remove("is-landed");
    syncRail(stage);
    return;
  }

  if (!animateFly || reduceMotion.matches || !scene || !fly || !source || !target) {
    stage.dataset.state = state;
    stage.classList.add("is-landed");
    syncRail(stage);
    return;
  }

  // measure the source row before the state change
  const fromRect = source.getBoundingClientRect();
  stage.dataset.state = state;
  const sceneRect = scene.getBoundingClientRect(); // reflow
  const toRect = target.getBoundingClientRect();

  fly.style.left = `${toRect.left - sceneRect.left}px`;
  fly.style.top = `${toRect.top - sceneRect.top}px`;
  fly.style.width = `${toRect.width}px`;
  fly.style.fontSize = getComputedStyle(target).fontSize;
  fly.classList.add("is-flying");

  const dx = fromRect.left - toRect.left;
  const dy = fromRect.top - toRect.top;
  const anim = fly.animate(
    [
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: "translate(0px, 0px)" },
    ],
    { duration: 600, easing: "cubic-bezier(0.7, 0, 0.2, 1)", fill: "forwards" },
  );
  stage._flyAnim = anim;

  const finish = () => {
    stage._flyAnim = null;
    stage.classList.add("is-landed");
    window.setTimeout(() => fly.classList.remove("is-flying"), 120);
  };
  anim.onfinish = finish;
  anim.oncancel = finish;
};

window.MergeShipStage = { set: setStageState };

/* ---------- Hero stage autoplay ---------- */

const heroStage = document.querySelector('.stage[data-stage="auto"]');
let autoplayStarted = false;

const startAutoplay = () => {
  if (!heroStage || autoplayStarted) return;
  autoplayStarted = true;

  if (reduceMotion.matches) {
    setStageState(heroStage, "combined");
    return;
  }

  const replayButton = heroStage.querySelector(".stage-replay");
  let stepIndex = 0;
  let finished = false;
  let timer = 0;
  let startedAt = 0;
  let remaining = 0;
  let pendingStep = null;
  let suspended = false;

  const clearTimer = () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
  };

  const scheduleStep = () => {
    if (stepIndex >= STAGE_SEQUENCE.length) {
      finished = true;
      if (replayButton) replayButton.hidden = false;
      return;
    }
    const [state, delay] = STAGE_SEQUENCE[stepIndex];
    pendingStep = state;
    remaining = delay;
    startedAt = performance.now();
    timer = window.setTimeout(() => {
      timer = 0;
      setStageState(heroStage, pendingStep, {
        animateFly: pendingStep === "combined",
      });
      stepIndex += 1;
      scheduleStep();
    }, delay);
  };

  const stop = () => {
    clearTimer();
    pendingStep = null;
    stepIndex = STAGE_SEQUENCE.length;
  };

  railsOf(heroStage).forEach((button) => {
    button.addEventListener("click", () => {
      if (!finished) stop(); // jumping pauses autoplay
      setStageState(heroStage, button.dataset.stepTarget);
    });
  });

  replayButton?.addEventListener("click", () => {
    replayButton.hidden = true;
    setStageState(heroStage, "orders");
    stepIndex = 0;
    finished = false;
    scheduleStep();
  });

  document.addEventListener("visibilitychange", () => {
    if (finished || !pendingStep) return;
    if (document.hidden) {
      if (timer) {
        clearTimer();
        remaining -= performance.now() - startedAt;
        suspended = true;
      }
    } else if (suspended) {
      suspended = false;
      startedAt = performance.now();
      timer = window.setTimeout(() => {
        timer = 0;
        setStageState(heroStage, pendingStep, {
          animateFly: pendingStep === "combined",
        });
        stepIndex += 1;
        scheduleStep();
      }, Math.max(0, remaining));
    }
  });

  scheduleStep();
};

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
    startAutoplay();
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

  // 3100: stage autoplay; 3200: intro done; 4000: safety skip
  at(3100, startAutoplay);
  at(3200, () => finishIntro());
  at(4000, () => finishIntro({ skipped: true }));

  skipButton?.addEventListener("click", () => finishIntro({ skipped: true }));
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", onPointerDown);
} else if (heroStage) {
  // Return visit this session, or reduced motion: hero timings already
  // compressed by --t0; autoplay follows the same t0 + 1800ms offset.
  if (reduceMotion.matches) startAutoplay();
  else window.setTimeout(startAutoplay, t0 + 1800);
}

/* ---------- FAQ: animated details height ---------- */

document.querySelectorAll(".faq-list details").forEach((details) => {
  const summary = details.querySelector("summary");
  if (!summary) return;
  let animating = false;

  summary.addEventListener("click", (event) => {
    if (
      reduceMotion.matches ||
      typeof details.animate !== "function" ||
      animating
    ) {
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
