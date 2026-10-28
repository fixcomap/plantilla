// Pizarra táctica: campo vertical de 68 x 105 m (portería propia abajo) en
// SVG. Una pizarra es una jugada de uno o más pasos: cada paso guarda dónde
// están las fichas y el balón y sus flechas, y Reproducir anima de un paso al
// siguiente. Todo se construye con createElementNS y textContent (sin innerHTML).
"use strict";

const NS = "http://www.w3.org/2000/svg";
const W = 68, L = 105;

function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function drawPitch(svg) {
  const g = el("g", { class: "bp-lines" }, svg);
  el("rect", { x: 0, y: 0, width: W, height: L, rx: 0.6, class: "bp-grass" }, g);
  el("line", { x1: 0, y1: L / 2, x2: W, y2: L / 2 }, g);
  el("circle", { cx: W / 2, cy: L / 2, r: 9.15 }, g);
  el("circle", { cx: W / 2, cy: L / 2, r: 0.4, class: "bp-spot" }, g);
  for (const top of [true, false]) {
    const y = (d) => (top ? d : L - d);
    // Área grande (40,3 x 16,5), chica (18,3 x 5,5) y punto de penalti (11 m).
    el("rect", { x: (W - 40.3) / 2, y: top ? 0 : L - 16.5, width: 40.3, height: 16.5 }, g);
    el("rect", { x: (W - 18.3) / 2, y: top ? 0 : L - 5.5, width: 18.3, height: 5.5 }, g);
    el("circle", { cx: W / 2, cy: y(11), r: 0.4, class: "bp-spot" }, g);
    el("rect", { x: (W - 7.3) / 2, y: top ? -1.6 : L, width: 7.3, height: 1.6, class: "bp-goal" }, g);
  }
}

