// Leader reviews: operations supervisors and managers review a program read-only,
// approve each part (overview, schedule, every step, overall journey) and comment.
//   Leaders:  #/reviews            programs they review
//             #/reviews/<program>  the review page
//   Trainers: Program → Reviews tab (reviewers, who approved what, comments)
import { sb } from "../supabase.js";
import { esc, toast, openModal, icons, stepIcon, statusPill, fmtDate, fmtDateTime, PROGRAM_TYPE, STEP_TYPE, QTYPE, LIKERT, ROLE_LABEL } from "../ui.js";

// ---------------------------------------------------------------------
// Shared: the parts of a program, and a fingerprint of what each looked like
// (an approval is "changed since" when the fingerprint no longer matches)
// ---------------------------------------------------------------------
const hash = (v) => {
  const s = JSON.stringify(v);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};
const linkOf = (s) => (Array.isArray(s.step_links) ? s.step_links[0]?.url : s.step_links?.url) ?? "";
const keyOf = (part, stepId) => (part === "step" ? `step:${stepId}` : part);

async function loadProgramForReview(programId) {
  const [{ data: program }, { data: steps }] = await Promise.all([
    sb.from("programs").select("*, owner:profiles!programs_owner_id_fkey(full_name)").eq("id", programId).maybeSingle(),
    sb.from("program_steps").select("*, step_links(url)").eq("program_id", programId).order("position"),
  ]);
  const formIds = (steps ?? []).filter((s) => ["assessment", "survey"].includes(s.step_type)).map((s) => s.id);
  const { data: questions } = formIds.length
    ? await sb.from("assessment_questions").select("*, assessment_answer_keys(correct)").in("step_id", formIds).order("position")
    : { data: [] };
  return { program, steps: steps ?? [], questions: questions ?? [] };
}

function partsOf(program, steps, questions) {
  const qOf = (id) => questions.filter((q) => q.step_id === id).map((q) => [q.question, q.qtype, q.options, q.points, q.required,
    (Array.isArray(q.assessment_answer_keys) ? q.assessment_answer_keys[0] : q.assessment_answer_keys)?.correct ?? null]);
  const overview = { key: "overview", part: "overview", step_id: null, title: "Program Overview", kind: "Overview",
    sig: hash([program.title, program.program_type, program.audience, program.objectives, program.overview, program.welcome_message,
      program.required_reading, program.start_date, program.due_date, program.welcome_video_path]) };
  const schedule = { key: "schedule", part: "schedule", step_id: null, title: "Schedule", kind: "Schedule",
    sig: hash(steps.map((s) => [s.id, s.title, s.step_type, s.unlock_at, s.due_at, s.session_start, s.session_end])) };
  const stepParts = steps.map((s, i) => ({
    key: keyOf("step", s.id), part: "step", step_id: s.id, step: s, title: `${i + 1}. ${s.title}`, kind: STEP_TYPE[s.step_type]?.short ?? s.step_type,
    sig: hash([s.title, s.description, s.step_type, linkOf(s), s.unlock_at, s.close_at, s.due_at, s.session_start, s.session_end, s.is_required,
      s.passing_score, s.time_limit_minutes, s.max_attempts, s.completion_text, s.max_files, s.secure_mode, s.show_answers, s.thank_you, qOf(s.id)]),
  }));
  const overall = { key: "overall", part: "overall", step_id: null, title: "Overall Journey", kind: "Final Sign-Off",
    sig: hash([overview.sig, schedule.sig, stepParts.map((p) => p.sig)]) };
  return [overview, schedule, ...stepParts, overall];
}

const approvalFor = (approvals, reviewerId, p) =>
  approvals.find((a) => a.reviewer_id === reviewerId && keyOf(a.part, a.step_id) === p.key);
const stale = (a, p) => a && a.signature && a.signature !== p.sig;

