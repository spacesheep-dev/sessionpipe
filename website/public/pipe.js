// SPDX-License-Identifier: Apache-2.0
// How it works, in motion (home page only). One event at a time leaves a harness, goes through
// the core's five stages in order, leaves by the bar and the dot and reaches the receivers; now
// and then one needs you, goes through in orange, and the answer comes back the other way.
// Only transform, opacity and stroke-dashoffset move. One round plays each time the figure
// comes into view, then it rests; it holds while the pointer is on it. Nothing runs off-screen,
// in a hidden tab, or when reduced motion is asked for; without the script the figure is the
// same, standing still.
const fig = document.querySelector(".home .pipe");

if (fig?.getAnimations && "IntersectionObserver" in window) {
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const narrow = matchMedia("(max-width: 960px)");
  const all = (sel) => [...fig.querySelectorAll(sel)];
  const harnesses = all(".left li");
  const receivers = all(".right li");
  const stages = all(".core li");
  // the ends' rows tick as an event leaves or lands; a stage only brightens its name
  for (const li of [...harnesses, ...receivers]) {
    const tick = document.createElement("i");
    tick.className = "tick";
    li.append(tick);
  }
  // every wire gets a twin on top of it that carries the pulse
  const twins = (sel) =>
    all(`${sel} g path`).map((wire) => {
      const twin = wire.cloneNode();
      twin.classList.add("pulse");
      wire.parentNode.append(twin);
      return twin;
    });
  const wide = { in: twins(".wire.in"), out: twins(".wire.out"), dot: fig.querySelector(".wire.out .dot") };
  const tall = { in: twins(".vwire.in"), out: twins(".vwire.out"), dot: fig.querySelector(".vwire.out .dot") };

  const ease = getComputedStyle(fig).getPropertyValue("--ease").trim() || "cubic-bezier(0.22, 1, 0.36, 1)";
  const into = "cubic-bezier(0.4, 0, 1, 1)";
  // a dash runs the wire's length; on the fan-out it stays hidden on the stretch the five wires
  // share and fades in as it splits off
  const along = (path, delay, ms, back, easing, fan, hot = false) => {
    const dash = narrow.matches ? 16 : 12;
    const len = path.getTotalLength();
    const [from, to] = back ? [-len, dash] : [dash, -len];
    path.classList.toggle("back", back);
    path.classList.toggle("hot", hot);
    path.style.strokeDasharray = `${dash} ${len + dash}`;
    // (offsets are of the dash's way along, so they hold whatever the easing)
    const show = fan
      ? [
          { opacity: 0, offset: 0.24 },
          { opacity: 1, offset: 0.36 },
        ]
      : [{ opacity: 1, offset: 0.05 }];
    path.animate(
      [
        { strokeDashoffset: from, opacity: 0 },
        ...show,
        { opacity: 1, offset: 0.95 },
        { strokeDashoffset: to, opacity: 0 },
      ],
      { duration: ms, delay, easing },
    );
  };
  const tick = (li, delay, hot = false) => {
    li.lastChild.classList.toggle("hot", hot);
    return li.lastChild.animate(
      [
        { transform: "scaleX(0)", opacity: 1, easing: ease },
        { transform: "scaleX(1)", opacity: 1, offset: 0.4 },
        { transform: "scaleX(1)", opacity: 0 },
      ],
      { duration: 600, delay },
    );
  };
  const stage = (li, delay) =>
    li.firstChild.animate(
      [{ opacity: 0.66 }, { opacity: 1, offset: 0.16 }, { opacity: 1, offset: 0.4 }, { opacity: 0.66 }],
      {
        duration: 500,
        delay,
        fill: "none",
      },
    );

  // an event: harness row → its wire → adapt … outbox → the dot → every receiver, in about 1.2 s;
  // it speeds into the core and slows into the receivers. One that needs you (attention.needed)
  // is drawn in orange and the dot beats harder for it.
  const send = (h, hot = false) => {
    const n = narrow.matches;
    const w = n ? tall : wide;
    const t = n ? [300, 320] : [360, 380];
    tick(harnesses[h], 0, hot);
    along(w.in[n ? 1 : h], 80, t[0], false, into, false, hot);
    const core = 80 + t[0];
    for (const [k, li] of stages.entries()) stage(li, core + k * 70);
    const dot = core + 4 * 70 + 80;
    const beat = hot ? 1.3 : 1.12;
    w.dot.animate(
      [{ transform: "scale(1)" }, { transform: `scale(${beat})`, offset: 0.3 }, { transform: "scale(1)" }],
      {
        duration: hot ? 420 : 320,
        delay: dot,
        easing: ease,
      },
    );
    for (const path of w.out) along(path, dot + 20, t[1], false, ease, true, hot);
    for (const [k, li] of receivers.entries()) tick(li, dot + 20 + t[1] - 60 + (n ? k * 60 : 0), hot);
  };
  // control: receiver row → the dot → the core → the harness's wire → the harness row
  const answer = (r, h) => {
    const n = narrow.matches;
    const w = n ? tall : wide;
    tick(receivers[r], 0);
    along(w.out[n ? 1 : r], 120, 400, true, into);
    const back = 120 + 400 + 160;
    along(w.in[n ? 1 : h], back, 360, true, ease);
    tick(harnesses[h], back + 360 - 80);
  };

  // a fixed round that reads as a live machine: Claude Code busiest, Antigravity least. [h] is
  // an event from harness h; [h, "!"] one that needs you; [r, h] the answer, from a receiver that
  // carries control to the harness that asked (ADAPTERS.md)
  const round = [[0], [2], [1], [4], [0, "!"], [0, 0], [3], [0], [2], [1, "!"], [1, 1], [4], [0], [2]];
  let step = 0;
  let timer = 0;
  let due = 0;
  let left = 600;
  let on = false;
  let rested = false;
  let held = false;
  const next = () => {
    const [a, b] = round[step];
    if (b === undefined || b === "!") send(a, b === "!");
    else answer(a, b);
    step = (step + 1) % round.length;
    // the round is over: rest until the figure has left the view and come back
    if (step === 0) {
      rested = true;
      on = false;
      left = 600;
      return;
    }
    // one event at a time: the next leaves only after this one has landed; an answer follows
    // the event that asked for it a moment after it lands
    schedule(b === "!" ? 1900 : b !== undefined ? 2600 : 2200 + ((step * 7) % 5) * 120);
  };
  const schedule = (ms) => {
    due = performance.now() + ms;
    timer = setTimeout(next, ms);
  };
  const run = (go) => {
    if (go === on) return;
    on = go;
    const moving = fig.getAnimations({ subtree: true });
    if (go) {
      for (const a of moving) a.play();
      schedule(left);
    } else {
      clearTimeout(timer);
      left = Math.max(0, due - performance.now());
      for (const a of moving) a.pause();
    }
  };

  let seen = false;
  const update = () => {
    fig.classList.toggle("live", !still.matches);
    if (still.matches) {
      run(false);
      for (const a of fig.getAnimations({ subtree: true })) a.cancel();
      return;
    }
    run(seen && !document.hidden && !rested && !held);
  };
  // start once a good part of the figure is in view, not when its edge peeks in
  new IntersectionObserver(
    ([entry]) => {
      seen = entry.intersectionRatio >= 0.35;
      if (!entry.isIntersecting) rested = false;
      update();
    },
    { threshold: [0, 0.35] },
  ).observe(fig);
  fig.addEventListener("pointerenter", () => {
    held = true;
    update();
  });
  fig.addEventListener("pointerleave", () => {
    held = false;
    update();
  });
  document.addEventListener("visibilitychange", update);
  still.addEventListener("change", update);
}
