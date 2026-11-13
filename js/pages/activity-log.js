// Activity Log: who added, changed or removed what, and when (Admin, trainers and leaders' actions).
// Entries are written by the database itself, so they can't be skipped or edited from the portal.
import { sb } from "../supabase.js";
import { esc, openModal, fmtDateTime, ROLE_LABEL } from "../ui.js";

const AREA = {
  profiles: "Person", programs: "Program", program_steps: "Step", step_links: "Step Link", enrollments: "Enrollment",
  uploads: "Upload Review", enrollment_exclusions: "Learner Step Change", form_sections: "Test Section",
  assessment_questions: "Question", assessment_answer_keys: "Correct Answer", assessment_attempts: "Score Change",
  program_reviewers: "Reviewer", review_approvals: "Approval", review_comments: "Review Comment",
  program_tasks: "Task", task_time: "Time Entry",
};
const ACTION = { insert: "Added", update: "Changed", delete: "Removed" };
const RANGES = { 7: "Last 7 Days", 30: "Last 30 Days", 90: "Last 90 Days", 0: "All Time" };
const HIDE = new Set(["updated_at", "created_at", "id", "user_id", "page_since", "last_seen"]);
const filters = { days: "7", who: "", area: "", q: "" };
const PAGE = 500;

const words = (s) => String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const show = (v) => (v == null || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

export async function renderActivityLog(main) {
  main.innerHTML = `
    <header class="topbar"><div><h1>Activity Log</h1><p>Every add, change and removal in the portal: who did it and when. Entries can't be edited.</p></div></header>
    <div class="toolbar">
      <input class="input search" type="search" placeholder="Search item, program or details" data-f="q" value="${esc(filters.q)}">
      <select class="select" data-f="days">${Object.entries(RANGES).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <select class="select" data-f="who"><option value="">Everyone</option></select>
      <select class="select" data-f="area"><option value="">All Areas</option>${Object.entries(AREA).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <span class="count"></span>
    </div>
    <div id="log"><div class="empty"><div>Loading…</div></div></div>`;
  main.querySelector('[data-f="days"]').value = filters.days;
  main.querySelector('[data-f="area"]').value = filters.area;

  const [{ data: people }, { data: programs }, { data: steps }] = await Promise.all([
    sb.from("profiles").select("id, full_name, role").order("full_name"),
    sb.from("programs").select("id, title"),
    sb.from("program_steps").select("id, program_id, title"),
  ]);
  const who = Object.fromEntries((people ?? []).map((p) => [p.id, p]));
  const progName = Object.fromEntries((programs ?? []).map((p) => [p.id, p.title]));
  const stepOf = Object.fromEntries((steps ?? []).map((s) => [s.id, s]));
  const whoSel = main.querySelector('[data-f="who"]');
  whoSel.insertAdjacentHTML("beforeend", (people ?? []).filter((p) => p.role !== "learner").map((p) => `<option value="${p.id}">${esc(p.full_name)} (${esc(ROLE_LABEL[p.role] ?? p.role)})</option>`).join(""));
  whoSel.value = filters.who;

  let rows = [];
  let more = false;
  const list = main.querySelector("#log");

  const load = async (append = false) => {
    let q = sb.from("activity_log").select("*").order("created_at", { ascending: false }).range(append ? rows.length : 0, (append ? rows.length : 0) + PAGE - 1);
    if (Number(filters.days)) q = q.gte("created_at", new Date(Date.now() - Number(filters.days) * 86400000).toISOString());
    if (filters.who) q = q.eq("actor_id", filters.who);
    if (filters.area) q = q.eq("entity_type", filters.area);
    const { data, error } = await q;
    if (error) { list.innerHTML = `<div class="empty"><div><strong>Couldn't Load The Log</strong>${esc(error.message)}</div></div>`; return; }
    rows = append ? rows.concat(data) : data;
    more = data.length === PAGE;
    draw();
  };

  const describe = (r) => {
    const d = r.details ?? {};
    const row = d.after ?? d;
    const step = stepOf[row.step_id];
    const programId = row.program_id ?? step?.program_id ?? (r.entity_type === "programs" ? r.entity_id : null);
    const item = row.title ?? row.full_name ?? row.question ?? row.file_name ?? (row.body ? `“${String(row.body).slice(0, 80)}”` : null)
      ?? (r.entity_type === "task_time" ? `${row.total_hours} h by ${who[row.person_id]?.full_name ?? "someone"}` : null)
      ?? (r.entity_type === "review_approvals" ? `${words(row.part)}${step ? `: ${step.title}` : ""}` : null)
      ?? (r.entity_type === "program_reviewers" ? who[row.profile_id]?.full_name : null)
      ?? (r.entity_type === "enrollments" ? who[row.learner_id]?.full_name : null)
      ?? row.email ?? step?.title ?? "";
    let changes = [];
    if (r.action === "update" && d.before && d.after) {
      changes = Object.keys(d.after).filter((k) => !HIDE.has(k) && JSON.stringify(d.before[k]) !== JSON.stringify(d.after[k]))
        .map((k) => ({ k, from: d.before[k], to: d.after[k] }));
    }
    return { item, program: programId ? progName[programId] ?? "" : "", changes };
  };

  const draw = () => {
    const q = filters.q.trim().toLowerCase();
    const shown = rows.map((r) => ({ r, x: describe(r) })).filter(({ r, x }) => !q ||
      `${x.item} ${x.program} ${AREA[r.entity_type] ?? r.entity_type} ${JSON.stringify(r.details ?? {})}`.toLowerCase().includes(q));
    main.querySelector(".count").textContent = `${shown.length} entr${shown.length === 1 ? "y" : "ies"}`;
    list.innerHTML = shown.length ? `<div class="table-wrap"><table class="data">
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Area</th><th>Item</th><th>Program</th><th>What Changed</th></tr></thead>
      <tbody>${shown.map(({ r, x }, i) => {
        const p = who[r.actor_id];
        const act = ACTION[r.action] ?? words(r.action);
        return `<tr data-row="${i}" style="cursor:pointer">
          <td style="white-space:nowrap">${esc(fmtDateTime(r.created_at))}</td>
          <td class="name"><strong>${esc(p?.full_name ?? "System")}</strong><span>${esc(p ? ROLE_LABEL[p.role] ?? "" : "")}</span></td>
          <td><span class="pill ${r.action === "delete" ? "crit" : r.action === "insert" ? "good" : "prog"}">${esc(act)}</span></td>
          <td>${esc(AREA[r.entity_type] ?? words(r.entity_type))}</td>
          <td>${esc(String(x.item).slice(0, 90))}</td>
          <td>${esc(x.program)}</td>
          <td class="muted small">${x.changes.slice(0, 2).map((c) => `${esc(words(c.k))}: ${esc(show(c.from).slice(0, 30))} → ${esc(show(c.to).slice(0, 30))}`).join("<br>")}${x.changes.length > 2 ? `<br>+ ${x.changes.length - 2} more` : ""}</td>
        </tr>`;
      }).join("")}</tbody></table></div>
      ${more ? '<div style="text-align:center;margin-top:12px"><button class="btn" data-more>Load More</button></div>' : ""}`
      : '<div class="empty"><div><strong>Nothing Logged</strong>No activity matches these filters.</div></div>';
    list.querySelector("[data-more]")?.addEventListener("click", () => load(true));
    list.querySelector("tbody")?.addEventListener("click", (e) => {
      const tr = e.target.closest("[data-row]");
      if (tr) openEntry(shown[Number(tr.dataset.row)]);
    });
  };

  const openEntry = ({ r, x }) => {
    const d = r.details ?? {};
    const rowsHtml = r.action === "update" && d.before
      ? `<table class="data"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${(x.changes.length ? x.changes : [])
          .map((c) => `<tr><td>${esc(words(c.k))}</td><td>${esc(show(c.from))}</td><td><b>${esc(show(c.to))}</b></td></tr>`).join("") || '<tr><td colspan="3" class="muted">Only timestamps changed.</td></tr>'}</tbody></table>`
      : `<table class="data"><tbody>${Object.entries(d.after ?? d).filter(([k]) => !HIDE.has(k))
          .map(([k, v]) => `<tr><td>${esc(words(k))}</td><td>${esc(show(v))}</td></tr>`).join("")}</tbody></table>`;
    openModal({
      title: `${ACTION[r.action] ?? words(r.action)}: ${AREA[r.entity_type] ?? words(r.entity_type)}`,
      intro: `${esc(who[r.actor_id]?.full_name ?? "System")} · ${esc(fmtDateTime(r.created_at))}${x.program ? ` · ${esc(x.program)}` : ""}`,
      wide: true,
      body: `<div class="table-wrap" style="max-height:55vh">${rowsHtml}</div>`,
      submitLabel: "Close",
      cancelLabel: "",
    });
  };

  main.querySelectorAll("[data-f]").forEach((el) => el.addEventListener(el.dataset.f === "q" ? "input" : "change", () => {
    filters[el.dataset.f] = el.value;
    if (el.dataset.f === "q") draw(); else load();
  }));
  load();
}
