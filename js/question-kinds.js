// Matching and Crossword questions on the learner's test page.
// Matching: terms (options) matched to definitions (match_choices). Shown as dropdowns, or as
// "draw lines" on wider screens. Answer: the definition number picked for each term (or null).
// Crossword: the clues (options) and a grid (layout). Answer: the word typed for each clue.
import { esc } from "./ui.js";
import { gridCells } from "./crossword.js";

const LINES_MIN_WIDTH = 700;   // narrower screens (phones) get dropdowns instead of lines

// ---------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------
export function matchingBody(q, order) {
  const terms = order?.terms ?? q.options.map((_, i) => i);
  const choices = order?.choices ?? (q.match_choices ?? []).map((_, i) => i);
  const name = (ti) => `q-${q.id}-${ti}`;
  if (q.layout?.display === "lines" && window.innerWidth >= LINES_MIN_WIDTH) {
    return `
      <p class="muted small" style="margin:0">Click a term, then its definition. Click a term again to undo.</p>
      <div class="match-lines" data-match="${q.id}">
        <svg class="match-svg" aria-hidden="true"></svg>
        <div class="match-col">${terms.map((ti) => `
          <button type="button" class="match-item" data-t="${ti}">${esc(q.options[ti])}</button>
          <input type="hidden" name="${name(ti)}" value="">`).join("")}</div>
        <div class="match-col">${choices.map((ci) => `<button type="button" class="match-item" data-c="${ci}">${esc(q.match_choices[ci])}</button>`).join("")}</div>
      </div>`;
  }
  return `<div class="match-drop">${terms.map((ti) => `
    <label class="match-row"><span>${esc(q.options[ti])}</span>
      <select class="select" name="${name(ti)}">
        <option value="">Choose…</option>
        ${choices.map((ci) => `<option value="${ci}">${esc(q.match_choices[ci])}</option>`).join("")}
      </select></label>`).join("")}</div>`;
}

// Lines: click a term, then a definition; one definition per term
export function wireMatching(root) {
  root.querySelectorAll("[data-match]").forEach((box) => {
    let picking = null;
    const svg = box.querySelector("svg");
    const input = (ti) => box.querySelector(`input[name$="-${ti}"]`);
    const draw = () => {
      const base = box.getBoundingClientRect();
      svg.setAttribute("width", base.width);
      svg.setAttribute("height", base.height);
      let lines = "";
      box.querySelectorAll("[data-t]").forEach((t) => {
        const ci = input(t.dataset.t).value;
        t.classList.toggle("paired", ci !== "");
        t.classList.toggle("picking", picking === t.dataset.t);
        if (ci === "") return;
        const c = box.querySelector(`[data-c="${ci}"]`);
        const a = t.getBoundingClientRect(), b = c.getBoundingClientRect();
        lines += `<line x1="${a.right - base.left}" y1="${a.top + a.height / 2 - base.top}" x2="${b.left - base.left}" y2="${b.top + b.height / 2 - base.top}"/>`;
      });
      const used = new Set([...box.querySelectorAll('input[type="hidden"]')].map((i) => i.value).filter((v) => v !== ""));
      box.querySelectorAll("[data-c]").forEach((c) => c.classList.toggle("paired", used.has(c.dataset.c)));
      svg.innerHTML = lines;
    };
    box.addEventListener("click", (e) => {
      const t = e.target.closest("[data-t]");
      const c = e.target.closest("[data-c]");
      if (t) {
        const inp = input(t.dataset.t);
        if (inp.value !== "") { inp.value = ""; picking = null; }
        else picking = picking === t.dataset.t ? null : t.dataset.t;
      } else if (c && picking != null) {
        box.querySelectorAll('input[type="hidden"]').forEach((i) => { if (i.value === c.dataset.c) i.value = ""; });
        input(picking).value = c.dataset.c;
        picking = null;
      } else return;
      draw();
      box.dispatchEvent(new Event("change", { bubbles: true }));
    });
    box.addEventListener("refresh", draw);
    new ResizeObserver(draw).observe(box);
    draw();
  });
}

export function readMatching(form, q) {
  const vals = q.options.map((_, ti) => {
    const v = form.querySelector(`[name="q-${q.id}-${ti}"]`)?.value ?? "";
    return v === "" ? null : Number(v);
  });
  return vals.some((v) => v != null) ? vals : null;
}

export function fillMatching(form, q, saved) {
  (saved ?? []).forEach((v, ti) => {
    const el = form.querySelector(`[name="q-${q.id}-${ti}"]`);
    if (el && v != null) el.value = String(v);
  });
  form.querySelector(`[data-match="${q.id}"]`)?.dispatchEvent(new Event("refresh"));
}

