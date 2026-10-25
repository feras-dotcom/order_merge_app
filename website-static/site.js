// Shared behaviour: header scroll state, mobile navigation, scroll reveals,
// video facade, analytics events, footer year.
// `has-js` is added by an inline script in <head> before first paint.

const header = document.querySelector("[data-header]");
const updateHeader = () =>
  header?.classList.toggle("is-scrolled", window.scrollY > 10);
updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

/* Mobile navigation */

const navToggle = document.querySelector(".nav-toggle");
const primaryNav = document.getElementById("primary-nav");

if (navToggle && primaryNav) {
  let closeTimer = 0;
  const NAV_TRANSITION_MS = 200;

  const setNavOpen = (open) => {
    window.clearTimeout(closeTimer);
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    if (open) {
      primaryNav.hidden = false;
      requestAnimationFrame(() => primaryNav.classList.add("is-open"));
    } else {
      primaryNav.classList.remove("is-open");
      closeTimer = window.setTimeout(() => {
        primaryNav.hidden = true;
      }, NAV_TRANSITION_MS);
    }
  };

  navToggle.addEventListener("click", () => {
    setNavOpen(navToggle.getAttribute("aria-expanded") !== "true");
  });

  primaryNav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setNavOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && navToggle.getAttribute("aria-expanded") === "true") {
      setNavOpen(false);
      navToggle.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (
      navToggle.getAttribute("aria-expanded") === "true" &&
      !event.target.closest(".site-header")
    ) {
      setNavOpen(false);
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 960 && navToggle.getAttribute("aria-expanded") === "true") {
      setNavOpen(false);
    }
  });

  document.documentElement.classList.add("nav-ready");
  document.documentElement.classList.remove("nav-pending");
  window.clearTimeout(window.__msNavFallback);
}

/* Scroll reveals */

const revealItems = document.querySelectorAll("[data-reveal], [data-reveal-group]");

document
  .querySelectorAll("[data-reveal-group]")
  .forEach((group) =>
    Array.from(group.children).forEach((child, index) =>
      child.style.setProperty("--i", index),
    ),
  );

if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -10%", threshold: 0.08 },
  );
  revealItems.forEach((item) => revealObserver.observe(item));
  document.documentElement.classList.add("reveal-ready");
} else {
  revealItems.forEach((item) => item.classList.add("is-visible"));
}

/* Analytics events */

const dispatchAnalyticsEvent = (name, detail = {}) => {
  window.dispatchEvent(
    new CustomEvent("mergeship:analytics", { detail: { name, ...detail } }),
  );
};

document.querySelectorAll("[data-analytics-event]").forEach((link) => {
  link.addEventListener("click", () => {
    dispatchAnalyticsEvent(link.dataset.analyticsEvent, {
      location: link.dataset.analyticsLocation,
    });
  });
});

/* Video facades */

document
  .querySelectorAll("[data-video-id], [data-video-src]")
  .forEach((button) => {
    button.addEventListener("click", () => {
      const facade = button.closest("[data-video-facade]");
      if (!facade) return;

      if (button.dataset.videoSrc) {
        const video = document.createElement("video");
        video.src = button.dataset.videoSrc;
        video.poster = facade.querySelector("img")?.src || "";
        video.controls = true;
        video.playsInline = true;
        video.preload = "none";
        facade.replaceChildren(video);
        video.play();
        dispatchAnalyticsEvent("video_play", {
          videoSrc: button.dataset.videoSrc,
        });
        return;
      }

      const iframe = document.createElement("iframe");
      iframe.src = `https://www.youtube-nocookie.com/embed/${button.dataset.videoId}?autoplay=1&rel=0`;
      iframe.title = button.dataset.videoTitle || "MergeShip video";
      iframe.allow =
        "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      iframe.allowFullscreen = true;
      facade.replaceChildren(iframe);
      dispatchAnalyticsEvent("video_play", { videoId: button.dataset.videoId });
    });
  });

/* Footer year */

document.querySelectorAll("[data-year]").forEach((year) => {
  year.textContent = String(new Date().getFullYear());
});
