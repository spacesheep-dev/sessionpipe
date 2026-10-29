// SPDX-License-Identifier: Apache-2.0
// The home page's stream, as a sink at each tier receives it. The checked radio is the
// state and site.css draws it with :has(), so the control works without this file. This
// file slides one thumb along the control to the tier in force, walks the tiers once (1, 0,
// 1, 2, 3, back to 1) the first time the figure is in view, and says what a tier carries
// when someone picks one. Touching the control, focusing it or pointing at it ends the walk.
// Off screen or in a hidden tab the walk waits; with reduced motion there is none.
const group = document.querySelector(".term .tiers");
if (group) {
  const fig = group.closest(".term");
  const radios = [...group.querySelectorAll("input")];
  const notes = [...fig.querySelectorAll(".carries [data-n]")].map((n) => n.textContent);
  const live = fig.querySelector("[aria-live]");

  // the thumb: under the checked segment, moved to it with transform and width only
  const thumb = document.createElement("i");
  thumb.className = "thumb";
  thumb.setAttribute("aria-hidden", "true");
  group.prepend(thumb);
  const place = () => {
    const label = radios.find((r) => r.checked)?.closest("label");
    if (!label) return;
    // measured on screen to the sub-pixel, then divided by the plate's own scale (it rises in
    // from 0.985), so the thumb lands on the segment's layout box
    const [g, l] = [group.getBoundingClientRect(), label.getBoundingClientRect()];
    const k = g.width / group.offsetWidth || 1;
    group.style.setProperty("--x", `${(l.left - g.left) / k - group.clientLeft}px`);
    group.style.setProperty("--w", `${l.width / k}px`);
  };
  place();
  // in place before it may move, so the first paint doesn't slide in from the left
  requestAnimationFrame(() => requestAnimationFrame(() => group.classList.add("slide")));
  new ResizeObserver(place).observe(group);
  for (const r of radios) new ResizeObserver(place).observe(r.closest("label"));
  document.fonts?.ready.then(place);

  const show = (tier) => {
    radios[tier].checked = true;
    place();
  };

  // [tier, ms it stays]: the first hold lets the rows arrive.
  const walk = [
    [1, 3600],
    [0, 2600],
    [1, 2000],
    [2, 3000],
    [3, 3000],
    [1, 0],
  ];
  let step = 0;
  let timer = 0;
  let seen = false;
  let done = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const stop = () => {
    done = true;
    clearTimeout(timer);
    io.disconnect();
    document.removeEventListener("visibilitychange", wake);
  };
  const next = () => {
    if (done || timer || !seen || document.hidden) return;
    const [tier, ms] = walk[step];
    show(tier);
    if (++step === walk.length) return stop();
    timer = setTimeout(() => {
      timer = 0;
      next();
    }, ms);
  };
  // Waking up repeats the step it was on, from the start.
  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    step--;
  };
  const wake = () => (document.hidden ? pause() : next());
  const io = new IntersectionObserver(
    ([e]) => {
      seen = e.isIntersecting;
      if (seen) next();
      else pause();
    },
    { threshold: 0.6 },
  );
  if (!done) {
    io.observe(fig);
    document.addEventListener("visibilitychange", wake);
  }

  for (const type of ["pointerdown", "pointerenter", "keydown", "focusin"]) group.addEventListener(type, stop);
  group.addEventListener("change", (e) => {
    stop();
    place();
    live.textContent = notes[Number(e.target.value)];
  });
}
