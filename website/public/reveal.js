// SPDX-License-Identifier: Apache-2.0
// The home page's sections, in view once. What is marked data-reveal and starts below the fold
// is lowered and faded (.pending) and rises into place the first time it comes up the page;
// data-reveal="kids" does that to its children one after another, which also starts a figure's
// own sequence (the flow's strikes, the tiers' meters). Nothing on screen at load is ever
// hidden; without this file, or with reduced motion, nothing is hidden at all.
// It also starts the hero's entrance (the inlet's pulses, the stream's rows) when the feed is
// in view, so it never plays above a fold it hasn't reached; site.css holds it until .go.
// A page opened at an anchor skips all of it: nothing moves under a reader who jumped there.
document.documentElement.dataset.motion = "ready";
const marked = [...document.querySelectorAll("[data-reveal]")];
const feed = document.querySelector(".home .feed");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (feed) {
  if (still || location.hash || !("IntersectionObserver" in window)) feed.classList.add("go");
  else {
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        feed.classList.add("go");
        io.disconnect();
      },
      { threshold: 0.25 },
    );
    io.observe(feed);
  }
}

if (marked.length && "IntersectionObserver" in window && !still && !location.hash) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.remove("pending");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -10% 0px" },
  );
  for (const el of marked) {
    if (el.dataset.reveal === "kids") {
      for (const [k, kid] of [...el.children].entries()) kid.style.setProperty("--k", k);
    }
    if (el.getBoundingClientRect().top < innerHeight * 0.92) continue;
    el.classList.add("pending");
    io.observe(el);
  }
}
