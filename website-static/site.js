document.documentElement.classList.add("has-js");

const customCursorQuery = window.matchMedia(
  "(hover: hover) and (pointer: fine)",
);
const customCursor = document.createElement("div");
customCursor.className = "custom-cursor";
customCursor.setAttribute("aria-hidden", "true");
customCursor.innerHTML = `
  <svg viewBox="0 0 28 32" aria-hidden="true" focusable="false">
    <path
      d="M2.5 2.5 24.2 14.8l-8.3 2.1 5 8.8-4.5 2.5-4.9-8.9-6.1 6.3Z"
      fill="#07142f"
      stroke="#ffffff"
      stroke-linejoin="round"
      stroke-width="2.2"
    />
  </svg>
`;
document.body.append(customCursor);

let cursorFrame = 0;
let cursorX = -48;
let cursorY = -48;

const hideCustomCursor = () => {
  if (cursorFrame) {
    window.cancelAnimationFrame(cursorFrame);
    cursorFrame = 0;
  }
  document.documentElement.classList.remove("has-custom-cursor");
  customCursor.classList.remove("is-visible", "is-active");
};

const updateCustomCursor = () => {
  customCursor.style.transform = `translate3d(${cursorX - 2}px, ${cursorY - 2}px, 0)`;
  customCursor.classList.add("is-visible");
  document.documentElement.classList.add("has-custom-cursor");
  cursorFrame = 0;
};

window.addEventListener(
  "pointermove",
  (event) => {
    if (
      !customCursorQuery.matches ||
      event.pointerType === "touch" ||
      event.target.closest?.("[data-native-cursor]")
    ) {
      hideCustomCursor();
      return;
    }

    cursorX = event.clientX;
    cursorY = event.clientY;
    if (!cursorFrame) {
      cursorFrame = window.requestAnimationFrame(updateCustomCursor);
    }
  },
  { passive: true },
);

window.addEventListener("pointerdown", () => {
  if (document.documentElement.classList.contains("has-custom-cursor")) {
    customCursor.classList.add("is-active");
  }
});
window.addEventListener("pointerup", () =>
  customCursor.classList.remove("is-active"),
);
window.addEventListener("pointercancel", hideCustomCursor);
window.addEventListener("blur", hideCustomCursor);
window.addEventListener("mouseout", (event) => {
  if (!event.relatedTarget) hideCustomCursor();
});
window.addEventListener("mergeship:cursor-suspend", hideCustomCursor);
customCursorQuery.addEventListener("change", hideCustomCursor);

const header = document.querySelector("[data-header]");
const updateHeader = () =>
  header?.classList.toggle("is-scrolled", window.scrollY > 10);
updateHeader();
window.addEventListener("scroll", updateHeader, { passive: true });

const revealItems = document.querySelectorAll("[data-reveal]");
if ("IntersectionObserver" in window) {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8%", threshold: 0.12 },
  );
  revealItems.forEach((item) => revealObserver.observe(item));
} else {
  revealItems.forEach((item) => item.classList.add("is-visible"));
}

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

document
  .querySelectorAll("[data-video-id], [data-video-src]")
  .forEach((button) => {
    button.addEventListener("click", () => {
      const facade = button.closest("[data-video-facade]");
      if (!facade) return;

      facade.setAttribute("data-native-cursor", "");
      window.dispatchEvent(new Event("mergeship:cursor-suspend"));

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

document.querySelectorAll("[data-year]").forEach((year) => {
  year.textContent = String(new Date().getFullYear());
});