// ---------------------------------------------------------------------
// Crossword
// ---------------------------------------------------------------------
export function crosswordBody(q) {
  const L = q.layout ?? { rows: 0, cols: 0, words: [] };
  const cells = gridCells(L);
  let grid = "";
  for (let r = 0; r < L.rows; r++) {
    for (let c = 0; c < L.cols; c++) {
      const cell = cells.get(`${r},${c}`);
      grid += cell
        ? `<label class="cw-cell">${cell.n ? `<i>${cell.n}</i>` : ""}<input maxlength="1" data-r="${r}" data-c="${c}" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Row ${r + 1}, column ${c + 1}"></label>`
        : '<span class="cw-empty"></span>';
    }
  }
  const clues = (d) => L.words.filter((w) => w.d === d).sort((a, b) => a.n - b.n)
    .map((w) => `<li><b>${w.n}</b> ${esc(q.options[w.i] ?? "")} <span class="muted">(${w.len})</span></li>`).join("");
  return `
    <div class="cw" data-cw="${q.id}" style="--cw-cols:${L.cols}">
      <div class="cw-grid" style="grid-template-columns:repeat(${L.cols}, var(--cw-size))">${grid}</div>
      <div class="cw-clues">
        ${L.words.some((w) => w.d === "a") ? `<div><h4>Across</h4><ol>${clues("a")}</ol></div>` : ""}
        ${L.words.some((w) => w.d === "d") ? `<div><h4>Down</h4><ol>${clues("d")}</ol></div>` : ""}
      </div>
    </div>`;
}

// Typing moves to the next square of the word; Backspace moves back; arrow keys move around
export function wireCrossword(root, questions) {
  root.querySelectorAll("[data-cw]").forEach((box) => {
    const q = questions.find((x) => x.id === box.dataset.cw);
    let dir = "a";
    const cell = (r, c) => box.querySelector(`input[data-r="${r}"][data-c="${c}"]`);
    const step = (el, by, d = dir) => {
      const r = Number(el.dataset.r) + (d === "d" ? by : 0), c = Number(el.dataset.c) + (d === "a" ? by : 0);
      return cell(r, c);
    };
    box.addEventListener("focusin", (e) => {
      const el = e.target.closest("input");
      if (!el) return;
      // Pick the direction this square belongs to (across first, unless it's only part of a down word)
      if (!step(el, 1, dir) && !step(el, -1, dir)) dir = dir === "a" ? "d" : "a";
      el.select();
    });
    box.addEventListener("input", (e) => {
      const el = e.target;
      el.value = el.value.replace(/[^a-z]/gi, "").slice(-1).toUpperCase();
      if (el.value) step(el, 1)?.focus();
    });
    box.addEventListener("keydown", (e) => {
      const el = e.target.closest("input");
      if (!el) return;
      const moves = { ArrowRight: ["a", 1], ArrowLeft: ["a", -1], ArrowDown: ["d", 1], ArrowUp: ["d", -1] };
      if (moves[e.key]) {
        e.preventDefault();
        const [d, by] = moves[e.key];
        dir = d;
        step(el, by, d)?.focus();
      } else if (e.key === "Backspace" && !el.value) {
        e.preventDefault();
        const prev = step(el, -1);
        if (prev) { prev.value = ""; prev.focus(); prev.dispatchEvent(new Event("input", { bubbles: true })); }
      }
    });
    box.dataset.ready = q ? "1" : "";
  });
}

export function readCrossword(form, q) {
  const box = form.querySelector(`[data-cw="${q.id}"]`);
  if (!box) return null;
  const words = q.options.map(() => "");
  let any = false;
  for (const w of q.layout?.words ?? []) {
    let s = "";
    for (let k = 0; k < w.len; k++) {
      const r = w.d === "d" ? w.r + k : w.r, c = w.d === "a" ? w.c + k : w.c;
      const v = box.querySelector(`input[data-r="${r}"][data-c="${c}"]`)?.value ?? "";
      s += v || " ";
      if (v) any = true;
    }
    words[w.i] = s.trimEnd();
  }
  return any ? words : null;
}

export function fillCrossword(form, q, saved) {
  const box = form.querySelector(`[data-cw="${q.id}"]`);
  if (!box || !Array.isArray(saved)) return;
  for (const w of q.layout?.words ?? []) {
    const s = String(saved[w.i] ?? "");
    for (let k = 0; k < w.len; k++) {
      const r = w.d === "d" ? w.r + k : w.r, c = w.d === "a" ? w.c + k : w.c;
      const el = box.querySelector(`input[data-r="${r}"][data-c="${c}"]`);
      if (el && s[k] && s[k] !== " ") el.value = s[k];
    }
  }
}
