// Review Answers: one learner's questions, their answers and the correct answers.
// Learners see it in a protected pop-up (no copying, printing or right-click, blurs when they
// switch away, faint name watermark). Trainers and Admin download it as a PDF.
import { esc, icons, LIBS, loadScript, safeName } from "./ui.js";
import { normWord } from "./crossword.js";

const blank = (v) => v == null || v === "" || (Array.isArray(v) && !v.length);

// Turns the raw data into one item per question, in the order the learner had them
// questions: [{ id, section_id, qtype, question, options, match_choices, layout, points }]
// keys: { questionId: correct }, answers / results: from the attempt
export function reviewItems({ questions, sections = [], answers = {}, results = {}, keys = {} }) {
  const title = Object.fromEntries(sections.map((s) => [s.id, s.title ?? ""]));
  return questions.map((q, i) => {
    const key = keys[q.id] ?? [];
    const a = answers?.[q.id];
    const points = Number(q.points ?? 0);
    const earned = Number(results?.[q.id] ?? 0);
    const item = { n: i + 1, id: q.id, qtype: q.qtype, question: q.question, section: title[q.section_id] ?? "", section_id: q.section_id ?? null,
      points, earned, right: points > 0 ? earned >= points : earned > 0 };
    if (["single", "multi", "truefalse"].includes(q.qtype)) {
      const opts = q.qtype === "truefalse" && !(q.options ?? []).length ? ["True", "False"] : q.options ?? [];
      const picked = new Set(blank(a) ? [] : Array.isArray(a) ? a.map(Number) : [Number(a)]);
      item.choices = opts.map((text, oi) => ({ text, picked: picked.has(oi), correct: key.map(Number).includes(oi) }));
    } else if (q.qtype === "short") {
      item.answer = blank(a) ? "" : String(a);
      item.accepted = key;
    } else if (q.qtype === "matching") {
      item.rows = (q.options ?? []).map((term, ti) => {
        const pick = Array.isArray(a) ? a[ti] : null;
        return { term, answer: pick == null ? "" : q.match_choices?.[pick] ?? "", correct: q.match_choices?.[key[ti]] ?? "", right: pick != null && Number(pick) === Number(key[ti]) };
      });
    } else if (q.qtype === "crossword") {
      const words = q.layout?.words ?? [];
      item.rows = (q.options ?? []).map((clue, wi) => {
        const w = words.find((x) => x.i === wi);
        const typed = Array.isArray(a) ? String(a[wi] ?? "").toUpperCase().replace(/[^A-Z ]/g, "").trim() : "";
        return { label: w ? `${w.n} ${w.d === "a" ? "Across" : "Down"}` : "", clue, answer: typed, correct: key[wi] ?? "", right: normWord(typed) === key[wi] };
      }).sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }));
    }
    return item;
  });
}

const mark = (ok) => (ok ? `<i class="rv-ic ok">${icons.check}</i>` : '<i class="rv-ic bad">✕</i>');

function itemHtml(it) {
  const tag = { single: "Single Choice", multi: "Multiple Choice", truefalse: "True/False", short: "Short Answer", matching: "Matching", crossword: "Crossword" }[it.qtype] ?? "";
  let body = "";
  if (it.qtype === "truefalse") {
    const picked = it.choices.find((c) => c.picked);
    const right = it.choices.find((c) => c.correct);
    body = `<div class="rv-line ${picked?.correct ? "ok" : "bad"}">${mark(!!picked?.correct)} ${esc(picked?.text ?? "No answer")}</div>
      ${picked?.correct ? "" : `<div class="rv-fix">Correct answer: ${esc(right?.text ?? "")}</div>`}`;
  } else if (it.choices) {
    const multi = it.qtype === "multi";
    body = it.choices.map((c) => {
      const cls = c.picked ? (c.correct ? "right" : "wrong") : c.correct ? "miss" : "";
      const note = c.picked ? "Your answer" : c.correct ? "Correct answer" : "";
      const box = multi ? (c.picked ? (c.correct ? "☑" : "☒") : "☐") : (c.picked || c.correct ? "◉" : "○");
      return `<div class="rv-opt ${cls}"><span class="rv-box">${box}</span><span>${esc(c.text)}</span>${note ? `<em>${note}</em>` : ""}</div>`;
    }).join("");
  } else if (it.qtype === "short") {
    body = `<div class="rv-line ${it.right ? "ok" : "bad"}">${mark(it.right)} ${esc(it.answer || "No answer")}</div>
      ${it.right ? "" : `<div class="rv-fix">Correct answer: ${esc((it.accepted ?? []).join(" or "))}</div>`}`;
  } else if (it.rows) {
    body = `<div class="rv-rows">${it.rows.map((r) => `
      <div class="rv-row">
        <div class="rv-term">${it.qtype === "crossword" ? `<b>${esc(r.label)}</b> ${esc(r.clue)}` : esc(r.term)}</div>
        <div><div class="rv-line ${r.right ? "ok" : "bad"}">${mark(r.right)} ${esc(r.answer || "No answer")}</div>
          ${r.right ? "" : `<div class="rv-fix">Correct answer: ${esc(r.correct)}</div>`}</div>
      </div>`).join("")}</div>`;
  }
  return `<div class="rv-q"><p class="rv-title"><span>${it.n}.</span> ${esc(it.question)} <small>${tag}</small></p>${body}</div>`;
}

