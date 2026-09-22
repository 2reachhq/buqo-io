/*
 * engine.js – deterministische Timeline für die Hellora-Ads.
 *
 * Jeder Frame ist eine reine Funktion der Zeit t (Sekunden). Dadurch kann render.mjs
 * Frame für Frame "seeken" und screenshotten – ohne Timing-Drift, ohne verpasste Frames.
 * Im Browser (ohne ?render=1) läuft dieselbe Timeline als Live-Vorschau.
 *
 * Szenen-Typen ("kind"): brand · words · statement · shapes · list · stat · cta
 * Texte, Farben und Dauern werden in ads.js gepflegt.
 */
(function () {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const ids = Object.keys(ADS);
  const adId = ids.includes(qs.get('ad')) ? qs.get('ad') : ids[0];
  const AD = ADS[adId];
  const T = AD.theme || THEME;
  const FPS = AD.fps || T.fps || 30;

  const XFADE = AD.crossfade ?? 0.3;  // Überblendung zwischen Szenen (s)
  const EXIT = 0.45;                  // Dauer der Element-Ausblendung (s)
  const EXIT_LEAD = 0.55;             // Ausblendung beginnt so lange vor Szenenende (s)

  // ---------- Mathe & Easing ----------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const outQuint = t => 1 - Math.pow(1 - t, 5);
  const outCubic = t => 1 - Math.pow(1 - t, 3);
  const inOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const P = (lt, start, dur, e = outQuint) => e(clamp((lt - start) / dur, 0, 1));

  // ---------- DOM-Helfer ----------
  function mk(parent, cls, text) {
    const el = document.createElement('div');
    el.className = cls;
    if (text != null) el.textContent = text;
    parent.appendChild(el);
    return el;
  }
  const gradientCSS = (colors, angle = 135) => `linear-gradient(${angle}deg, ${colors.join(', ')})`;

  // Große Einzeiler (Marke, Zahl, Einzelwort) automatisch verkleinern, bis sie in die Safe-Area passen.
  // Läuft erst, wenn die Schrift geladen ist (sonst misst man die Fallback-Schrift).
  const fits = [];
  const SAFE_W = () => stage.offsetWidth - 2 * 96;
  function fitText(el, factor = 1) {
    fits.push(() => {
      el.style.whiteSpace = 'nowrap';
      let size = parseFloat(getComputedStyle(el).fontSize);
      const max = SAFE_W() * factor;
      for (let i = 0; i < 60 && el.scrollWidth > max; i++) { size *= 0.97; el.style.fontSize = size + 'px'; }
    });
  }

  // Text mit "\n" für Zeilenumbruch und *Wort* für Farbverlauf-Highlight → einzelne Wort-Spans.
  function richWords(parent, text) {
    const spans = [];
    String(text).split('\n').forEach((line, li) => {
      if (li > 0) parent.appendChild(document.createElement('br'));
      line.split(' ').filter(Boolean).forEach((w, wi) => {
        if (wi > 0) parent.appendChild(document.createTextNode(' '));
        const span = document.createElement('span');
        span.className = 'word el';
        const m = w.match(/^\*(.+?)\*(.*)$/);
        if (m) {
          const hl = document.createElement('span');
          hl.className = 'hl';
          hl.textContent = m[1];
          span.appendChild(hl);
          if (m[2]) span.appendChild(document.createTextNode(m[2]));
        } else {
          span.textContent = w;
        }
        parent.appendChild(span);
        spans.push(span);
      });
    });
    return spans;
  }

  // Ein-/Ausblendung eines Elements: Opacity, Y-Versatz, Weichzeichner, Skalierung – alles aus lt berechnet.
  function show(el, lt, inStart, o = {}) {
    const inDur = o.inDur ?? 0.85, y = o.y ?? 40, blur = o.blur ?? 12, scaleFrom = o.scaleFrom ?? 1;
    const outStart = o.outStart ?? Infinity, outDur = o.outDur ?? EXIT, yOut = o.yOut ?? -24, blurOut = o.blurOut ?? 8;
    const pi = P(lt, inStart, inDur, outQuint);
    const po = P(lt, outStart, outDur, inOutCubic);
    const op = pi * (1 - po);
    const ty = (1 - pi) * y + po * yOut;
    const bl = (1 - pi) * blur + po * blurOut;
    const sc = lerp(scaleFrom, 1, pi) * (1 + po * 0.015);
    el.style.opacity = op.toFixed(4);
    el.style.transform = `translate3d(0,${ty.toFixed(2)}px,0) scale(${sc.toFixed(4)})`;
    el.style.filter = bl > 0.02 ? `blur(${bl.toFixed(2)}px)` : 'none';
    el.style.visibility = op > 0.001 ? 'visible' : 'hidden';
  }

  // Weicher Farbverlaufs-Nebel ("Aurora") hinter Text.
  function glow(root, colors, size = 980) {
    const g = mk(root, 'glow');
    const [a, b, c, d] = colors;
    g.style.width = g.style.height = size + 'px';
    g.style.background =
      `radial-gradient(closest-side at 30% 35%, ${a}, transparent 72%),` +
      `radial-gradient(closest-side at 72% 30%, ${b}, transparent 72%),` +
      `radial-gradient(closest-side at 62% 75%, ${c}, transparent 72%),` +
      `radial-gradient(closest-side at 28% 72%, ${d || a}, transparent 72%)`;
    return g;
  }
  function animGlow(g, lt, len, outAt, base = 0.7, cx = 50, cy = 50) {
    const pin = P(lt, 0.05, 1.8, outCubic);
    const pout = P(lt, outAt, EXIT + 0.2, inOutCubic);
    const d = clamp(lt / Math.max(len, 1), 0, 1);
    g.style.opacity = (base * pin * (1 - pout)).toFixed(4);
    g.style.left = cx + '%';
    g.style.top = cy + '%';
    g.style.transform = `translate(-50%,-50%) scale(${lerp(0.75, 1.08, d).toFixed(4)}) rotate(${(d * 25).toFixed(2)}deg)`;
  }

  // ---------- Szenen-Typen ----------
  const KINDS = {};

  // Markenwort groß, optional Kicker/Sub, Aurora dahinter.
  KINDS.brand = (root, s, th, ctx) => {
    const g = s.glow === false ? null : glow(root, T.gradient);
    const safe = mk(root, 'safe center');
    const kicker = s.kicker ? mk(safe, 'kicker el', s.kicker) : null;
    const brand = mk(safe, 'brand el', s.text || T.brand);
    if (s.size) brand.style.fontSize = s.size + 'px';
    fitText(brand, 0.94);
    const sub = s.sub ? mk(safe, 'sub el', s.sub) : null;
    return lt => {
      const { len, outAt } = ctx;
      if (g) animGlow(g, lt, len, outAt, th.glow, 50, 46);
      if (kicker) show(kicker, lt, 0.2, { outStart: outAt });
      show(brand, lt, 0.35, { inDur: 1.1, y: 28, scaleFrom: 0.97, outStart: outAt + 0.05 });
      brand.style.letterSpacing = lerp(-0.015, -0.06, P(lt, 0.35, 1.5)).toFixed(4) + 'em';
      if (sub) show(sub, lt, 0.8, { outStart: outAt });
    };
  };

  // Ein Wort nach dem anderen, zentriert ("Einfach. Klar. Modern.").
  KINDS.words = (root, s, th, ctx) => {
    const safe = mk(root, 'safe center');
    const els = s.words.map(w => {
      const wrap = mk(safe, 'wordwrap');
      const el = mk(wrap, 'bigword el');
      if (s.size) el.style.fontSize = s.size + 'px';
      richWords(el, w).forEach(sp => { sp.classList.remove('el'); sp.style.opacity = 1; });
      fitText(el);
      return el;
    });
    return lt => {
      const { len, outAt, isLast } = ctx;
      const n = els.length;
      const start = 0.25;
      const end = isLast ? len : outAt + EXIT;
      const slot = (end - start) / n;
      els.forEach((el, i) => {
        const a = start + i * slot;
        const outStart = (i === n - 1 && isLast) ? Infinity : a + slot - 0.32;
        show(el, lt, a, { inDur: 0.6, y: 34, blur: 10, scaleFrom: 0.96, outStart, outDur: 0.32, yOut: -18, blurOut: 8 });
      });
    };
  };

  // Kicker + Headline (Wort für Wort) + Sub.
  KINDS.statement = (root, s, th, ctx) => {
    const safe = mk(root, 'safe ' + (s.align || 'left') + (s.pos ? ' ' + s.pos : ''));
    const kicker = s.kicker ? mk(safe, 'kicker el', s.kicker) : null;
    const h = mk(safe, 'headline');
    if (s.size) h.style.fontSize = s.size + 'px';
    const words = richWords(h, s.text);
    const sub = s.sub ? mk(safe, 'sub el', s.sub) : null;
    return lt => {
      const { outAt } = ctx;
      if (kicker) show(kicker, lt, 0.2, { outStart: outAt });
      words.forEach((w, i) => show(w, lt, 0.4 + i * 0.075, { inDur: 0.75, y: 26, blur: 8, outStart: outAt + i * 0.015, outDur: 0.4, yOut: -16 }));
      if (sub) show(sub, lt, 0.4 + words.length * 0.075 + 0.3, { outStart: outAt });
    };
  };

  // Geometrische Formen (grafisch, minimal) + Headline unten.
  const DEFAULT_SHAPES = [
    { kind: 'square', x: 120, y: 540, size: 460, fill: 'shape', rot: -10 },
    { kind: 'circle', x: 570, y: 380, size: 330, fill: 'gradient' },
    { kind: 'pill', x: 400, y: 880, w: 560, h: 190, fill: 'fg' },
  ];
  KINDS.shapes = (root, s, th, ctx) => {
    const layer = mk(root, 'shapes');
    const defs = s.shapes || DEFAULT_SHAPES;
    const els = defs.map(d => {
      const e = mk(layer, 'shape el');
      const w = d.w || d.size, h = d.h || d.size;
      e.style.left = d.x + 'px'; e.style.top = d.y + 'px';
      e.style.width = w + 'px'; e.style.height = h + 'px';
      e.style.borderRadius = d.kind === 'circle' ? '50%' : d.kind === 'pill' ? '999px' : Math.round(Math.min(w, h) * 0.26) + 'px';
      e.style.background =
        d.fill === 'gradient' ? gradientCSS(T.gradient) :
        d.fill === 'accent' ? T.accent :
        d.fill === 'fg' ? th.fg : th.shape;
      e.dataset.rot = d.rot || 0;
      return e;
    });
    const safe = mk(root, 'safe ' + (s.align || 'left') + ' ' + (s.pos || 'bottom'));
    const kicker = s.kicker ? mk(safe, 'kicker el', s.kicker) : null;
    const h = mk(safe, 'headline');
    if (s.size) h.style.fontSize = s.size + 'px';
    const words = richWords(h, s.text);
    return lt => {
      const { outAt } = ctx;
      els.forEach((e, i) => {
        const a = 0.15 + i * 0.18;
        const pi = P(lt, a, 1.1, outQuint);
        const po = P(lt, outAt + i * 0.05, EXIT, inOutCubic);
        const drift = Math.sin(lt * 0.6 + i * 1.7) * 10;
        const drift2 = Math.cos(lt * 0.5 + i * 0.9) * 8;
        const rot = +e.dataset.rot;
        const bl = (1 - pi) * 18;
        e.style.opacity = (pi * (1 - po)).toFixed(4);
        e.style.transform =
          `translate3d(${drift2.toFixed(2)}px,${((1 - pi) * 90 + drift + po * -40).toFixed(2)}px,0) ` +
          `scale(${(lerp(0.7, 1, pi) * (1 + po * 0.04)).toFixed(4)}) rotate(${(rot + (1 - pi) * -12 + drift * 0.3).toFixed(2)}deg)`;
        e.style.filter = bl > 0.02 ? `blur(${bl.toFixed(2)}px)` : 'none';
      });
      if (kicker) show(kicker, lt, 0.55, { outStart: outAt });
      words.forEach((w, i) => show(w, lt, 0.7 + i * 0.07, { inDur: 0.75, y: 24, blur: 8, outStart: outAt + i * 0.015, outDur: 0.4, yOut: -16 }));
    };
  };

  // Nummerierte Liste (Features), Zeile für Zeile.
  KINDS.list = (root, s, th, ctx) => {
    const safe = mk(root, 'safe ' + (s.align || 'left'));
    const kicker = s.kicker ? mk(safe, 'kicker el', s.kicker) : null;
    const title = s.text ? mk(safe, 'headline small el', s.text) : null;
    const list = mk(safe, 'list');
    const rows = s.items.map((it, i) => {
      const r = mk(list, 'row el');
      mk(r, 'idx', String(i + 1).padStart(2, '0'));
      mk(r, 'txt', it);
      return r;
    });
    return lt => {
      const { outAt } = ctx;
      let d = 0.2;
      if (kicker) { show(kicker, lt, d, { outStart: outAt }); d += 0.15; }
      if (title) { show(title, lt, d, { outStart: outAt }); d += 0.35; }
      rows.forEach((r, i) => show(r, lt, d + 0.2 + i * 0.38, { y: 30, blur: 8, outStart: outAt + i * 0.04, yOut: -14 }));
    };
  };

  // Große Zahl, die hochzählt.
  KINDS.stat = (root, s, th, ctx) => {
    const safe = mk(root, 'safe ' + (s.align || 'center'));
    const kicker = s.kicker ? mk(safe, 'kicker el', s.kicker) : null;
    const num = mk(safe, 'stat el');
    if (s.size) num.style.fontSize = s.size + 'px';
    const label = s.label ? mk(safe, 'sub el', s.label) : null;
    const from = s.from ?? 0, to = s.value, dec = s.decimals ?? 0;
    const fmt = v => (s.prefix || '') + v.toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + (s.suffix || '');
    num.textContent = fmt(to);
    fitText(num);
    return lt => {
      const { outAt } = ctx;
      if (kicker) show(kicker, lt, 0.2, { outStart: outAt });
      show(num, lt, 0.35, { inDur: 0.8, y: 30, scaleFrom: 0.96, outStart: outAt });
      num.textContent = fmt(lerp(from, to, P(lt, 0.35, 1.6, outQuint)));
      if (label) show(label, lt, 0.9, { outStart: outAt });
    };
  };

  // Abschluss: Marke, Button, URL.
  KINDS.cta = (root, s, th, ctx) => {
    const g = s.glow ? glow(root, T.gradient, 1100) : null;
    const safe = mk(root, 'safe center');
    const kicker = s.kicker ? mk(safe, 'kicker el', s.kicker) : null;
    const brand = mk(safe, 'brand small el', s.text || T.brand);
    fitText(brand, 0.94);
    const sub = s.sub ? mk(safe, 'sub el', s.sub) : null;
    const btn = s.button ? mk(safe, 'btn el', s.button) : null;
    if (btn) {
      if (s.buttonStyle === 'accent') { btn.style.background = T.accent; btn.style.color = '#fff'; }
      else if (s.buttonStyle === 'gradient') { btn.style.background = gradientCSS(T.gradient); btn.style.color = '#fff'; }
      else { btn.style.background = th.fg; btn.style.color = th.bg; }
    }
    const url = s.url ? mk(safe, 'url el', s.url) : null;
    return lt => {
      const { len, outAt } = ctx;
      if (g) animGlow(g, lt, len, outAt, th.glow * 0.7, 50, 48);
      if (kicker) show(kicker, lt, 0.15, { outStart: outAt });
      show(brand, lt, 0.25, { inDur: 1, y: 26, scaleFrom: 0.97, outStart: outAt });
      brand.style.letterSpacing = lerp(-0.02, -0.055, P(lt, 0.25, 1.3)).toFixed(4) + 'em';
      if (sub) show(sub, lt, 0.55, { outStart: outAt });
      if (btn) show(btn, lt, 0.8, { y: 24, scaleFrom: 0.94, outStart: outAt });
      if (url) show(url, lt, 1.05, { outStart: outAt });
    };
  };

  // ---------- Aufbau der Timeline ----------
  const stage = document.getElementById('stage');
  stage.style.width = (AD.width || 1080) + 'px';
  stage.style.height = (AD.height || 1920) + 'px';

  const scenes = [];
  let cursor = 0;
  AD.scenes.forEach((s, i) => {
    const isLast = i === AD.scenes.length - 1;
    const t0 = i === 0 ? 0 : cursor - XFADE;
    const t1 = cursor + s.dur;
    const len = t1 - t0;
    cursor = t1;
    const th = T[s.theme || 'light'];
    const el = mk(stage, 'scene');
    el.style.background = th.bg;
    el.style.color = th.fg;
    el.style.setProperty('--muted', th.muted);
    el.style.setProperty('--shape', th.shape);
    el.style.setProperty('--grad', gradientCSS(T.gradient));
    const kind = KINDS[s.kind];
    if (!kind) throw new Error('Unbekannter Szenen-Typ: ' + s.kind);
    const ctx = { len, isLast, index: i, outAt: (isLast && s.hold !== false) ? Infinity : len - EXIT_LEAD };
    const update = kind(el, s, th, ctx);
    scenes.push({ el, t0, t1, update, i });
  });
  const total = cursor;

  function seek(t) {
    t = clamp(t, 0, total);
    for (const sc of scenes) {
      const on = t >= sc.t0 && (t < sc.t1 || sc.i === scenes.length - 1);
      sc.el.style.display = on ? 'block' : 'none';
      if (!on) continue;
      const lt = t - sc.t0;
      sc.el.style.opacity = sc.i === 0 ? '1' : P(lt, 0, XFADE, inOutCubic).toFixed(4);
      sc.el.style.zIndex = String(sc.i + 1);
      sc.update(lt);
    }
  }

  // Schnittstelle für render.mjs
  window.__seek = seek;
  window.__total = total;
  window.__fps = FPS;
  window.__ad = adId;
  window.__size = { w: stage.offsetWidth, h: stage.offsetHeight };
  window.__ready = Promise.all([400, 500, 600, 700, 800].map(w => document.fonts.load(`${w} 100px Inter`)))
    .then(() => document.fonts.ready)
    .then(() => { fits.forEach(f => f()); });

  // ---------- Vorschau im Browser ----------
  if (qs.get('render') !== '1') {
    document.body.classList.add('preview');
    const fit = () => {
      const sx = (innerWidth - 48) / stage.offsetWidth, sy = (innerHeight - 48) / stage.offsetHeight;
      stage.style.transform = `scale(${Math.min(sx, sy, 1)})`;
    };
    fit();
    addEventListener('resize', fit);

    const ui = mk(document.body, 'ui');
    ids.forEach(id => {
      const a = document.createElement('a');
      a.href = '?ad=' + id;
      a.textContent = ADS[id].title || id;
      if (id === adId) a.className = 'on';
      ui.appendChild(a);
    });
    mk(ui, 'hint', `${total.toFixed(1)} s · Leertaste/Klick: Pause · ←/→: Frame · Pos1: Anfang`);

    const bar = mk(stage, 'bar');
    const fill = mk(bar, 'fill');
    let t = 0, playing = true, last = performance.now();
    const loop = now => {
      const dt = (now - last) / 1000;
      last = now;
      if (playing) { t += dt; if (t >= total) t = 0; }
      seek(t);
      fill.style.width = (t / total * 100) + '%';
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    const toggle = () => { playing = !playing; };
    stage.addEventListener('click', toggle);
    addEventListener('keydown', e => {
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.code === 'ArrowRight') { playing = false; t = Math.min(total, t + 1 / FPS); }
      else if (e.code === 'ArrowLeft') { playing = false; t = Math.max(0, t - 1 / FPS); }
      else if (e.code === 'Home') { t = 0; }
    });
  } else {
    seek(0);
  }
})();
