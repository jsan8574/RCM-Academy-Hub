// Assessment and survey builder (like an MS Forms quiz):
// sections, question types, choices, correct answers, points, required,
// timer, open/close dates, attempts, shuffling, and Excel template import.
//   #/programs/<program>/form/<step>
import { sb } from "../supabase.js";
import { brand,
  esc, toast, openModal, icons, toLocalInput, fromLocalInput, QTYPE, LIKERT, LIBS, loadScript,
} from "../ui.js";
import { buildCrossword, gridCells, normWord } from "../crossword.js";

const uid = () => crypto.randomUUID();
const MAX_CHOICES = 10;
const MAX_PAIRS = 15;
const PAIRED = ["matching", "crossword"];
const blankPairs = (n = 3) => Array.from({ length: n }, () => ({ term: "", def: "" }));

// Suggested questions per section for a Total Items number: in proportion to each section's
// questions, at least 1 each when there's room, never more than a section has
export function suggestSplit(sizes, total) {
  const pool = sizes.reduce((a, b) => a + b, 0);
  if (!total || total >= pool) return sizes.slice();
  const out = sizes.map(() => 0);
  const withQs = sizes.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
  let left = total;
  if (total >= withQs.length) { withQs.forEach((i) => { out[i] = 1; }); left -= withQs.length; }
  const rest = sizes.map((n, i) => n - out[i]);
  const restPool = rest.reduce((a, b) => a + b, 0);
  const exact = rest.map((n) => (restPool ? (n * left) / restPool : 0));
  exact.forEach((x, i) => { out[i] += Math.floor(x); });
  let short = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (short <= 0) break; if (out[i] < sizes[i]) { out[i] += 1; short -= 1; } }
  for (let i = 0; short > 0 && i < sizes.length; i++) { while (short > 0 && out[i] < sizes[i]) { out[i] += 1; short -= 1; } }
  return out;
}