// The whole review as a document: topic headings, then every question
export function reviewDocHtml(items) {
  let html = "";
  let current;
  items.forEach((it, idx) => {
    if (it.section_id !== current) {
      current = it.section_id;
      const group = items.filter((x) => x.section_id === current);
      if (it.section) html += `<h3 class="rv-topic">${esc(it.section)} <span>${group.filter((x) => x.right).length} of ${group.length} correct</span></h3>`;
      else if (idx > 0) html += '<hr class="rv-sep">';
    }
    html += itemHtml(it);
  });
  return html;
}

// ---------------------------------------------------------------------
// Learner: the protected pop-up
// ---------------------------------------------------------------------
const xml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

export function openReview({ title, attempt, items, name, email }) {
  const wrap = document.createElement("div");
  wrap.className = "rv-backdrop";
  const score = attempt?.max_score != null ? `Score ${Number(attempt.score)} of ${Number(attempt.max_score)}${attempt.passed ? " · Passed" : ""}` : "";
  wrap.innerHTML = `
    <div class="rv-modal" role="dialog" aria-modal="true" aria-label="Review Answers">
      <div class="rv-head">
        <strong>Review Answers: ${esc(title)}</strong>
        <span class="rv-lock">${icons.lock} Protected view</span>
        <span class="rv-score">${esc(score)}</span>
        <button type="button" class="btn sm ghost icon" data-close aria-label="Close">✕</button>
      </div>
      <div class="rv-body">
        <button type="button" class="rv-more" data-about>+ About This View</button>
        <div class="rv-note" hidden>This is a protected view: copying, printing and right-click are turned off. Need a copy? Ask your trainer.</div>
        <div class="rv-doc">${reviewDocHtml(items)}</div>
      </div>
    </div>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='200'><text x='16' y='120' transform='rotate(-20 210 100)' font-family='Arial, sans-serif' font-size='14' fill='rgba(20,45,80,0.10)'>${xml(`${name ?? ""}${email ? ` · ${email}` : ""}`)}</text></svg>`;
  wrap.querySelector(".rv-body").style.backgroundImage = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  document.body.append(wrap);

  const about = wrap.querySelector("[data-about]");
  about.addEventListener("click", () => {
    const note = wrap.querySelector(".rv-note");
    note.hidden = !note.hidden;
    about.textContent = `${note.hidden ? "+" : "−"} About This View`;
  });

  // Protections while it's open
  const modal = wrap.querySelector(".rv-modal");
  const shade = document.createElement("div");
  shade.className = "secure-black";
  shade.hidden = true;
  document.body.append(shade);
  document.body.classList.add("secure-test-on", "review-open");
  let blackTimer;
  const black = (ms = 2500) => { shade.hidden = false; clearTimeout(blackTimer); blackTimer = setTimeout(() => { shade.hidden = true; }, ms); };
  const veil = (on) => modal.classList.toggle("veiled", on);
  const stop = (e) => e.preventDefault();
  const onKey = (e) => {
    const k = (e.key ?? "").toLowerCase();
    if (k === "escape" && e.type === "keydown") return close();
    if (k === "printscreen") { e.preventDefault(); black(); try { navigator.clipboard?.writeText?.(" ").catch?.(() => {}); } catch { /* not allowed */ } return; }
    if (e.type !== "keydown") return;
    if (e.metaKey && e.shiftKey) { black(1500); return; }
    if ((e.ctrlKey || e.metaKey) && ["c", "x", "a", "p", "s", "u"].includes(k)) e.preventDefault();
  };
  const onBlur = () => veil(true);
  const onFocus = () => veil(false);
  const onVis = () => veil(document.visibilityState !== "visible");
  const onPrint = () => black(4000);
  const listeners = [
    [document, "keydown", onKey, true], [document, "keyup", onKey, true], [document, "copy", stop, true], [document, "cut", stop, true],
    [document, "contextmenu", stop, true], [document, "selectstart", stop, true], [document, "dragstart", stop, true],
    [window, "blur", onBlur], [window, "focus", onFocus], [document, "visibilitychange", onVis], [window, "beforeprint", onPrint],
  ];
  listeners.forEach(([t, ev, fn, cap]) => t.addEventListener(ev, fn, cap));

  function close() {
    listeners.forEach(([t, ev, fn, cap]) => t.removeEventListener(ev, fn, cap));
    clearTimeout(blackTimer);
    shade.remove();
    wrap.remove();
    document.body.classList.remove("secure-test-on", "review-open");
    window.removeEventListener("hashchange", close);
  }
  wrap.querySelector("[data-close]").addEventListener("click", close);
  wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(); });
  window.addEventListener("hashchange", close);
  return close;
}

