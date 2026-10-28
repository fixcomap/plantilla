// Envío de formularios sin salir de la página: si el servidor responde un
// error se muestra como aviso flotante y no se pierde lo escrito; si va bien,
// se navega a donde indique (con su ancla). Sin JS, los formularios funcionan
// igual que siempre (mejora progresiva).
"use strict";

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 6000);
}

// Navega a url; si solo cambia el ancla, recarga y luego baja a ella.
function go(url) {
  const u = new URL(url, location.href);
  if (u.origin !== location.origin) return; // solo dentro de la app
  if (u.pathname + u.search === location.pathname + location.search) {
    if (u.hash) sessionStorage.setItem("scrollTo", u.hash);
    location.reload();
  } else {
    location.assign(u.href);
  }
}

document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (e.defaultPrevented || form.method.toLowerCase() !== "post" || form.dataset.native !== undefined) return;
  e.preventDefault();
  const btn = e.submitter;
  if (btn) btn.disabled = true;
  try {
    // Formularios normales en urlencoded (como los envía el navegador sin
    // JS); solo los que suben ficheros van en multipart.
    const fd = new FormData(form, btn);
    const body = form.enctype === "multipart/form-data" ? fd : new URLSearchParams(fd);
    const res = await fetch(form.action, {
      method: "POST",
      body,
      headers: { "X-Requested-With": "fetch" },
    });
    const isJSON = (res.headers.get("Content-Type") || "").includes("application/json");
    const data = isJSON ? await res.json() : null;
    if (!res.ok) {
      showToast((data && data.error) || "No se pudo guardar. Vuelve a intentarlo.");
    } else if (data && data.location) {
      go(data.location);
      return;
    } else {
      go(res.url); // respuestas que no son de la app (p. ej. salir)
      return;
    }
  } catch {
    showToast("Sin conexión: no se pudo enviar. Vuelve a intentarlo cuando tengas señal.");
  }
  if (btn) btn.disabled = false;
});

window.addEventListener("load", () => {
  const h = sessionStorage.getItem("scrollTo");
  if (!h) return;
  sessionStorage.removeItem("scrollTo");
  const el = document.getElementById(h.slice(1));
  if (el) el.scrollIntoView();
});

document.addEventListener("click", (e) => {
  if (e.target.id === "toast") e.target.hidden = true;
});

// Pestañas: en el móvil se pasa de una a otra deslizando el dedo. El contenido
// sigue al dedo; al soltar pasado el umbral (o con un gesto rápido) sale por
// ese lado y la siguiente entra por el contrario. Solo en las páginas raíz de
// cada pestaña: dentro de un jugador o de la pizarra el gesto es de la página.
(() => {
  const tabs = [...document.querySelectorAll("nav.tabs a")];
  const main = document.querySelector("main");
  if (!tabs.length || !main) return;
  const on = tabs.findIndex((a) => a.classList.contains("on"));
  const remember = (dir) => { try { sessionStorage.setItem("enter", dir); } catch { /* sin almacenamiento: sin animación */ } };

  // Tocar una pestaña también entra desde su lado.
  tabs.forEach((a, i) => a.addEventListener("click", () => {
    if (on >= 0 && i !== on) remember(i > on ? "next" : "prev");
  }));

  const cur = tabs.findIndex((a) => a.pathname === location.pathname);
  if (cur < 0 || !matchMedia("(pointer: coarse)").matches) return;
  main.classList.add("swipeable");
  // Las vecinas, ya pedidas: el cambio no espera a la red.
  for (const i of [cur - 1, cur + 1]) {
    if (!tabs[i]) continue;
    const l = document.createElement("link");
    l.rel = "prefetch";
    l.href = tabs[i].href;
    document.head.append(l);
  }

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ease = "cubic-bezier(.2,.75,.3,1)";
  let x0 = null, y0 = 0, dx = 0, axis = null, lastX = 0, lastT = 0, vx = 0;
  const reset = () => { main.style.transform = ""; main.style.opacity = ""; };

  main.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    // Bordes de pantalla: son el gesto de atrás/adelante de iOS.
    if (e.touches.length !== 1 || t.clientX < 24 || t.clientX > innerWidth - 24 ||
        e.target.closest("input, textarea, select, canvas, .board, .pitch, .mini-pitch, [data-noswipe]")) {
      x0 = null;
      return;
    }
    x0 = lastX = t.clientX; y0 = t.clientY; lastT = e.timeStamp; dx = 0; vx = 0; axis = null;
  }, { passive: true });

  main.addEventListener("touchmove", (e) => {
    if (x0 === null) return;
    const t = e.touches[0];
    const mx = t.clientX - x0, my = t.clientY - y0;
    if (!axis) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      axis = Math.abs(mx) > Math.abs(my) * 1.2 ? "x" : "y";
    }
    if (axis !== "x") return;
    e.preventDefault();
    dx = mx;
    vx = (t.clientX - lastX) / Math.max(e.timeStamp - lastT, 1);
    lastX = t.clientX; lastT = e.timeStamp;
    // Sin pestaña a ese lado: resistencia, como un muelle.
    const edge = !tabs[dx < 0 ? cur + 1 : cur - 1];
    const shown = edge ? dx / 4 : dx;
    main.style.transition = "none";
    main.style.transform = `translateX(${shown}px)`;
    main.style.opacity = 1 - Math.min(Math.abs(shown) / innerWidth, 1) * 0.4;
  }, { passive: false });

  const end = () => {
    if (x0 === null || axis !== "x") { x0 = null; return; }
    x0 = null;
    const i = dx < 0 ? cur + 1 : cur - 1;
    const fast = Math.abs(vx) > 0.45 && Math.sign(vx) === Math.sign(dx) && Math.abs(dx) > 30;
    main.style.transition = `transform .22s ${ease}, opacity .22s ${ease}`;
    if (!tabs[i] || !(fast || Math.abs(dx) > innerWidth * 0.28)) {
      reset();
      return;
    }
    main.style.transform = `translateX(${dx < 0 ? -innerWidth : innerWidth}px)`;
    main.style.opacity = "0";
    tabs.forEach((a, k) => a.classList.toggle("on", k === i)); // la barra responde ya
    remember(dx < 0 ? "next" : "prev");
    setTimeout(() => location.assign(tabs[i].href), reduce ? 0 : 170);
  };
  main.addEventListener("touchend", end);
  main.addEventListener("touchcancel", () => { dx = 0; end(); });

  // Volver atrás desde la caché del navegador: la página sigue desplazada.
  addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    main.style.transition = "none";
    reset();
    requestAnimationFrame(() => { main.style.transition = ""; });
    tabs.forEach((a, k) => a.classList.toggle("on", k === cur));
  });
})();