export async function renderFormBuilder(main, program, stepId) {
  main.innerHTML = '<div class="empty" style="margin-top:24px"><div>Loading…</div></div>';
  const [{ data: step }, { data: sections }, { data: questions }] = await Promise.all([
    sb.from("program_steps").select("*").eq("id", stepId).maybeSingle(),
    sb.from("form_sections").select("*").eq("step_id", stepId).order("position"),
    sb.from("assessment_questions").select("*, assessment_answer_keys(correct, correct_option)").eq("step_id", stepId).order("position"),
  ]);
  if (!step || !["assessment", "survey"].includes(step.step_type)) {
    location.hash = `#/programs/${program.id}/journey`;
    return;
  }
  const kind = step.step_type; // "assessment" | "survey"
  const isQuiz = kind === "assessment";
  const back = `#/programs/${program.id}/journey`;

  // ---------------- State ----------------
  const keyOf = (q) => {
    const k = Array.isArray(q.assessment_answer_keys) ? q.assessment_answer_keys[0] : q.assessment_answer_keys;
    if (!k) return [];
    if (Array.isArray(k.correct)) return k.correct;
    return k.correct_option != null ? [k.correct_option] : [];
  };
  const toQ = (q) => {
    const key = keyOf(q);
    if (q.qtype === "matching") {
      const defs = q.match_choices ?? [];
      return { id: q.id, qtype: "matching", question: q.question ?? "", description: q.description ?? "", options: [], correct: [], accepted: "",
        pairs: (q.options ?? []).map((term, i) => ({ term, def: defs[key[i]] ?? "" })), display: q.layout?.display ?? "dropdown",
        points: Number(q.points ?? 1), required: q.required ?? true };
    }
    if (q.qtype === "crossword") {
      return { id: q.id, qtype: "crossword", question: q.question ?? "", description: q.description ?? "", options: [], correct: [], accepted: "",
        pairs: (q.options ?? []).map((def, i) => ({ term: key[i] ?? "", def })), display: "dropdown",
        points: Number(q.points ?? 1), required: q.required ?? true };
    }
    return {
      id: q.id, qtype: q.qtype ?? "single", question: q.question ?? "", description: q.description ?? "",
      options: q.qtype === "truefalse" ? ["True", "False"] : [...(q.options ?? [])],
      correct: q.qtype === "short" ? [] : key.map(Number),
      accepted: q.qtype === "short" ? key.join("; ") : "",
      points: Number(q.points ?? 1), required: q.required ?? true, pairs: blankPairs(), display: "dropdown",
    };
  };
  const state = {
    settings: {
      description: step.description ?? "",
      unlock_at: toLocalInput(step.unlock_at), close_at: toLocalInput(step.close_at),
      time_limit_minutes: step.time_limit_minutes ?? "", max_attempts: step.max_attempts ?? "",
      passing_score: step.passing_score ?? "", shuffle_questions: step.shuffle_questions, shuffle_options: step.shuffle_options,
      answers_release: step.answers_release ?? (step.show_answers ? "after_submit" : "manual"),
      total_items: step.total_items ?? "", identity_mode: step.identity_mode ?? "choose", thank_you: step.thank_you ?? "",
      secure_mode: step.secure_mode ?? true,
    },
    sections: (sections ?? []).map((s) => ({ id: s.id, title: s.title ?? "", description: s.description ?? "", ask: s.ask_count ?? null, questions: [] })),
  };
  const loose = [];
  for (const q of questions ?? []) {
    const sec = state.sections.find((s) => s.id === q.section_id);
    (sec ? sec.questions : loose).push(toQ(q));
  }
  if (loose.length || !state.sections.length) state.sections.unshift({ id: null, title: "", description: "", ask: null, questions: loose });
  const savedIds = { sections: new Set((sections ?? []).map((s) => s.id)), questions: new Set((questions ?? []).map((q) => q.id)) };
  let dirty = false;

  const newQuestion = (qtype = isQuiz ? "single" : "rating") => ({
    id: null, qtype, question: qtype === "matching" ? "Match each term to its definition." : qtype === "crossword" ? "Complete the crossword." : "",
    description: "", options: QTYPE[qtype].choices ? ["", ""] : qtype === "truefalse" ? ["True", "False"] : [],
    correct: [], accepted: "", points: PAIRED.includes(qtype) ? 3 : 1, required: true, pairs: blankPairs(), display: "dropdown",
  });

  // ---------------- Page ----------------
  main.innerHTML = `
    <header class="topbar">
      <div>
        <a class="back-link" href="${back}">${icons.back} ${esc(program.title)}</a>
        <h1>${isQuiz ? "Build Assessment" : "Build Survey"}: ${esc(step.title)}</h1>
        <p>${isQuiz ? "Add sections and questions, mark the correct answers and set the points." : `Add sections and questions. Learners answer inside ${brand.platform}.`}</p>
      </div>
      <div class="top-actions">
        <button class="btn sm subtle" data-template>${icons.download} Download Template</button>
        <label class="btn sm subtle">${icons.upload} Import From Template<input type="file" accept=".xlsx,.xls,.csv" data-import hidden></label>
        <a class="btn sm subtle" href="#/preview/new/${program.id}/${kind}/${step.id}">${icons.eye} Preview</a>
        <button class="btn primary" data-save>Save</button>
      </div>
    </header>
    <div id="fb"></div>
    <div class="save-bar" data-savebar hidden>
      <span>You have unsaved changes.</span>
      <button class="btn primary" data-save>Save Changes</button>
    </div>`;
  const box = main.querySelector("#fb");
  const saveBar = main.querySelector("[data-savebar]");
  const markDirty = () => { dirty = true; saveBar.hidden = false; };

  const settingsHtml = () => {
    const s = state.settings;
    return `
      <section class="card fb-settings">
        <div class="card-head"><h2>Settings</h2></div>
        <div class="form-grid">
          <label class="field span-2">Instructions For Learners
            <textarea class="input prose short" data-set="description" placeholder="${isQuiz ? "e.g. Answer all questions. You have 20 minutes." : "e.g. Tell us how this program went for you."}">${esc(s.description)}</textarea></label>
          <label class="field">Opens <input class="input" type="datetime-local" data-set="unlock_at" value="${esc(s.unlock_at)}">
            <span class="hint">Leave empty to open as soon as the program is live.</span></label>
          <label class="field">Closes <input class="input" type="datetime-local" data-set="close_at" value="${esc(s.close_at)}">
            <span class="hint">Leave empty to keep it open.</span></label>
          ${isQuiz ? `
            <label class="field">Time Limit (Minutes) <input class="input" type="number" min="1" max="600" data-set="time_limit_minutes" value="${esc(s.time_limit_minutes)}" placeholder="No limit">
              <span class="hint">The timer starts when the learner clicks Start. Answers are submitted automatically when time runs out.</span></label>
            <label class="field">Attempts Allowed
              <select class="select" data-set="max_attempts">
                ${[["", "Unlimited"], [1, "1"], [2, "2"], [3, "3"], [5, "5"]].map(([v, l]) => `<option value="${v}" ${String(s.max_attempts) === String(v) ? "selected" : ""}>${l}</option>`).join("")}
              </select>
              <span class="hint">Learners stop once they pass.</span></label>
            <label class="field">Pass Mark (%) <input class="input" type="number" min="0" max="100" data-set="passing_score" value="${esc(s.passing_score)}" placeholder="No pass mark"></label>
            <div class="field span-2 toggles">
              <label class="check"><input type="checkbox" data-set="shuffle_questions" ${s.shuffle_questions ? "checked" : ""}> Shuffle Questions <span class="hint">(within each section)</span></label>
              <label class="check"><input type="checkbox" data-set="shuffle_options" ${s.shuffle_options ? "checked" : ""}> Shuffle Answer Choices</label>
              <label class="check"><input type="checkbox" data-set="secure_mode" ${s.secure_mode ? "checked" : ""}> Secure Test Mode
                <span class="hint">(full screen, no copying, blurs when learners leave, submits automatically after 3 exits, and records every exit in Results)</span></label>
            </div>
            <details class="field span-2 fb-more" ${s.total_items !== "" || s.answers_release === "after_submit" ? "open" : ""}>
              <summary>Question Pool &amp; Answers</summary>
              <div class="fb-pool">
                <label class="field">Total Items
                  <input class="input" type="number" min="1" max="500" data-set="total_items" value="${esc(s.total_items)}" placeholder="All questions" style="max-width:160px">
                </label>
                <div data-poolnote></div>
                <div class="field">Release Correct Answers
                  <label class="check"><input type="radio" name="answers_release" data-set="answers_release" value="manual" ${s.answers_release !== "after_submit" ? "checked" : ""}> When I Release Them</label>
                  <label class="check"><input type="radio" name="answers_release" data-set="answers_release" value="after_submit" ${s.answers_release === "after_submit" ? "checked" : ""}> Right After Submitting</label>
                </div>
                <details class="fb-help"><summary>How this works</summary>
                  <p>Total Items: each learner gets this many questions, picked at random from each section, so learners get different questions. Leave empty to give everyone every question.</p>
                  <p>Learners only see the correct answers in a protected Review Answers window, and never while they still have attempts left. Release them from Results.</p>
                </details>
              </div>
            </details>` : `
            <label class="field">Learner Names
              <select class="select" data-set="identity_mode">
                <option value="choose" ${s.identity_mode === "choose" ? "selected" : ""}>Learner Chooses</option>
                <option value="anonymous" ${s.identity_mode === "anonymous" ? "selected" : ""}>Always Anonymous</option>
                <option value="named" ${s.identity_mode === "named" ? "selected" : ""}>Always Show Name</option>
              </select>
              <span class="hint">“Learner Chooses” lets each learner decide whether to share their name.</span></label>
            <label class="field">Thank-You Message <input class="input" data-set="thank_you" value="${esc(s.thank_you)}" placeholder="Thank you for your feedback!"></label>`}
        </div>
      </section>`;
  };

  const crosswordPreview = (q) => {
    const words = q.pairs.map((p) => p.term);
    const L = buildCrossword(words);
    if (!L.words.length) return "";
    const cells = gridCells(L, words);
    let html = "";
    for (let r = 0; r < L.rows; r++) for (let c = 0; c < L.cols; c++) {
      const cell = cells.get(`${r},${c}`);
      html += cell ? `<span class="cw-mini on">${cell.n ? `<i>${cell.n}</i>` : ""}${esc(cell.letter)}</span>` : '<span class="cw-mini"></span>';
    }
    return `<div class="cw-mini-grid" style="grid-template-columns:repeat(${L.cols}, 18px)">${html}</div>`;
  };

  const pairsEditor = (q) => {
    const cross = q.qtype === "crossword";
    return `<div class="fb-pairs">
      <div class="fb-pair head"><span>${cross ? "Answer (Word)" : "Term"}</span><span>${cross ? "Clue (Definition)" : "Definition"}</span><span></span></div>
      ${q.pairs.map((p, pi) => `
        <div class="fb-pair">
          <input class="input" data-pair="${pi}" data-pf="term" value="${esc(p.term)}" placeholder="${cross ? "e.g. Copay" : "e.g. Copay"}">
          <input class="input" data-pair="${pi}" data-pf="def" value="${esc(p.def)}" placeholder="${cross ? "e.g. A fixed amount paid at each visit" : "e.g. A fixed amount paid at each visit"}">
          <button type="button" class="btn sm ghost icon" data-act="del-pair" data-p="${pi}" ${q.pairs.length <= 2 ? "disabled" : ""} aria-label="Remove row">×</button>
        </div>`).join("")}
      <div class="fb-pair-foot">
        ${q.pairs.length < MAX_PAIRS ? '<button type="button" class="link-btn dark" data-act="add-pair">+ Add Row</button>' : ""}
        ${cross ? "" : `<label class="field fb-inline">Show As
          <select class="select" data-qf="display">
            <option value="dropdown" ${q.display !== "lines" ? "selected" : ""}>Dropdowns</option>
            <option value="lines" ${q.display === "lines" ? "selected" : ""}>Draw Lines</option>
          </select></label>`}
      </div>
      <span class="hint">${cross ? "Spaces and dashes in answers are removed in the grid. Learners get part of the points for each word they get right." : "Learners get part of the points for each correct match. Phones always show dropdowns."}</span>
      ${cross ? `<div data-cwprev>${crosswordPreview(q)}</div>` : ""}
    </div>`;
  };

  const choiceEditor = (q, si, qi) => {
    if (PAIRED.includes(q.qtype)) return pairsEditor(q);
    if (q.qtype === "truefalse") {
      return `<div class="fb-options">${["True", "False"].map((o, oi) => `
        <label class="fb-option"><input type="radio" name="c-${si}-${qi}" data-correct="${oi}" ${q.correct[0] === oi ? "checked" : ""}> <span>${o}</span></label>`).join("")}
        <span class="hint">Select the correct answer.</span></div>`;
    }
    if (q.qtype === "short") {
      return isQuiz ? `<label class="field">Accepted Answers
        <input class="input" data-qf="accepted" value="${esc(q.accepted)}" placeholder="e.g. Empathy; Active listening">
        <span class="hint">Separate answers with a semicolon (;). Capital letters and extra spaces don't matter.</span></label>` : "";
    }
    if (QTYPE[q.qtype].choices) {
      const multi = q.qtype === "multi";
      return `<div class="fb-options">
        ${q.options.map((o, oi) => `
          <div class="fb-option">
            ${isQuiz ? `<input type="${multi ? "checkbox" : "radio"}" name="c-${si}-${qi}" data-correct="${oi}" ${q.correct.includes(oi) ? "checked" : ""} aria-label="Correct answer">` : `<span class="fb-bullet ${multi ? "square" : ""}"></span>`}
            <input class="input" data-opt="${oi}" value="${esc(o)}" placeholder="Choice ${oi + 1}">
            <button type="button" class="btn sm ghost icon" data-act="del-opt" data-o="${oi}" ${q.options.length <= 2 ? "disabled" : ""} aria-label="Remove choice">×</button>
          </div>`).join("")}
        ${q.options.length < MAX_CHOICES ? '<button type="button" class="link-btn dark" data-act="add-opt">+ Add Choice</button>' : ""}
        ${isQuiz ? `<span class="hint">${multi ? "Tick every correct answer. Learners must pick all of them to earn the points." : "Select the correct answer."}</span>` : ""}
      </div>`;
    }
    // Survey scales: show what learners will see
    if (q.qtype === "rating") return `<div class="fb-preview">${Array.from({ length: 5 }, () => `<span class="star">${icons.star}</span>`).join("")}</div>`;
    if (q.qtype === "likert") return `<div class="fb-preview">${LIKERT.map((l) => `<span class="pill">${l}</span>`).join("")}</div>`;
    if (q.qtype === "nps") return `<div class="fb-preview">${Array.from({ length: 11 }, (_, n) => `<span class="nps">${n}</span>`).join("")}</div>`;
    return `<div class="fb-preview"><span class="fake-input">${q.qtype === "paragraph" ? "Long answer text" : "Short answer text"}</span></div>`;
  };

  const questionHtml = (q, si, qi, number) => `
    <div class="fb-q" data-s="${si}" data-q="${qi}">
      <div class="fb-q-head">
        <span class="fb-num">${number}</span>
        <select class="select" data-qf="qtype">
          ${Object.entries(QTYPE).filter(([, t]) => t.forms.includes(kind)).map(([k, t]) => `<option value="${k}" ${k === q.qtype ? "selected" : ""}>${t.label}</option>`).join("")}
        </select>
        ${isQuiz ? `<label class="fb-points">Points <input class="input" type="number" min="0" step="1" data-qf="points" value="${q.points}"></label>` : ""}
        <label class="check fb-req"><input type="checkbox" data-qf="required" ${q.required ? "checked" : ""}> Required</label>
        <span class="fb-tools">
          <button type="button" class="btn sm ghost icon" data-act="q-up" aria-label="Move up">${icons.up}</button>
          <button type="button" class="btn sm ghost icon" data-act="q-down" aria-label="Move down">${icons.down}</button>
          <button type="button" class="btn sm ghost icon" data-act="q-copy" aria-label="Duplicate">${icons.copy}</button>
          <button type="button" class="btn sm ghost icon danger" data-act="q-del" aria-label="Delete question">${icons.trash}</button>
        </span>
      </div>
      <textarea class="input prose short" data-qf="question" placeholder="Type the question">${esc(q.question)}</textarea>
      <input class="input fb-desc" data-qf="description" value="${esc(q.description)}" placeholder="Optional hint shown under the question">
      ${choiceEditor(q, si, qi)}
    </div>`;

  const draw = () => {
    let n = 0;
    const total = state.sections.reduce((a, s) => a + s.questions.length, 0);
    const points = state.sections.reduce((a, s) => a + s.questions.reduce((b, q) => b + (Number(q.points) || 0), 0), 0);
    box.innerHTML = `
      ${settingsHtml()}
      <div class="fb-summary"><span>${total} Question${total === 1 ? "" : "s"}</span>${isQuiz ? `<span>${points} Total Point${points === 1 ? "" : "s"}</span>` : ""}<span>${state.sections.length} Section${state.sections.length === 1 ? "" : "s"}</span></div>
      ${state.sections.map((sec, si) => `
        <section class="card fb-section" data-s="${si}">
          <div class="fb-section-head">
            <span class="fb-section-tag">Section ${si + 1}</span>
            ${isQuiz && state.settings.total_items !== "" ? `<label class="fb-ask">Ask <input class="input" type="number" min="0" max="${sec.questions.length}" data-ask value="${sec.ask ?? sec.questions.length}"> of ${sec.questions.length}</label>` : ""}
            <span class="fb-tools">
              <button type="button" class="btn sm ghost icon" data-act="s-up" ${si === 0 ? "disabled" : ""} aria-label="Move section up">${icons.up}</button>
              <button type="button" class="btn sm ghost icon" data-act="s-down" ${si === state.sections.length - 1 ? "disabled" : ""} aria-label="Move section down">${icons.down}</button>
              <button type="button" class="btn sm ghost icon danger" data-act="s-del" ${state.sections.length === 1 ? "disabled" : ""} aria-label="Delete section">${icons.trash}</button>
            </span>
          </div>
          <input class="input fb-section-title" data-sf="title" value="${esc(sec.title)}" placeholder="Section Title (optional)">
          <input class="input fb-desc" data-sf="description" value="${esc(sec.description)}" placeholder="Section description (optional)">
          <div class="fb-questions">
            ${sec.questions.map((q, qi) => questionHtml(q, si, qi, ++n)).join("") || '<div class="empty small-empty"><div>No questions in this section yet.</div></div>'}
          </div>
          <button type="button" class="btn" data-act="add-q">${icons.plus} Add Question</button>
        </section>`).join("")}
      <button type="button" class="btn add-section" data-act="add-s">${icons.plus} Add Section</button>`;
    drawPoolNote();
  };

  // Total Items: what each learner gets, and the suggested split per section
  const poolSizes = () => state.sections.map((sec) => sec.questions.length);
  const drawPoolNote = () => {
    const el = box.querySelector("[data-poolnote]");
    if (!el) return;
    const total = state.settings.total_items === "" ? null : Number(state.settings.total_items);
    const sizes = poolSizes();
    const pool = sizes.reduce((a, b) => a + b, 0);
    if (!total) { el.innerHTML = ""; return; }
    if (total > pool) { el.innerHTML = `<div class="fb-pool-card warn">Only ${pool} question${pool === 1 ? "" : "s"} so far. Add ${total - pool} more or lower Total Items.</div>`; return; }
    const asks = state.sections.map((sec) => sec.ask ?? sec.questions.length);
    const sum = asks.reduce((a, b) => a + b, 0);
    const named = (sec, i) => esc(sec.title || `Section ${i + 1}`);
    const mixed = state.sections.filter((sec, i) => asks[i] < sec.questions.length && new Set(sec.questions.map((q) => Number(q.points))).size > 1);
    if (sum === total) {
      el.innerHTML = `<div class="fb-pool-card ok">Each learner gets <b>${total} random question${total === 1 ? "" : "s"}</b> from ${pool}.
        ${state.sections.length > 1 ? `<div class="fb-split">${state.sections.map((sec, i) => `<span>${named(sec, i)}: <b>${asks[i]}</b> of ${sec.questions.length}</span>`).join("")}</div>` : ""}
        ${mixed.length ? `<div class="hint">${mixed.map((sec) => named(sec, state.sections.indexOf(sec))).join(", ")} mixes point values, so some learners may get more points to earn.</div>` : ""}</div>`;
      return;
    }
    const sug = suggestSplit(sizes, total);
    el.innerHTML = `<div class="fb-pool-card">Each learner gets <b>${total} random question${total === 1 ? "" : "s"}</b> from ${pool}. Suggested split:
      <div class="fb-split">${state.sections.map((sec, i) => `<span>${named(sec, i)}: <b>${sug[i]}</b> of ${sec.questions.length}</span>`).join("")}</div>
      <div class="fb-pool-actions"><button type="button" class="btn sm primary" data-act="use-split">Use This</button>
        <span class="hint">Or set "Ask" on each section (now ${sum} of ${total}).</span></div></div>`;
  };

  // ---------------- Editing ----------------
  const locate = (el) => {
    const s = el.closest("[data-s]");
    const q = el.closest("[data-q]");
    const si = s ? Number(s.dataset.s) : null;
    const qi = q ? Number(q.dataset.q) : null;
    return { si, qi, sec: si != null ? state.sections[si] : null, q: si != null && qi != null ? state.sections[si].questions[qi] : null };
  };

  box.addEventListener("input", (e) => {
    const t = e.target;
    const { sec, q } = locate(t);
    if (t.dataset.set) {
      if (t.type === "radio" && !t.checked) return;
      state.settings[t.dataset.set] = t.type === "checkbox" ? t.checked : t.value;
      if (t.dataset.set === "total_items") {
        // Starting a pool: begin from the suggested split; clearing it gives everyone every question
        if (t.value === "") state.sections.forEach((sec) => { sec.ask = null; });
        else {
          const sug = suggestSplit(poolSizes(), Number(t.value));
          state.sections.forEach((sec, i) => { sec.ask = sug[i]; });
        }
        markDirty();
        const pos = t.selectionStart;
        draw();
        const again = box.querySelector('[data-set="total_items"]');
        again?.focus();
        try { again?.setSelectionRange(pos, pos); } catch { /* number inputs */ }
        return;
      }
    } else if (t.dataset.ask != null && sec) {
      sec.ask = t.value === "" ? 0 : Math.max(0, Math.min(sec.questions.length, Number(t.value)));
      drawPoolNote();
    } else if (t.dataset.pair != null && q) {
      const p = q.pairs[Number(t.dataset.pair)];
      p[t.dataset.pf] = t.value;
      if (q.qtype === "crossword") {
        const prev = t.closest(".fb-q").querySelector("[data-cwprev]");
        if (prev) prev.innerHTML = crosswordPreview(q);
      }
    } else if (t.dataset.sf && sec) {
      sec[t.dataset.sf] = t.value;
    } else if (t.dataset.qf && q) {
      const f = t.dataset.qf;
      if (f === "qtype") {
        const next = newQuestion(t.value);
        if (PAIRED.includes(t.value) && !PAIRED.includes(q.qtype)) Object.assign(q, { pairs: blankPairs(), points: next.points, question: q.question || next.question });
        Object.assign(q, { qtype: t.value, options: QTYPE[t.value].choices && QTYPE[q.qtype].choices ? q.options : next.options, correct: [], accepted: "" });
        markDirty();
        return draw();
      }
      q[f] = t.type === "checkbox" ? t.checked : f === "points" ? Number(t.value) : t.value;
      if (f === "points") updateSummary();
    } else if (t.dataset.opt != null && q) {
      q.options[Number(t.dataset.opt)] = t.value;
    } else if (t.dataset.correct != null && q) {
      const oi = Number(t.dataset.correct);
      if (q.qtype === "multi") q.correct = t.checked ? [...new Set([...q.correct, oi])].sort() : q.correct.filter((x) => x !== oi);
      else q.correct = [oi];
    } else return;
    markDirty();
  });

  const updateSummary = () => {
    const points = state.sections.reduce((a, s) => a + s.questions.reduce((b, q) => b + (Number(q.points) || 0), 0), 0);
    const el = box.querySelector(".fb-summary span:nth-child(2)");
    if (el && isQuiz) el.textContent = `${points} Total Point${points === 1 ? "" : "s"}`;
  };

  const swap = (arr, i, j) => { if (j >= 0 && j < arr.length) [arr[i], arr[j]] = [arr[j], arr[i]]; };
  box.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const { si, qi, sec, q } = locate(b);
    const act = b.dataset.act;
    if (act === "add-s") state.sections.push({ id: null, title: "", description: "", ask: null, questions: [newQuestion()] });
    if (act === "s-up") swap(state.sections, si, si - 1);
    if (act === "s-down") swap(state.sections, si, si + 1);
    if (act === "s-del") {
      if (sec.questions.length && !confirm(`Delete this section and its ${sec.questions.length} question(s)?`)) return;
      state.sections.splice(si, 1);
    }
    if (act === "add-q") sec.questions.push(newQuestion(sec.questions.at(-1)?.qtype));
    if (act === "q-up") {
      if (qi > 0) swap(sec.questions, qi, qi - 1);
      else if (si > 0) state.sections[si - 1].questions.push(sec.questions.splice(qi, 1)[0]);
    }
    if (act === "q-down") {
      if (qi < sec.questions.length - 1) swap(sec.questions, qi, qi + 1);
      else if (si < state.sections.length - 1) state.sections[si + 1].questions.unshift(sec.questions.splice(qi, 1)[0]);
    }
    if (act === "q-copy") sec.questions.splice(qi + 1, 0, { ...structuredClone(q), id: null });
    if (act === "q-del") sec.questions.splice(qi, 1);
    if (act === "add-opt") q.options.push("");
    if (act === "add-pair" || act === "del-pair") {
      const before = q.pairs.length;
      if (act === "add-pair") q.pairs.push({ term: "", def: "" });
      else q.pairs.splice(Number(b.dataset.p), 1);
      if (Number(q.points) === before) q.points = q.pairs.length;   // points follow the rows unless changed by hand
    }
    if (act === "use-split") {
      const sug = suggestSplit(poolSizes(), Number(state.settings.total_items));
      state.sections.forEach((s2, i) => { s2.ask = sug[i]; });
    }
    if (act === "del-opt") {
      const oi = Number(b.dataset.o);
      q.options.splice(oi, 1);
      q.correct = q.correct.filter((x) => x !== oi).map((x) => (x > oi ? x - 1 : x));
    }
    markDirty();
    draw();
    if (act === "add-q" || act === "q-copy") {
      const target = act === "add-q"
        ? [...box.querySelectorAll(`.fb-section[data-s="${si}"] .fb-q textarea`)].at(-1)
        : box.querySelector(`.fb-q[data-s="${si}"][data-q="${qi + 1}"] textarea`);
      target?.focus();
    }
  });

  // ---------------- Save ----------------
  const validate = () => {
    const problems = [];
    let n = 0;
    for (const sec of state.sections) {
      for (const q of sec.questions) {
        n += 1;
        if (!q.question.trim()) problems.push(`Question ${n} has no text.`);
        if (PAIRED.includes(q.qtype)) {
          const rows = q.pairs.filter((p) => p.term.trim() || p.def.trim());
          const label = q.qtype === "crossword" ? "words" : "pairs";
          if (rows.length < 2) problems.push(`Question ${n} needs at least two ${label}.`);
          if (rows.some((p) => !p.term.trim() || !p.def.trim())) problems.push(`Question ${n}: fill in both sides of every row.`);
          if (q.qtype === "matching" && new Set(rows.map((p) => p.def.trim().toLowerCase())).size < rows.length) problems.push(`Question ${n}: each definition must be different.`);
          if (q.qtype === "crossword") {
            if (rows.some((p) => p.term.trim() && normWord(p.term).length < 2)) problems.push(`Question ${n}: each answer needs at least two letters (A to Z).`);
            if (new Set(rows.map((p) => normWord(p.term))).size < rows.length) problems.push(`Question ${n}: each answer must be different.`);
          }
        }
        if (QTYPE[q.qtype].choices && q.options.filter((o) => o.trim()).length < 2) problems.push(`Question ${n} needs at least two choices.`);
        if (isQuiz) {
          if (QTYPE[q.qtype].choices || q.qtype === "truefalse") {
            const good = q.correct.filter((i) => (q.options[i] ?? "").trim());
            if (!good.length) problems.push(`Pick the correct answer for question ${n}.`);
          }
          if (q.qtype === "short" && !q.accepted.split(";").some((a) => a.trim())) problems.push(`Add at least one accepted answer for question ${n}.`);
          if (!(Number(q.points) >= 0)) problems.push(`Question ${n} needs points (0 or more).`);
        }
      }
    }
    if (!n) problems.push("Add at least one question.");
    const s = state.settings;
    if (s.unlock_at && s.close_at && new Date(s.close_at) <= new Date(s.unlock_at)) problems.push("The closing date is before the opening date.");
    if (s.passing_score !== "" && (Number(s.passing_score) < 0 || Number(s.passing_score) > 100)) problems.push("The pass mark must be between 0 and 100.");
    if (isQuiz && s.total_items !== "") {
      const total = Number(s.total_items);
      const sum = state.sections.reduce((a, sec) => a + (sec.ask ?? sec.questions.length), 0);
      if (!(total >= 1)) problems.push("Total Items must be 1 or more, or empty.");
      else if (total > n) problems.push(`Total Items is ${total}, but there are only ${n} questions.`);
      else if (sum !== total) problems.push(`The sections ask for ${sum} questions, but Total Items is ${total}. Click Use This or change "Ask".`);
    }
    return problems;
  };

  const save = async () => {
    const problems = validate();
    if (problems.length) {
      openModal({ title: "Please Fix These First", body: `<ul class="problem-list">${problems.slice(0, 12).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`, submitLabel: "OK", cancelLabel: "" });
      return;
    }
    const btns = main.querySelectorAll("[data-save]");
    btns.forEach((b) => { b.disabled = true; });
    try {
      const s = state.settings;
      const { error: stepErr } = await sb.from("program_steps").update({
        description: s.description.trim() || null,
        unlock_at: fromLocalInput(s.unlock_at), close_at: fromLocalInput(s.close_at),
        ...(isQuiz ? {
          time_limit_minutes: s.time_limit_minutes === "" ? null : Number(s.time_limit_minutes),
          max_attempts: s.max_attempts === "" ? null : Number(s.max_attempts),
          passing_score: s.passing_score === "" ? null : Number(s.passing_score),
          shuffle_questions: !!s.shuffle_questions, shuffle_options: !!s.shuffle_options,
          answers_release: s.answers_release, show_answers: s.answers_release === "after_submit",
          total_items: s.total_items === "" ? null : Number(s.total_items),
          secure_mode: !!s.secure_mode,
        } : { identity_mode: s.identity_mode, thank_you: s.thank_you.trim() || null }),
      }).eq("id", step.id);
      if (stepErr) throw stepErr;

      // Give new sections and questions their ids here, so everything saves in a few requests
      state.sections.forEach((sec) => { sec.id ??= uid(); sec.questions.forEach((q) => { q.id ??= uid(); }); });
      const pooled = isQuiz && s.total_items !== "";
      const sectionRows = state.sections.map((sec, i) => ({ id: sec.id, step_id: step.id, position: i + 1, title: sec.title.trim() || null, description: sec.description.trim() || null,
        ask_count: pooled && (sec.ask ?? sec.questions.length) < sec.questions.length ? (sec.ask ?? sec.questions.length) : null }));
      let pos = 0;
      const questionRows = [];
      const keyRows = [];
      for (const sec of state.sections) {
        for (const q of sec.questions) {
          pos += 1;
          // Drop empty choices; keep the correct answers pointing at the same text
          let options = [];
          let correct = [];
          let matchChoices = null;
          let layout = null;
          if (q.qtype === "matching") {
            const rows = q.pairs.filter((p) => p.term.trim() && p.def.trim()).map((p) => ({ term: p.term.trim(), def: p.def.trim() }));
            options = rows.map((p) => p.term);
            // Definitions are stored mixed up, so their order doesn't give the answers away
            const mixed = rows.map((p, i) => ({ def: p.def, i, r: Math.random() })).sort((a, b) => a.r - b.r);
            matchChoices = mixed.map((x) => x.def);
            correct = rows.map((_, i) => mixed.findIndex((x) => x.i === i));
            layout = { display: q.display === "lines" ? "lines" : "dropdown" };
          } else if (q.qtype === "crossword") {
            const rows = q.pairs.filter((p) => p.term.trim() && p.def.trim());
            options = rows.map((p) => p.def.trim());
            correct = rows.map((p) => normWord(p.term));
            layout = buildCrossword(correct);
          } else if (QTYPE[q.qtype].choices) {
            const keep = q.options.map((o, i) => ({ o: o.trim(), i })).filter((x) => x.o);
            options = keep.map((x) => x.o);
            correct = keep.map((x, newI) => (q.correct.includes(x.i) ? newI : null)).filter((x) => x !== null);
          } else if (q.qtype === "truefalse") {
            options = ["True", "False"];
            correct = q.correct.slice(0, 1);
          } else if (q.qtype === "short") {
            correct = q.accepted.split(";").map((a) => a.trim()).filter(Boolean);
          }
          questionRows.push({
            id: q.id, step_id: step.id, section_id: sec.id, position: pos, qtype: q.qtype,
            question: q.question.trim(), description: q.description.trim() || null, options,
            points: isQuiz ? Number(q.points) || 0 : 0, required: !!q.required, match_choices: matchChoices, layout,
          });
          if (isQuiz) keyRows.push({ question_id: q.id, correct, correct_option: typeof correct[0] === "number" ? correct[0] : null });
        }
      }
      let r = await sb.from("form_sections").upsert(sectionRows);
      if (r.error) throw r.error;
      r = await sb.from("assessment_questions").upsert(questionRows);
      if (r.error) throw r.error;
      if (keyRows.length) {
        r = await sb.from("assessment_answer_keys").upsert(keyRows);
        if (r.error) throw r.error;
      }
      const keptQ = new Set(questionRows.map((x) => x.id));
      const keptS = new Set(sectionRows.map((x) => x.id));
      const goneQ = [...savedIds.questions].filter((id) => !keptQ.has(id));
      const goneS = [...savedIds.sections].filter((id) => !keptS.has(id));
      if (goneQ.length) { r = await sb.from("assessment_questions").delete().in("id", goneQ); if (r.error) throw r.error; }
      if (goneS.length) { r = await sb.from("form_sections").delete().in("id", goneS); if (r.error) throw r.error; }
      savedIds.questions = keptQ;
      savedIds.sections = keptS;
      dirty = false;
      saveBar.hidden = true;
      toast(isQuiz ? "Assessment saved." : "Survey saved.");
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, "err");
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  };
  main.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", save));
  main.querySelector(".back-link").addEventListener("click", (e) => {
    if (dirty && !confirm("You have unsaved changes. Leave without saving?")) e.preventDefault();
  });

  // ---------------- Excel template ----------------
  main.querySelector("[data-template]").addEventListener("click", async () => {
    try {
      await loadScript(LIBS.xlsx);
      const X = window.XLSX;
      const wb = X.utils.book_new();
      const head = isQuiz
        ? ["Section", "Question", "Type", "Choice 1", "Choice 2", "Choice 3", "Choice 4", "Choice 5", "Choice 6", "Correct Answer", "Points", "Required"]
        : ["Section", "Question", "Type", "Choice 1", "Choice 2", "Choice 3", "Choice 4", "Choice 5", "Choice 6", "Required"];
      const rows = isQuiz ? [
        ["Part 1: Basics", "What does active listening mean?", "Single Choice", "Waiting for your turn to talk", "Fully focusing on the speaker", "Taking notes", "", "", "", "2", 2, "Yes"],
        ["Part 1: Basics", "Which of these are coaching behaviours?", "Multiple Choice", "Asking open questions", "Giving all the answers", "Listening", "Interrupting", "", "", "1; 3", 3, "Yes"],
        ["Part 2: Applying It", "Feedback should be specific.", "True/False", "", "", "", "", "", "", "True", 1, "Yes"],
        ["Part 2: Applying It", "Name the skill of understanding others' feelings.", "Short Answer", "", "", "", "", "", "", "Empathy; Being empathetic", 4, "No"],
        ["Part 3: Key Terms", "A fixed amount the patient pays at each visit", "Matching", "", "", "", "", "", "", "Copay", 1, "Yes"],
        ["Part 3: Key Terms", "The amount paid before insurance starts paying", "Matching", "", "", "", "", "", "", "Deductible", 1, "Yes"],
        ["Part 3: Key Terms", "A refusal by the insurer to pay a claim", "Matching", "", "", "", "", "", "", "Denial", 1, "Yes"],
        ["Part 4: Crossword", "Checking that a patient's insurance is active", "Crossword", "", "", "", "", "", "", "Eligibility", 1, "Yes"],
        ["Part 4: Crossword", "The insurance company that pays the claim", "Crossword", "", "", "", "", "", "", "Payer", 1, "Yes"],
        ["Part 4: Crossword", "A request for payment sent to the insurer", "Crossword", "", "", "", "", "", "", "Claim", 1, "Yes"],
      ] : [
        ["About The Program", "How would you rate this program overall?", "Rating", "", "", "", "", "", "", "Yes"],
        ["About The Program", "The content was relevant to my role.", "Agree/Disagree", "", "", "", "", "", "", "Yes"],
        ["About The Program", "How likely are you to recommend this program to a colleague?", "0-10 Scale", "", "", "", "", "", "", "Yes"],
        ["Your Experience", "Which parts did you find most useful?", "Multiple Choice", "Modules", "Live sessions", "Workbook", "Assessments", "", "", "No"],
        ["Your Experience", "What should we improve?", "Long Text", "", "", "", "", "", "", "No"],
      ];
      const ws = X.utils.aoa_to_sheet([head, ...rows]);
      ws["!cols"] = head.map((h) => ({ wch: h === "Question" ? 50 : h.startsWith("Choice") ? 22 : 16 }));
      X.utils.book_append_sheet(wb, ws, "Questions");
      const help = isQuiz ? [
        ["How To Fill In The Questions Sheet"],
        ["Section", "Questions with the same section name are grouped together, in order. Leave empty for no sections."],
        ["Type", "Single Choice, Multiple Choice, True/False, Short Answer, Matching or Crossword"],
        ["Matching / Crossword", "One row per term: the definition (or clue) in Question, the term in Correct Answer. Rows next to each other in the same section become one question. Points are per row."],
        ["Choice 1 to 6", "The answer choices (Single Choice and Multiple Choice only)."],
        ["Correct Answer", "Single Choice: the choice number (e.g. 2). Multiple Choice: every correct number, separated by ; (e.g. 1; 3). True/False: True or False. Short Answer: accepted answers separated by ;"],
        ["Points", "How many points the question is worth (whole number)."],
        ["Required", "Yes or No"],
      ] : [
        ["How To Fill In The Questions Sheet"],
        ["Section", "Questions with the same section name are grouped together, in order. Leave empty for no sections."],
        ["Type", "Rating, Agree/Disagree, 0-10 Scale, Single Choice, Multiple Choice, Short Text or Long Text"],
        ["Choice 1 to 6", "The answer choices (Single Choice and Multiple Choice only)."],
        ["Required", "Yes or No"],
      ];
      const hs = X.utils.aoa_to_sheet(help);
      hs["!cols"] = [{ wch: 18 }, { wch: 110 }];
      X.utils.book_append_sheet(wb, hs, "How To Fill");
      X.writeFile(wb, `${isQuiz ? "Assessment" : "Survey"} Template.xlsx`);
    } catch (err) { toast(err.message, "err"); }
  });

  main.querySelector("[data-import]").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      await loadScript(LIBS.xlsx);
      const X = window.XLSX;
      const wb = X.read(await file.arrayBuffer());
      const sheet = wb.Sheets.Questions ?? wb.Sheets[wb.SheetNames[0]];
      const rows = X.utils.sheet_to_json(sheet, { defval: "", raw: false });
      const { sections: imported, errors } = parseTemplate(rows, isQuiz);
      const count = imported.reduce((a, s) => a + s.questions.length, 0);
      if (!count) {
        openModal({ title: "Nothing To Import", body: `<p>No questions were found in this file.</p>${errors.length ? `<ul class="problem-list">${errors.slice(0, 10).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}`, submitLabel: "OK", cancelLabel: "" });
        return;
      }
      const existing = state.sections.reduce((a, s) => a + s.questions.length, 0);
      openModal({
        title: `Import ${count} Question${count === 1 ? "" : "s"}?`,
        intro: `Found ${count} question${count === 1 ? "" : "s"} in ${imported.length} section${imported.length === 1 ? "" : "s"}.`,
        body: `
          ${errors.length ? `<div class="notice">${errors.length} row${errors.length === 1 ? " was" : "s were"} skipped:<ul class="problem-list">${errors.slice(0, 8).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
          ${existing ? `<label class="check"><input type="checkbox" name="replace"> Replace the ${existing} existing question${existing === 1 ? "" : "s"} (otherwise they are kept and the new ones added after)</label>` : ""}`,
        submitLabel: "Import",
        onSubmit: (f) => {
          if (f.replace?.checked) state.sections = imported;
          else {
            if (state.sections.length === 1 && !state.sections[0].questions.length && !state.sections[0].title) state.sections = [];
            state.sections.push(...imported);
          }
          markDirty();
          draw();
          toast("Imported. Check the questions, then click Save.");
        },
      });
    } catch (err) {
      toast(`Couldn't read that file: ${err.message}`, "err");
    }
  });

  const onUnload = (e) => { if (dirty) e.preventDefault(); };
  window.addEventListener("beforeunload", onUnload);
  window.addEventListener("hashchange", () => window.removeEventListener("beforeunload", onUnload), { once: true });
  draw();
}