// ---------------------------------------------------------------------
// Comments thread (used on the leader page and in the trainer's tab)
// ---------------------------------------------------------------------
function threadHtml(list, staff) {
  return `${list.length ? `<div class="rvw-comments">${list.map((c) => `
      <div class="rvw-comment ${c.resolved_at ? "done" : ""}">
        <div class="rvw-comment-head"><strong>${esc(c.author_name ?? "Former User")}</strong>
          <span class="pill ${c.author_role === "leader" ? "teal" : ""}">${esc(ROLE_LABEL[c.author_role] ?? "")}</span>
          <span class="muted small">${esc(fmtDateTime(c.created_at))}</span>
          ${c.resolved_at ? '<span class="pill good">Resolved</span>' : ""}
          ${staff ? `<button type="button" class="link-btn dark small" data-resolve="${c.id}" data-to="${c.resolved_at ? "open" : "done"}">${c.resolved_at ? "Reopen" : "Mark Resolved"}</button>` : ""}
        </div>
        <div class="rvw-comment-body">${esc(c.body)}</div>
      </div>`).join("")}</div>` : '<p class="muted small" style="margin:0">No comments yet.</p>'}
    <div class="rvw-reply">
      <textarea class="input prose short" data-body placeholder="${staff ? "Reply to the reviewers…" : "Your remark or suggestion for this part…"}" maxlength="4000"></textarea>
      <button type="button" class="btn sm primary" data-send>${icons.comment} ${staff ? "Reply" : "Add Comment"}</button>
    </div>`;
}

async function sendComment(programId, p, body, meId) {
  const { error } = await sb.from("review_comments").insert({ program_id: programId, part: p.part, step_id: p.step_id, author_id: meId, body });
  if (error) throw error;
}

// ---------------------------------------------------------------------
// What each part shows (read-only)
// ---------------------------------------------------------------------
const dt = (v) => (v ? esc(fmtDateTime(v)) : '<span class="muted">—</span>');
const prose = (label, v) => (v ? `<div class="rvw-field"><span>${label}</span><div class="prose-text">${esc(v)}</div></div>` : "");

function overviewBody(program, videoUrl) {
  return `
    <div class="rvw-grid">
      <div class="rvw-field"><span>Type</span><b>${esc(PROGRAM_TYPE[program.program_type] ?? "")}</b></div>
      <div class="rvw-field"><span>Dates</span><b>${program.start_date ? esc(fmtDate(program.start_date)) : "—"} – ${program.due_date ? esc(fmtDate(program.due_date)) : "—"}</b></div>
      <div class="rvw-field"><span>Program Owner</span><b>${esc(program.owner?.full_name ?? "—")}</b></div>
      <div class="rvw-field"><span>Audience</span><b>${esc(program.audience ?? "—")}</b></div>
    </div>
    ${prose("Overview", program.overview)}${prose("Objectives", program.objectives)}
    ${prose("Welcome Message", program.welcome_message)}${prose("Required Reading", program.required_reading)}
    ${videoUrl ? `<div class="rvw-field"><span>Welcome Video</span><video src="${esc(videoUrl)}" controls preload="metadata" style="width:100%;max-width:520px;border-radius:8px"></video></div>` : ""}`;
}