// ---------------------------------------------------------------------
// Trainer / Admin: PDF of one learner's answers
// ---------------------------------------------------------------------
export async function loadPdfLib() {
  await loadScript(LIBS.jspdf);
  return window.jspdf.jsPDF;
}

const GREEN = [47, 110, 49], RED = [163, 48, 43], INK = [22, 50, 74], GREY = [91, 111, 130];

export function reviewPdf(JsPDF, { programTitle, stepTitle, learner, email, attempt, items, platform }) {
  const doc = new JsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 48;
  let y = M;
  const room = (h) => { if (y + h > H - M) { doc.addPage(); y = M; } };
  const text = (s, { size = 10, color = INK, bold = false, x = M, gap = 4, width = W - M - x } = {}) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(String(s ?? ""), width);
    for (const line of lines) { room(size + 2); doc.text(line, x, y + size); y += size + 2; }
    y += gap;
  };
  text(stepTitle, { size: 16, bold: true, gap: 2 });
  text(`${programTitle}${platform ? ` · ${platform}` : ""}`, { color: GREY, gap: 10 });
  text(`${learner}${email ? ` · ${email}` : ""}`, { bold: true, gap: 2 });
  const when = attempt?.submitted_at ? new Date(attempt.submitted_at).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  text(`Score ${Number(attempt?.score ?? 0)} of ${Number(attempt?.max_score ?? 0)} (${Number(attempt?.percent ?? 0)}%)${attempt?.passed ? " · Passed" : ""}${when ? ` · Submitted ${when}` : ""}`, { color: GREY, gap: 14 });

  let current;
  for (const it of items) {
    if (it.section_id !== current) {
      current = it.section_id;
      if (it.section) {
        const group = items.filter((x) => x.section_id === current);
        room(30);
        y += 4;
        text(`${it.section} (${group.filter((x) => x.right).length} of ${group.length} correct)`, { size: 12, bold: true, gap: 6 });
      }
    }
    room(40);
    text(`${it.n}. ${it.question}`, { bold: true, gap: 3 });
    const x = M + 14;
    if (it.choices) {
      it.choices.forEach((c, oi) => {
        const label = c.picked ? " (Your answer)" : c.correct ? " (Correct answer)" : "";
        text(`${String.fromCharCode(65 + oi)}. ${c.text}${label}`, { x, color: c.picked ? (c.correct ? GREEN : RED) : c.correct ? GREEN : INK, bold: c.picked || c.correct, gap: 1 });
      });
    } else if (it.qtype === "short") {
      text(`Your answer: ${it.answer || "No answer"}`, { x, color: it.right ? GREEN : RED, gap: 1 });
      if (!it.right) text(`Correct answer: ${(it.accepted ?? []).join(" or ")}`, { x, color: GREEN, gap: 1 });
    } else if (it.rows) {
      for (const r of it.rows) {
        text(it.qtype === "crossword" ? `${r.label}: ${r.clue}` : r.term, { x, bold: true, gap: 1 });
        text(`Your answer: ${r.answer || "No answer"}`, { x: x + 12, color: r.right ? GREEN : RED, gap: 1 });
        if (!r.right) text(`Correct answer: ${r.correct}`, { x: x + 12, color: GREEN, gap: 1 });
      }
    }
    y += 8;
  }
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...GREY);
    doc.text(`${learner} · ${stepTitle} · Page ${p} of ${pages}`, M, H - 24);
  }
  return doc;
}

export const reviewFileName = (learner, stepTitle) => `${safeName(learner)} - ${safeName(stepTitle)} - Answers.pdf`;
