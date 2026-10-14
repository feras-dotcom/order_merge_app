document.documentElement.classList.add("has-js");

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

document.querySelectorAll("[data-video-id]").forEach((button) => {
  button.addEventListener("click", () => {
    const facade = button.closest("[data-video-facade]");
    if (!facade) return;

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
