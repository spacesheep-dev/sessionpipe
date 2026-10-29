// SPDX-License-Identifier: Apache-2.0
// sessionpipe-gui's showcase (home and /gui/): one recording per scheme in one window. The one
// the scheme in force shows plays while it is on screen, and pauses off screen, in a hidden tab,
// or when the scheme changes; the other is never fetched. With reduced motion none plays and
// the poster (the first frame) stands, as it does without this file.
// Its own block: the page's scripts share one global scope.
{
  const calm = matchMedia("(prefers-reduced-motion: reduce)");

  for (const fig of document.querySelectorAll(".showcase")) {
    const videos = [...fig.querySelectorAll("video")];
    let seen = false;
    const update = () => {
      for (const v of videos) {
        const shown = v.checkVisibility ? v.checkVisibility() : v.offsetParent !== null;
        if (seen && shown && !document.hidden && !calm.matches) {
          v.preload = "auto";
          v.play().catch(() => {});
        } else v.pause();
      }
    };
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(
        ([e]) => {
          seen = e.isIntersecting;
          update();
        },
        { threshold: 0.3 },
      ).observe(fig);
    }
    document.addEventListener("visibilitychange", update);
    calm.addEventListener("change", update);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", update);
    // the header's button sets <html data-theme>
    new MutationObserver(update).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
}
