// SPDX-License-Identifier: Apache-2.0
// How it works, in motion (home page only). One event at a time leaves a harness, goes through
// the core's five stages in order, leaves by the bar and the dot and reaches the receivers; now
// and then a message or a permission answer comes back the other way. Only transform, opacity
// and stroke-dashoffset move. Nothing runs off-screen, in a hidden tab, or when reduced motion
// is asked for; without the script the figure is the same, standing still.
const fig = document.querySelector(".home .pipe");

if (fig?.getAnimations && "IntersectionObserver" in window) {
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const narrow = matchMedia("(max-width: 960px)");
  const all = (sel) => [...fig.querySelectorAll(sel)];
  const harnesses = all(".left li");
  const receivers = all(".right li");
  const stages = all(".core li");
  for (const li of [...harnesses, ...stages, ...receivers]) {
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

  const out = "cubic-bezier(0.22, 1, 0.36, 1)";
  const along = (path, delay, ms, back) => {
    const dash = 16;
    const len = path.getTotalLength();
    const [from, to] = back ? [-len, dash] : [dash, -len];
    path.classList.toggle("back", back);
    path.style.strokeDasharray = `${dash} ${len + dash}`;
    path.animate(
      [
        { strokeDashoffset: from, opacity: 0 },
        { opacity: 1, offset: 0.05 },
        { opacity: 1, offset: 0.95 },
        { strokeDashoffset: to, opacity: 0 },
      ],
      { duration: ms, delay, easing: "cubic-bezier(0.45, 0, 0.3, 1)" },
    );
  };
  const tick = (li, delay) =>
    li.lastChild.animate(
      [
        { transform: "scaleX(0)", opacity: 1, easing: out },
        { transform: "scaleX(1)", opacity: 1, offset: 0.4 },
        { transform: "scaleX(1)", opacity: 0 },
      ],
      { duration: 760, delay },
    );
  const stage = (li, delay) => {
    tick(li, delay);
    li.firstChild.animate(
      [{ opacity: 0.66 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.45 }, { opacity: 0.66 }],
      {
        duration: 900,
        delay,
      },
    );
  };

  // an event: harness row → its wire → adapt … outbox → the dot → every receiver
  const send = (h) => {
    const w = narrow.matches ? tall : wide;
    const t = narrow.matches ? [380, 460] : [520, 540];
    tick(harnesses[h], 0);
    along(w.in[narrow.matches ? h % 3 : h], 160, t[0], false);
    const core = 160 + t[0] - 60;
    for (const [k, li] of stages.entries()) stage(li, core + k * 110);
    const dot = core + 4 * 110 + 220;
    w.dot.animate([{ transform: "scale(1)" }, { transform: "scale(1.2)", offset: 0.35 }, { transform: "scale(1)" }], {
      duration: 480,
      delay: dot,
      easing: out,
    });
    for (const path of w.out) along(path, dot + 80, t[1], false);
    for (const [k, li] of receivers.entries()) tick(li, dot + 80 + t[1] - 100 + (narrow.matches ? k * 60 : 0));
  };
  // control: receiver row → the dot → the core → the harness's wire → the harness row
  const answer = (r, h) => {
    const w = narrow.matches ? tall : wide;
    const t = narrow.matches ? [460, 380] : [540, 520];
    tick(receivers[r], 0);
    along(w.out[narrow.matches ? 1 : r], 120, t[0], true);
    const back = 120 + t[0] + 320;
    along(w.in[narrow.matches ? 1 : h], back, t[1], true);
    tick(harnesses[h], back + t[1] - 80);
  };

  // a fixed round that reads as a live machine: Claude Code busiest, Antigravity least; the
  // answers come from receivers that carry control, to harnesses that take it (ADAPTERS.md)
  const round = [[0], [2], [1], [0], [4], [0, 0], [3], [0], [1], [2], [1, 1], [4], [0], [2]];
  let step = 0;
  let timer = 0;
  let due = 0;
  let left = 600;
  let on = false;
  const next = () => {
    const [a, b] = round[step % round.length];
    if (b === undefined) send(a);
    else answer(a, b);
    step++;
    const coming = round[step % round.length];
    schedule(coming.length > 1 ? 2100 : b !== undefined ? 1500 : 1250 + ((step * 7) % 5) * 120);
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
    run(seen && !document.hidden);
  };
  new IntersectionObserver(([entry]) => {
    seen = entry.isIntersecting;
    update();
  }).observe(fig);
  document.addEventListener("visibilitychange", update);
  still.addEventListener("change", update);
}