function scheduleBody(steps) {
  if (!steps.length) return '<p class="muted">No steps yet.</p>';
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>#</th><th>Step</th><th>Type</th><th>Available From</th><th>Due / Session</th></tr></thead>
    <tbody>${steps.map((s, i) => `<tr><td>${i + 1}</td><td><b>${esc(s.title)}</b>${s.is_required ? "" : ' <span class="pill">Optional</span>'}</td>
      <td>${esc(STEP_TYPE[s.step_type]?.short ?? "")}</td><td>${dt(s.unlock_at)}</td>
      <td>${s.step_type === "ilt_session" ? dt(s.session_start) : dt(s.due_at)}</td></tr>`).join("")}</tbody></table></div>`;
}

function questionsHtml(qs) {
  if (!qs.length) return '<p class="muted">No questions yet.</p>';
  return `<ol class="rvw-questions">${qs.map((q) => {
    const key = (Array.isArray(q.assessment_answer_keys) ? q.assessment_answer_keys[0] : q.assessment_answer_keys)?.correct ?? [];
    const choices = ["single", "multi", "truefalse"].includes(q.qtype)
      ? `<ul>${(q.qtype === "truefalse" && !(q.options ?? []).length ? ["True", "False"] : q.options ?? []).map((o, i) => `<li class="${key.includes?.(i) ? "right" : ""}">${key.includes?.(i) ? "✓ " : ""}${esc(o)}</li>`).join("")}</ul>`
      : q.qtype === "short" ? `<div class="small">Accepted answers: <b>${esc((key ?? []).join(" · ") || "—")}</b></div>`
      : q.qtype === "likert" ? `<div class="muted small">${LIKERT.join(" · ")}</div>`
      : q.qtype === "rating" ? '<div class="muted small">1 to 5 stars</div>'
      : q.qtype === "nps" ? '<div class="muted small">0 to 10</div>' : '<div class="muted small">Free text</div>';
    return `<li><div><b>${esc(q.question)}</b> <span class="muted small">${esc(QTYPE[q.qtype]?.label ?? "")}${q.points ? ` · ${Number(q.points)} pt` : ""}${q.required ? "" : " · Optional"}</span></div>
      ${q.description ? `<div class="muted small">${esc(q.description)}</div>` : ""}${choices}</li>`;
  }).join("")}</ol>`;
}

function stepBody(s, qs) {
  const url = linkOf(s);
  const open = (label) => (url ? `<a class="btn sm" href="${esc(url)}" target="_blank" rel="noopener">${icons.link} ${label}</a>` : '<span class="pill crit">Link Missing</span>');
  const facts = [
    `Available ${s.unlock_at ? `from ${esc(fmtDateTime(s.unlock_at))}` : "when the program is live"}`,
    s.due_at && `Due ${esc(fmtDateTime(s.due_at))}`,
    s.close_at && `Closes ${esc(fmtDateTime(s.close_at))}`,
    s.step_type === "ilt_session" && s.session_start && `Session ${esc(fmtDateTime(s.session_start))}`,
    s.passing_score != null && `Pass Mark ${Number(s.passing_score)}%`,
    s.time_limit_minutes && `${s.time_limit_minutes} Min Limit`,
    s.max_attempts && `${s.max_attempts} Attempt${s.max_attempts === 1 ? "" : "s"}`,
    s.step_type === "assessment" && s.secure_mode && "Secure Test Mode",
    s.step_type === "upload" && `Up To ${s.max_files ?? 1} File${(s.max_files ?? 1) === 1 ? "" : "s"} (PDF, PNG, JPG)`,
    s.step_type === "resource" ? "Extra (Not Counted)" : !s.is_required && "Optional",
  ].filter(Boolean);
  const extra = {
    module: open("Open Module"),
    ilt_session: open("Teams Link"),
    resource: open("Open Document"),
    survey: qs.length ? questionsHtml(qs) : open("Open Survey"),
    assessment: questionsHtml(qs),
    upload: "",
  }[s.step_type] ?? "";
  return `<div class="muted small" style="margin-bottom:8px">${facts.join(" · ")}</div>
    ${s.description ? prose("Instructions For Learners", s.description) : ""}${extra}`;
}

// =====================================================================
// Leaders: list of programs to review
// =====================================================================
export async function renderLeaderReviews(main, ctx) {
  const [programId] = ctx.params;
  if (programId) return reviewPage(main, ctx.me, programId);
  main.innerHTML = `<header class="topbar"><div><h1>Program Reviews</h1><p>Programs you've been asked to review and approve.</p></div></header>
    <div id="rv-list"><div class="empty"><div>Loading…</div></div></div>`;
  const { data: mine, error } = await sb.from("program_reviewers")
    .select("added_at, program:programs(id, title, status, program_type, start_date, due_date)").eq("profile_id", ctx.me.id);
  const box = main.querySelector("#rv-list");
  if (error) { box.innerHTML = `<div class="empty"><div><strong>Couldn't Load</strong>${esc(error.message)}</div></div>`; return; }
  const programs = (mine ?? []).map((r) => r.program).filter(Boolean);
  if (!programs.length) {
    box.innerHTML = '<div class="empty"><div><strong>Nothing To Review Yet</strong>The Technical Training Team will add you to a program when it\'s ready for your review.</div></div>';
    return;
  }
  const ids = programs.map((p) => p.id);
  const [{ data: steps }, { data: approvals }] = await Promise.all([
    sb.from("program_steps").select("id, program_id").in("program_id", ids),
    sb.from("review_approvals").select("program_id, part").eq("reviewer_id", ctx.me.id),
  ]);
  box.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Program</th><th>Status</th><th>Dates</th><th>Your Review</th><th></th></tr></thead>
    <tbody>${programs.map((p) => {
      const total = 3 + (steps ?? []).filter((s) => s.program_id === p.id).length;
      const mineN = (approvals ?? []).filter((a) => a.program_id === p.id).length;
      const signed = (approvals ?? []).some((a) => a.program_id === p.id && a.part === "overall");
      return `<tr><td class="name"><strong>${esc(p.title)}</strong><span>${esc(PROGRAM_TYPE[p.program_type] ?? "")}</span></td>
        <td>${statusPill(p.status)}</td>
        <td>${p.start_date ? esc(fmtDate(p.start_date)) : "—"} – ${p.due_date ? esc(fmtDate(p.due_date)) : "—"}</td>
        <td>${signed ? '<span class="pill good">Approved</span>' : `<span class="pill ${mineN ? "prog" : ""}">${Math.min(mineN, total)} Of ${total} Approved</span>`}</td>
        <td class="actions"><a class="btn sm primary" href="#/reviews/${p.id}">Open Review</a></td></tr>`;
    }).join("")}</tbody></table></div>`;
}

// =====================================================================
// Leaders: one program's review page
// =====================================================================
async function reviewPage(main, me, programId) {
  main.innerHTML = '<div class="empty" style="margin-top:24px"><div>Loading…</div></div>';
  const { program, steps, questions } = await loadProgramForReview(programId);
  if (!program) { location.hash = "#/reviews"; return; }
  const [{ data: approvals }, { data: comments }, video] = await Promise.all([
    sb.from("review_approvals").select("*").eq("program_id", programId),
    sb.from("review_comments").select("*").eq("program_id", programId).order("created_at"),
    program.welcome_video_path ? sb.storage.from("welcome-videos").createSignedUrl(program.welcome_video_path, 3600) : Promise.resolve({ data: null }),
  ]);
  const parts = partsOf(program, steps, questions);
  const open = new Set();
  // Everything lives in a fresh container, so listeners never pile up on revisits
  main.innerHTML = "<div data-rv-root></div>";
  const root = main.querySelector("[data-rv-root]");

  const draw = () => {
    const done = parts.filter((p) => { const a = approvalFor(approvals, me.id, p); return a && !stale(a, p); }).length;
    root.innerHTML = `
      <header class="topbar">
        <div><a class="back-link" href="#/reviews">${icons.back} Program Reviews</a>
          <h1>${esc(program.title)}</h1>
          <p>Review each part. Tick <b>Approve</b> when it's good, or leave a comment. You can't change anything here.</p></div>
        <div class="top-actions"><span class="pill ${done === parts.length ? "good" : "prog"}" style="font-size:13px;padding:6px 12px">${done} Of ${parts.length} Approved</span></div>
      </header>
      <div class="rvw-list">${parts.map((p) => {
        const a = approvalFor(approvals, me.id, p);
        const changed = stale(a, p);
        const list = (comments ?? []).filter((c) => keyOf(c.part, c.step_id) === p.key);
        const body = p.part === "overview" ? overviewBody(program, video?.data?.signedUrl)
          : p.part === "schedule" ? scheduleBody(steps)
          : p.part === "overall" ? '<p class="muted" style="margin:0">Your final sign-off on the whole program, once you\'re happy with every part above.</p>'
          : stepBody(p.step, questions.filter((q) => q.step_id === p.step_id));
        return `<section class="card rvw-part ${p.part === "overall" ? "overall" : ""}" data-key="${p.key}">
          <div class="rvw-head">
            <div class="rvw-title">${p.step ? `<span class="step-icon sm">${stepIcon(p.step.step_type)}</span>` : ""}
              <div><div class="step-type">${esc(p.kind)}</div><strong>${esc(p.title)}</strong></div></div>
            <div class="rvw-actions">
              ${changed ? '<span class="pill warn">Changed Since You Approved</span>' : ""}
              <button type="button" class="btn sm" data-toggle="${p.key}">${icons.comment} Comments${list.length ? ` (${list.length})` : ""}</button>
              <button type="button" class="btn sm rvw-approve ${a && !changed ? "on" : ""}" data-approve="${p.key}">
                ${a && !changed ? `${icons.check} Approved` : changed ? "Approve Again" : p.part === "overall" ? "Approve Program" : "Approve"}</button>
            </div>
          </div>
          ${p.part === "overall" ? body : `<details class="rvw-body" ${open.has(`d:${p.key}`) ? "open" : ""} data-details="${p.key}"><summary>Show Details</summary><div>${body}</div></details>`}
          <div class="rvw-thread" ${open.has(p.key) ? "" : "hidden"}>${threadHtml(list, false)}</div>
        </section>`;
      }).join("")}</div>`;
  };
  draw();

  root.addEventListener("toggle", (e) => {
    const d = e.target.closest?.("[data-details]");
    if (d) { if (d.open) open.add(`d:${d.dataset.details}`); else open.delete(`d:${d.dataset.details}`); }
  }, true);
  root.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-toggle]");
    const ap = e.target.closest("[data-approve]");
    const send = e.target.closest("[data-send]");
    if (t) {
      if (open.has(t.dataset.toggle)) open.delete(t.dataset.toggle); else open.add(t.dataset.toggle);
      draw();
    }
    if (ap) {
      const p = parts.find((x) => x.key === ap.dataset.approve);
      const a = approvalFor(approvals, me.id, p);
      ap.disabled = true;
      if (a) await sb.from("review_approvals").delete().eq("id", a.id);
      if (!a || stale(a, p)) {
        const { error } = await sb.from("review_approvals").insert({ program_id: programId, reviewer_id: me.id, part: p.part, step_id: p.step_id, signature: p.sig });
        if (error) { toast(error.message, "err"); ap.disabled = false; return; }
        toast(p.part === "overall" ? "Program approved. Thank you!" : "Approved.");
      } else toast("Approval taken back.");
      const { data } = await sb.from("review_approvals").select("*").eq("program_id", programId);
      approvals.splice(0, approvals.length, ...(data ?? []));
      draw();
    }
    if (send) {
      const part = send.closest("[data-key]");
      const p = parts.find((x) => x.key === part.dataset.key);
      const body = part.querySelector("[data-body]").value.trim();
      if (!body) return toast("Type your comment first.", "err");
      send.disabled = true;
      try {
        await sendComment(programId, p, body, me.id);
        toast("Comment added. The Technical Training Team will see it.");
        open.add(p.key);
        const { data } = await sb.from("review_comments").select("*").eq("program_id", programId).order("created_at");
        comments.splice(0, comments.length, ...(data ?? []));
        draw();
      } catch (err) { toast(err.message, "err"); send.disabled = false; }
    }
  });
}

// =====================================================================
// Trainers: Program → Reviews tab
// =====================================================================
export async function reviewsTab(area, program, reloadAll, me) {
  area.innerHTML = '<div class="empty"><div>Loading…</div></div>';
  const [{ steps, questions }, { data: reviewers }, { data: approvals }, { data: comments }, { data: leaders }] = await Promise.all([
    loadProgramForReview(program.id),
    sb.from("program_reviewers").select("profile_id, added_at, person:profiles!program_reviewers_profile_id_fkey(full_name, email, is_active)").eq("program_id", program.id),
    sb.from("review_approvals").select("*").eq("program_id", program.id),
    sb.from("review_comments").select("*").eq("program_id", program.id).order("created_at"),
    sb.from("profiles").select("id, full_name, email").eq("role", "leader").eq("is_active", true).order("full_name"),
  ]);
  const parts = partsOf(program, steps, questions);
  const redraw = () => reviewsTab(area, program, reloadAll, me);
  const people = (reviewers ?? []).sort((a, b) => (a.person?.full_name ?? "").localeCompare(b.person?.full_name ?? ""));
  const openCount = (comments ?? []).filter((c) => !c.resolved_at && c.author_role === "leader").length;

  area.innerHTML = `
    <div class="tab-head">
      <p class="muted">Leaders who review this program. They can see everything, approve each part and comment, but can't change anything.${openCount ? ` <b style="color:var(--warn-ink)">${openCount} open comment${openCount === 1 ? "" : "s"}.</b>` : ""}</p>
      <button class="btn primary" data-add>${icons.plus} Add Reviewer</button>
    </div>
    ${people.length ? `
      <div class="rvw-people">${people.map((r) => `<span class="pill">${esc(r.person?.full_name ?? "Former User")}
        <button type="button" class="link-btn dark" data-remove="${r.profile_id}" title="Remove reviewer" aria-label="Remove ${esc(r.person?.full_name ?? "")}">✕</button></span>`).join(" ")}</div>
      <div class="table-wrap" style="margin-top:10px"><table class="data rvw-matrix">
        <thead><tr><th>Part</th>${people.map((r) => `<th>${esc(r.person?.full_name ?? "Former User")}</th>`).join("")}<th>Comments</th></tr></thead>
        <tbody>${parts.map((p) => {
          const list = (comments ?? []).filter((c) => keyOf(c.part, c.step_id) === p.key);
          const openN = list.filter((c) => !c.resolved_at).length;
          return `<tr>
            <td>${p.part === "overall" ? `<b>${esc(p.title)}</b>` : esc(p.title)} <span class="muted small">${p.step ? esc(p.kind) : ""}</span></td>
            ${people.map((r) => {
              const a = approvalFor(approvals ?? [], r.profile_id, p);
              return `<td>${!a ? '<span class="muted">—</span>' : stale(a, p) ? `<span class="pill warn" title="Approved ${esc(fmtDateTime(a.approved_at))}">Changed Since Approval</span>`
                : `<span class="pill good" title="${esc(fmtDateTime(a.approved_at))}">${icons.check} Approved</span>`}</td>`;
            }).join("")}
            <td><button type="button" class="link-btn dark" data-thread="${p.key}">${list.length ? `${list.length} Comment${list.length === 1 ? "" : "s"}` : "Add Comment"}</button>
              ${openN ? ` <span class="pill warn">${openN} Open</span>` : ""}</td>
          </tr>`;
        }).join("")}</tbody></table></div>
      <p class="muted small" style="margin-top:8px">"Changed Since Approval" means you edited that part after the leader approved it. They'll see it and can approve again.</p>`
      : `<div class="empty"><div><strong>No Reviewers Yet</strong>Add operations leaders so they can review and approve this program.${leaders?.length ? "" : " First create their accounts in <b>People</b> with the role <b>Leader</b> (Admin only)."}</div></div>`}`;

  area.querySelector("[data-add]").addEventListener("click", () => {
    const taken = new Set(people.map((r) => r.profile_id));
    const options = (leaders ?? []).filter((l) => !taken.has(l.id));
    if (!options.length) {
      return openModal({ title: "No Leaders To Add", intro: (leaders ?? []).length ? "Every Leader account is already a reviewer of this program." : "There are no Leader accounts yet. Admin can create them in People with the role Leader.", body: "", submitLabel: "OK", cancelLabel: "" });
    }
    openModal({
      title: "Add Reviewers",
      intro: "Tick the leaders who should review this program. They'll see it under Program Reviews when they sign in.",
      body: `<div class="rvw-pick">${options.map((l) => `<label class="check"><input type="checkbox" value="${l.id}"> <span><b>${esc(l.full_name)}</b> <span class="muted small">${esc(l.email)}</span></span></label>`).join("")}</div>`,
      submitLabel: "Add Reviewers",
      onSubmit: async (f) => {
        const ids = [...f.querySelectorAll("input:checked")].map((c) => c.value);
        if (!ids.length) throw new Error("Tick at least one leader.");
        const { error } = await sb.from("program_reviewers").insert(ids.map((id) => ({ program_id: program.id, profile_id: id })));
        if (error) throw error;
        toast(`${ids.length} reviewer${ids.length === 1 ? "" : "s"} added.`);
        redraw();
      },
    });
  });
  area.querySelector(".rvw-people")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-remove]");
    if (!b) return;
    const r = people.find((x) => x.profile_id === b.dataset.remove);
    openModal({
      title: `Remove ${r.person?.full_name ?? "This Reviewer"}?`,
      intro: "They'll no longer see this program. Their approvals and comments stay in the record.",
      body: "",
      submitLabel: "Remove",
      danger: true,
      onSubmit: async () => {
        const { error } = await sb.from("program_reviewers").delete().eq("program_id", program.id).eq("profile_id", r.profile_id);
        if (error) throw error;
        toast("Reviewer removed.");
        redraw();
      },
    });
  });
  area.querySelector("tbody")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-thread]");
    if (!b) return;
    const p = parts.find((x) => x.key === b.dataset.thread);
    openThread(p);
  });

  function openThread(p) {
    const list = (comments ?? []).filter((c) => keyOf(c.part, c.step_id) === p.key);
    const { form, close } = openModal({ title: `Comments: ${p.title}`, wide: true, body: threadHtml(list, true), submitLabel: "", cancelLabel: "Close" });
    form.addEventListener("click", async (e) => {
      const rs = e.target.closest("[data-resolve]");
      const send = e.target.closest("[data-send]");
      if (rs) {
        const { error } = await sb.from("review_comments").update({ resolved_at: rs.dataset.to === "done" ? new Date().toISOString() : null }).eq("id", rs.dataset.resolve);
        if (error) return toast(error.message, "err");
      }
      if (send) {
        const body = form.querySelector("[data-body]").value.trim();
        if (!body) return toast("Type your reply first.", "err");
        try { await sendComment(program.id, p, body, me.id); } catch (err) { return toast(err.message, "err"); }
        toast("Reply added.");
      }
      if (rs || send) {
        const { data } = await sb.from("review_comments").select("*").eq("program_id", program.id).order("created_at");
        comments.splice(0, comments.length, ...(data ?? []));
        close();
        openThread(p);
        redrawSoon();
      }
    });
  }
  let pending = null;
  function redrawSoon() { clearTimeout(pending); pending = setTimeout(() => { if (!document.querySelector(".modal-backdrop")) redraw(); else redrawSoon(); }, 600); }
}