// Turns the template's rows into sections and questions
const TYPE_NAMES = {
  "single choice": "single", "multiple choice": "multi", "true/false": "truefalse", "true / false": "truefalse", "truefalse": "truefalse",
  "short answer": "short", "rating": "rating", "agree/disagree": "likert", "agree / disagree": "likert", "likert": "likert",
  "0-10 scale": "nps", "0 to 10 scale": "nps", "nps": "nps", "short text": "text", "long text": "paragraph", "paragraph": "paragraph",
  "matching": "matching", "matching type": "matching", "connect the dots": "matching", "crossword": "crossword",
};

function parseTemplate(rows, isQuiz) {
  const sections = [];
  const errors = [];
  const get = (row, name) => {
    const key = Object.keys(row).find((k) => k.trim().toLowerCase() === name.toLowerCase());
    return key ? String(row[key] ?? "").trim() : "";
  };
  rows.forEach((row, i) => {
    const line = i + 2; // header is row 1
    const question = get(row, "Question");
    if (!question) return;
    const qtype = TYPE_NAMES[get(row, "Type").toLowerCase()];
    if (!qtype || (isQuiz ? !["single", "multi", "truefalse", "short", "matching", "crossword"].includes(qtype) : ["truefalse", "short", "matching", "crossword"].includes(qtype))) {
      errors.push(`Row ${line}: unknown type “${get(row, "Type")}”.`);
      return;
    }
    // Matching / Crossword: each row is one term; rows next to each other in a section make one question
    if (qtype === "matching" || qtype === "crossword") {
      const term = get(row, "Correct Answer");
      if (!term) { errors.push(`Row ${line}: add the term in Correct Answer.`); return; }
      if (qtype === "crossword" && term.toUpperCase().replace(/[^A-Z]/g, "").length < 2) { errors.push(`Row ${line}: a crossword answer needs at least two letters.`); return; }
      const name = get(row, "Section");
      let sec = sections.at(-1);
      if (!sec || sec.title !== name) { sec = { id: null, title: name, description: "", ask: null, questions: [] }; sections.push(sec); }
      let q = sec.questions.at(-1);
      if (!q || q.qtype !== qtype || q.pairs.length >= MAX_PAIRS) {
        q = { id: null, qtype, question: qtype === "matching" ? "Match each term to its definition." : "Complete the crossword.", description: "",
          options: [], correct: [], accepted: "", points: 0, required: !/^(no|n|false|0)$/i.test(get(row, "Required")), pairs: [], display: "dropdown" };
        sec.questions.push(q);
      }
      q.pairs.push({ term, def: question });
      q.points += Number(get(row, "Points") || 1);
      return;
    }
    const choices = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => get(row, `Choice ${n}`) || get(row, `Option ${n}`)).filter(Boolean);
    const q = {
      id: null, qtype, question, description: "", options: [], correct: [], accepted: "", pairs: [], display: "dropdown",
      points: isQuiz ? Number(get(row, "Points") || 1) : 0, required: !/^(no|n|false|0)$/i.test(get(row, "Required")),
    };
    const answer = get(row, "Correct Answer");
    if (qtype === "single" || qtype === "multi") {
      if (choices.length < 2) { errors.push(`Row ${line}: needs at least two choices.`); return; }
      q.options = choices;
      if (isQuiz) {
        q.correct = answer.split(/[;,]/).map((a) => a.trim()).filter(Boolean).map((a) => {
          const n = Number(a);
          if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1;
          return choices.findIndex((c) => c.toLowerCase() === a.toLowerCase());
        }).filter((n) => n >= 0);
        if (qtype === "single") q.correct = q.correct.slice(0, 1);
        if (!q.correct.length) { errors.push(`Row ${line}: the correct answer “${answer}” doesn't match a choice.`); return; }
      }
    } else if (qtype === "truefalse") {
      q.options = ["True", "False"];
      if (!/^(true|false)$/i.test(answer)) { errors.push(`Row ${line}: the correct answer must be True or False.`); return; }
      q.correct = [/^true$/i.test(answer) ? 0 : 1];
    } else if (qtype === "short") {
      if (!answer) { errors.push(`Row ${line}: add the accepted answer(s).`); return; }
      q.accepted = answer.split(";").map((a) => a.trim()).filter(Boolean).join("; ");
    }
    const name = get(row, "Section");
    let sec = sections.at(-1);
    if (!sec || sec.title !== name) {
      sec = { id: null, title: name, description: "", ask: null, questions: [] };
      sections.push(sec);
    }
    sec.questions.push(q);
  });
  return { sections, errors };
}