// Flecha ondulada (conducción): seno a lo largo de la recta y tramo final
// recto para la punta. Mismo cálculo que board_image.go.
function wavePoints(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  if (len < 4) return [a, b];
  const ux = dx / len, uy = dy / len, pts = [];
  for (let s = 0; s <= len - 2; s += 0.25) {
    const o = Math.sin((s / 3) * 2 * Math.PI) * 0.8;
    pts.push({ x: a.x + ux * s - uy * o, y: a.y + uy * s + ux * o });
  }
  pts.push(b);
  return pts;
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function initBoard(svg, state, players) {
  const defs = el("defs", {}, svg);
  const marker = el("marker", { id: "bp-head", viewBox: "0 0 10 10", refX: 8, refY: 5,
    markerWidth: 5, markerHeight: 5, orient: "auto-start-reverse" }, defs);
  el("path", { d: "M0,0 L10,5 L0,10 z", class: "bp-head" }, marker);
  // Brillo del láser.
  const glow = el("filter", { id: "bp-glow", x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs);
  el("feGaussianBlur", { stdDeviation: 0.7, result: "b" }, glow);
  const merge = el("feMerge", {}, glow);
  el("feMergeNode", { in: "b" }, merge);
  el("feMergeNode", { in: "SourceGraphic" }, merge);
  drawPitch(svg);
  const arrowsG = el("g", { class: "bp-arrows" }, svg);
  const tokensG = el("g", {}, svg);
  const laserG = el("g", { class: "bp-laser", filter: "url(#bp-glow)" }, svg);

  // Modelo: meta (dorsal y nombre de cada ficha) y frames (un paso cada uno).
  const meta = state.tokens.map((t) => ({ label: t.label, name: t.name }));
  const frames = [{ pos: state.tokens.map((t) => ({ x: t.x, y: t.y })), ball: { ...state.ball }, arrows: state.arrows }];
  for (const s of state.steps || []) {
    frames.push({ pos: meta.map((_, i) => s.pos[i] || { ...frames[0].pos[i] }), ball: s.ball, arrows: s.arrows || [] });
  }
  let cur = 0, mode = "move", dirty = false, drag = null, drawing = null, laser = null, view = null, playing = null;
  const history = [];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const $ = (id) => document.getElementById(id);
  const status = $("board-status"), hint = $("board-hint"), nameInput = $("board-name");
  const undoBtn = $("board-undo"), stepsEl = $("board-steps"), playBtn = $("step-play"), delBtn = $("step-del");
  const names = { move: "Mover", pass: "Pase", run: "Carrera", dribble: "Conducción", laser: "Láser", remove: "Borrar" };
  const hints = {
    move: "Arrastra fichas y balón · toca una ficha para ponerle jugador",
    pass: "Arrastra para dibujar un pase", run: "Arrastra para dibujar una carrera",
    dribble: "Arrastra para dibujar una conducción", laser: "Señala con el dedo: el trazo se borra solo",
    remove: "Toca una ficha o una flecha para quitarla",
  };

  const snap = () => JSON.stringify({ meta, frames, cur });
  const pushHistory = (s) => {
    history.push(s);
    if (history.length > 80) history.shift();
    undoBtn.disabled = false;
  };
  const changed = () => {
    dirty = true;
    status.textContent = "Cambios sin guardar";
    status.classList.add("dirty");
  };

  const pt = (ev) => {
    const p = svg.createSVGPoint();
    p.x = ev.clientX; p.y = ev.clientY;
    const q = p.matrixTransform(svg.getScreenCTM().inverse());
    return { x: Math.max(0, Math.min(W, q.x)), y: Math.max(0, Math.min(L, q.y)) };
  };

  function drawArrow(a, i, parent) {
    const kind = a.kind || "run";
    const attrs = { class: `bp-arrow k-${kind}`, "marker-end": "url(#bp-head)" };
    if (i >= 0) attrs["data-arrow"] = i;
    if (kind === "dribble") {
      attrs.points = wavePoints(a.from, a.to).map((p) => `${p.x},${p.y}`).join(" ");
      el("polyline", attrs, parent);
    } else {
      el("line", { ...attrs, x1: a.from.x, y1: a.from.y, x2: a.to.x, y2: a.to.y }, parent);
    }
  }

  function render() {
    const f = frames[cur];
    const pos = view ? view.pos : f.pos, ball = view ? view.ball : f.ball;
    arrowsG.replaceChildren();
    arrowsG.classList.toggle("fading", !!view);
    (view ? view.arrows : f.arrows).forEach((a, i) => drawArrow(a, view ? -1 : i, arrowsG));
    if (drawing) drawArrow(drawing, -1, arrowsG);
    tokensG.replaceChildren();
    meta.forEach((t, i) => {
      const g = el("g", { class: "bp-token", "data-token": i, transform: `translate(${pos[i].x} ${pos[i].y})` }, tokensG);
      el("circle", { r: 3.4 }, g);
      el("text", { class: "bp-label", y: 0.1 }, g).textContent = t.label || String(i + 1);
      if (t.name) el("text", { class: "bp-name", y: 6 }, g).textContent = t.name;
    });
    const b = el("g", { class: "bp-ball", "data-ball": 1, transform: `translate(${ball.x} ${ball.y})` }, tokensG);
    el("circle", { r: 1.4 }, b);
  }

  function renderSteps() {
    stepsEl.replaceChildren();
    frames.forEach((_, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "step" + (i === cur ? " on" : "");
      b.textContent = String(i + 1);
      b.setAttribute("aria-label", `Paso ${i + 1}`);
      b.addEventListener("click", () => { if (!playing && i !== cur) goStep(i); });
      stepsEl.append(b);
    });
    playBtn.disabled = frames.length < 2;
    delBtn.hidden = frames.length < 2;
    $("step-add").disabled = frames.length > 15;
  }

  // Animación de un paso a otro: fichas y balón se desplazan; las flechas del
  // paso de origen quedan atenuadas mientras tanto.
  function animate(from, to, ms) {
    if (reduce) return Promise.resolve();
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        if (playing && playing.stop) { view = null; resolve(); return; }
        const k = ease(Math.min((now - t0) / ms, 1));
        view = { pos: from.pos.map((p, i) => lerp(p, to.pos[i], k)), ball: lerp(from.ball, to.ball, k), arrows: from.arrows };
        render();
        if (k < 1) requestAnimationFrame(tick);
        else { view = null; resolve(); }
      };
      requestAnimationFrame(tick);
    });
  }

  async function goStep(i) {
    const from = frames[cur];
    playing = { stop: false };
    await animate(from, frames[i], 380);
    playing = null;
    cur = i;
    render(); renderSteps();
  }

  async function play() {
    if (playing) { playing.stop = true; return; }
    if (cur === frames.length - 1) { cur = 0; render(); renderSteps(); await sleep(300); }
    playing = { stop: false };
    playBtn.classList.add("on");
    playBtn.querySelector("use").setAttribute("href", "#i-pause");
    playBtn.querySelector("span").textContent = "Parar";
    while (cur < frames.length - 1 && !playing.stop) {
      await animate(frames[cur], frames[cur + 1], 1100);
      if (playing.stop) break;
      cur++;
      render(); renderSteps();
      await sleep(350);
    }
    playing = null;
    playBtn.classList.remove("on");
    playBtn.querySelector("use").setAttribute("href", "#i-play");
    playBtn.querySelector("span").textContent = "Reproducir";
    render(); renderSteps();
  }

  // Láser: estela que se apaga sola; no se guarda ni entra en deshacer.
  function drawLaser() {
    laserG.replaceChildren();
    if (!laser) return;
    const now = performance.now();
    laser.pts = laser.pts.filter((p) => now - p.t < 900);
    for (let i = 1; i < laser.pts.length; i++) {
      const a = laser.pts[i - 1], b = laser.pts[i];
      const life = 1 - (now - b.t) / 900;
      el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, "stroke-width": 0.35 + life * 0.6, opacity: life }, laserG);
    }
    const last = laser.pts[laser.pts.length - 1];
    if (laser.down && last) el("circle", { cx: last.x, cy: last.y, r: 1.1, class: "dot" }, laserG);
    if (laser.down || laser.pts.length) requestAnimationFrame(drawLaser);
    else laser = null;
  }

  function removeToken(i) {
    meta.splice(i, 1);
    frames.forEach((f) => f.pos.splice(i, 1));
  }

  svg.addEventListener("pointerdown", (ev) => {
    if (playing) return;
    const tok = ev.target.closest("[data-token]");
    const ball = ev.target.closest("[data-ball]");
    const arrow = ev.target.closest("[data-arrow]");
    const f = frames[cur];
    if (mode === "remove") {
      if (tok) { pushHistory(snap()); removeToken(+tok.dataset.token); }
      else if (arrow) { pushHistory(snap()); f.arrows.splice(+arrow.dataset.arrow, 1); }
      else return;
      changed(); render(); return;
    }
    if (mode === "laser") {
      const p = pt(ev);
      const start = !laser;
      laser = laser || { pts: [] };
      laser.down = true;
      laser.pts.push({ ...p, t: performance.now() });
      if (start) requestAnimationFrame(drawLaser);
    } else if (mode !== "move") {
      const p = pt(ev);
      drawing = { kind: mode === "run" ? "" : mode, from: p, to: { ...p } };
    } else if (tok || ball) {
      const i = tok ? +tok.dataset.token : -1;
      drag = { i, target: tok ? f.pos[i] : f.ball, start: pt(ev), moved: false, before: snap() };
    } else {
      return;
    }
    svg.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  svg.addEventListener("pointermove", (ev) => {
    if (laser && laser.down) { laser.pts.push({ ...pt(ev), t: performance.now() }); return; }
    if (!drag && !drawing) return;
    const p = pt(ev);
    if (drag) {
      if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 0.8) return;
      drag.moved = true;
      drag.target.x = p.x; drag.target.y = p.y;
    }
    if (drawing) drawing.to = p;
    render();
  });
  const end = () => {
    if (laser) laser.down = false;
    if (drawing) {
      const d = Math.hypot(drawing.to.x - drawing.from.x, drawing.to.y - drawing.from.y);
      if (d >= 2) { // un toque no es una flecha
        pushHistory(snap());
        const a = { from: drawing.from, to: drawing.to };
        if (drawing.kind) a.kind = drawing.kind;
        frames[cur].arrows.push(a);
        changed();
      }
    }
    if (drag) {
      if (drag.moved) { pushHistory(drag.before); changed(); }
      else if (drag.i >= 0) openPicker(drag.i); // toque: elegir jugador
    }
    drag = drawing = null;
    render();
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);

  // Dock: herramienta activa y su nombre bajo el dock un momento.
  let hintTimer;
  const setMode = (m) => {
    mode = m;
    document.querySelectorAll(".dock [data-mode]").forEach((x) => x.classList.toggle("on", x.dataset.mode === m));
    svg.dataset.mode = m;
    hint.textContent = `${names[m]} · ${hints[m]}`;
    hint.classList.add("show");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove("show"), 2200);
  };
  document.querySelectorAll(".dock [data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  undoBtn.addEventListener("click", () => {
    const s = history.pop();
    if (!s) return;
    const o = JSON.parse(s);
    meta.splice(0, meta.length, ...o.meta);
    frames.splice(0, frames.length, ...o.frames);
    cur = Math.min(o.cur, frames.length - 1);
    undoBtn.disabled = !history.length;
    changed(); render(); renderSteps();
  });

  $("step-add").addEventListener("click", () => {
    if (playing || frames.length > 15) return;
    pushHistory(snap());
    const f = frames[cur];
    frames.splice(cur + 1, 0, { pos: f.pos.map((p) => ({ ...p })), ball: { ...f.ball }, arrows: [] });
    cur++;
    changed(); render(); renderSteps();
  });
  delBtn.addEventListener("click", () => {
    if (playing || frames.length < 2) return;
    pushHistory(snap());
    frames.splice(cur, 1);
    cur = Math.max(0, cur - 1);
    changed(); render(); renderSteps();
  });
  playBtn.addEventListener("click", play);

  // Selector de jugador: añadir ficha nueva o cambiar la que se ha tocado.
  const pick = $("board-pick"), list = $("pick-list"), freeName = $("pick-name");
  let picking = null; // índice de la ficha o null = nueva
  function applyPick(label, name) {
    pushHistory(snap());
    if (picking === null) {
      if (meta.length >= 30) return;
      meta.push({ label: label || String(meta.length + 1), name });
      // Aparece en el centro del campo propio, en todos los pasos.
      frames.forEach((f) => f.pos.push({ x: W / 2 + (meta.length % 5) * 2 - 4, y: L * 0.62 }));
    } else {
      const t = meta[picking];
      // Las fichas de una formación llevan la posición (DFC, MC…): se conserva.
      if (label && (!t.label || /^\d+$/.test(t.label))) t.label = label;
      t.name = name;
    }
    pick.close();
    changed(); render();
  }
  function openPicker(i) {
    picking = i;
    $("pick-title").textContent = i === null ? "Añadir ficha" : `Ficha ${meta[i].label || i + 1}`;
    $("pick-blank").textContent = i === null ? "Sin nombre" : "Quitar nombre";
    const used = new Set(meta.map((m) => m.name));
    list.replaceChildren();
    for (const p of players) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = used.has(p.name) ? "used" : "";
      const n = document.createElement("b");
      n.textContent = p.label || "–";
      b.append(n, document.createTextNode(p.name));
      b.addEventListener("click", () => applyPick(p.label, p.name));
      li.append(b);
      list.append(li);
    }
    freeName.value = i === null ? "" : meta[i].name;
    pick.showModal();
  }
  $("board-add").addEventListener("click", () => openPicker(null));
  $("pick-free").addEventListener("click", () => { if (freeName.value.trim()) applyPick("", freeName.value.trim().slice(0, 24)); });
  $("pick-blank").addEventListener("click", () => applyPick("", ""));
  pick.addEventListener("click", (e) => { if (e.target === pick) pick.close(); }); // tocar fuera cierra

  const toState = () => ({
    tokens: meta.map((m, i) => ({ label: m.label, name: m.name, x: frames[0].pos[i].x, y: frames[0].pos[i].y })),
    ball: frames[0].ball,
    arrows: frames[0].arrows,
    steps: frames.slice(1).map((f) => ({ pos: f.pos, ball: f.ball, arrows: f.arrows })),
  });
  async function save() {
    status.textContent = "Guardando…";
    const res = await fetch(location.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nameInput.value, state: toState() }),
    }).catch(() => null);
    if (res && res.ok) {
      dirty = false;
      status.textContent = "Guardado";
      status.classList.remove("dirty");
      return true;
    }
    status.textContent = "No se pudo guardar" + (res ? ": " + (await res.text()).trim() : " (sin conexión)");
    return false;
  }
  nameInput.addEventListener("input", changed);
  $("board-save").addEventListener("click", save);

  // Compartir: imagen generada en el servidor (lo guardado), con la hoja de
  // compartir del sistema si la hay; si no, se descarga.
  $("board-share").addEventListener("click", async () => {
    if (dirty && !(await save())) return;
    const url = `${location.pathname}/imagen.png?paso=${cur + 1}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.statusText);
      const file = new File([await res.blob()], `${(nameInput.value || "pizarra").replace(/[^\p{L}\p{N}]+/gu, "-")}.png`, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: nameInput.value });
        return;
      }
    } catch (e) {
      if (e.name === "AbortError") return; // cerró la hoja de compartir
    }
    location.assign(url + "&descargar");
  });

  // Salir con cambios sin guardar: aviso propio con guardar o descartar.
  const unsaved = $("board-unsaved");
  let leaveTo = null;
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a || !dirty || a.target || e.defaultPrevented) return;
    e.preventDefault();
    leaveTo = a.href;
    unsaved.showModal();
  }, true);
  unsaved.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "stay" || e.target === unsaved) unsaved.close();
    else if (act === "discard") { dirty = false; location.assign(leaveTo); }
    else if (act === "save" && (await save())) location.assign(leaveTo);
    else if (act === "save") unsaved.close();
  });
  window.addEventListener("beforeunload", (e) => { if (dirty) e.preventDefault(); });

  svg.dataset.mode = mode;
  render(); renderSteps();
}
