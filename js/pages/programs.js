// Programs: the list of all programs, and "New program". Opening one goes to the editor.
import { sb } from "../supabase.js";
import { esc, openModal, toast, icons, fmtDate, statusPill, PROGRAM_TYPE, PROGRAM_STATUS } from "../ui.js";
import { renderProgramEditor } from "./program-editor.js";

const filters = { q: "", status: "current", type: "", client: "" };

export async function renderPrograms(main, ctx) {
  if (ctx.params[0]) return renderProgramEditor(main, ctx);

  main.innerHTML = `
    <header class="topbar">
      <div><h1>Programs</h1><p>Create programs, build the learning journey and enroll learners. Projects track tasks only.</p></div>
      <div class="top-actions"><button class="btn primary" data-new>${icons.plus} New Program</button></div>
    </header>
    <div class="toolbar">
      <input class="input search" type="search" placeholder="Search programs" data-f="q" value="${esc(filters.q)}">
      <select class="select" data-f="status">
        <option value="current">Not Archived</option>
        ${Object.entries(PROGRAM_STATUS).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join("")}
        <option value="">All</option>
      </select>
      <select class="select" data-f="type">
        <option value="">All Types</option>
        ${Object.entries(PROGRAM_TYPE).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
      </select>
      <select class="select" data-f="client" hidden><option value="">All Clients / Groups</option></select>
      <span class="count"></span>
    </div>
    <div id="program-list"><div class="empty"><div>Loading…</div></div></div>`;

  main.querySelector('[data-f="status"]').value = filters.status;
  main.querySelector('[data-f="type"]').value = filters.type;
  main.querySelector("[data-new]").addEventListener("click", newProgram);

  const [{ data: programs, error }, { data: progress }] = await Promise.all([
    sb.from("programs")
      .select("id, title, program_type, audience, client, status, start_date, due_date, owner:profiles!programs_owner_id_fkey(full_name), program_steps(count), enrollments(count)")
      .order("created_at", { ascending: false }),
    sb.from("v_enrollment_progress").select("program_id, percent_complete"),
  ]);
  const list = main.querySelector("#program-list");
  if (error) {
    list.innerHTML = `<div class="empty"><div><strong>Couldn't Load Programs</strong>${esc(error.message)}</div></div>`;
    return;
  }

  // Client / Group: filter list and suggestions come from what's already been typed
  const clients = [...new Set(programs.map((p) => (p.client ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const clientSel = main.querySelector('[data-f="client"]');
  if (clients.length) {
    clientSel.insertAdjacentHTML("beforeend", clients.map((c) => `<option>${esc(c)}</option>`).join(""));
    clientSel.hidden = false;
    clientSel.value = clients.includes(filters.client) ? filters.client : "";
  }
  filters.client = clientSel.value;

  const avg = {};
  for (const p of progress ?? []) (avg[p.program_id] ??= []).push(Number(p.percent_complete));

  const draw = () => {
    const q = filters.q.trim().toLowerCase();
    const shown = programs.filter((p) =>
      (!q || [p.title, p.audience, p.client].some((v) => (v ?? "").toLowerCase().includes(q))) &&
      (!filters.client || (p.client ?? "").trim() === filters.client) &&
      (filters.status === "" || (filters.status === "current" ? p.status !== "archived" : p.status === filters.status)) &&
      (!filters.type || p.program_type === filters.type));
    main.querySelector(".count").textContent = `${shown.length} of ${programs.length}`;

    if (!shown.length) {
      list.innerHTML = programs.length
        ? '<div class="empty"><div><strong>No Programs Match</strong>Try a different search or filter.</div></div>'
        : '<div class="empty"><div><strong>No Programs Yet</strong>Click <b>New Program</b> to create the first one.</div></div>';
      return;
    }

    list.innerHTML = `
      <div class="table-wrap">
        <table class="data clickable">
          <thead><tr><th>Program</th><th>Client / Group</th><th>Type</th><th>Status</th><th>Dates</th><th>Steps</th><th>Learners</th><th>Avg. Completion</th><th>Owner</th></tr></thead>
          <tbody>${shown.map((p) => {
            const scores = avg[p.id] ?? [];
            const mean = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
            const project = p.program_type === "project";
            return `
              <tr data-open="${p.id}" tabindex="0">
                <td class="name"><strong>${esc(p.title)}</strong><span>${esc(p.audience ?? "")}</span></td>
                <td>${p.client ? esc(p.client) : '<span class="muted">–</span>'}</td>
                <td>${esc(PROGRAM_TYPE[p.program_type])}</td>
                <td>${statusPill(p.status)}</td>
                <td>${p.start_date || p.due_date ? `${esc(fmtDate(p.start_date) || "–")} → ${esc(fmtDate(p.due_date) || "–")}` : '<span class="muted">Not Set</span>'}</td>
                <td>${project ? '<span class="muted">–</span>' : p.program_steps[0]?.count ?? 0}</td>
                <td>${project ? '<span class="muted">–</span>' : p.enrollments[0]?.count ?? 0}</td>
                <td>${mean === null || project ? '<span class="muted">–</span>' : `<div class="meter"><i style="width:${mean}%"></i></div> ${mean}%`}</td>
                <td>${esc(p.owner?.full_name ?? "")}</td>
              </tr>`;
          }).join("")}</tbody>
        </table>
      </div>`;
  };

  main.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("input", () => { filters[el.dataset.f] = el.value; draw(); }));
  list.addEventListener("click", (e) => {
    const row = e.target.closest("[data-open]");
    if (row) location.hash = `#/programs/${row.dataset.open}`;
  });
  list.addEventListener("keydown", (e) => {
    const row = e.target.closest("[data-open]");
    if (row && e.key === "Enter") location.hash = `#/programs/${row.dataset.open}`;
  });
  draw();

  function newProgram() {
    const { form } = openModal({
      title: "New Program",
      intro: "Start with the basics. You can add the learning journey and learners next.",
      body: `
        <label class="field">Title <input class="input" name="title" required></label>
        <label class="field">Type
          <select class="select" name="program_type">
            ${Object.entries(PROGRAM_TYPE).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
          </select>
          <span class="hint" data-type-hint></span>
        </label>
        <label class="field">Client / Group (Optional)
          <input class="input" name="client" list="client-list" placeholder="e.g. UT Health, VMMC, Patient Access team" autocomplete="off">
          <datalist id="client-list">${clients.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
        </label>
        <label class="field" data-audience>Audience <input class="input" name="audience" placeholder="e.g. Team leads, new hires"></label>
        <div class="two">
          <label class="field">Start Date <input class="input" type="date" name="start_date"></label>
          <label class="field">Due Date <input class="input" type="date" name="due_date"></label>
        </div>`,
      submitLabel: "Create Program",
      onSubmit: async (f) => {
        const title = f.title.value.trim();
        const project = f.program_type.value === "project";
        if (!title) throw new Error(`Please give the ${project ? "project" : "program"} a title.`);
        const { data, error: err } = await sb.from("programs").insert({
          title,
          program_type: f.program_type.value,
          audience: project ? null : f.audience.value.trim() || null,
          client: f.client.value.trim() || null,
          start_date: f.start_date.value || null,
          due_date: f.due_date.value || null,
          owner_id: ctx.me.id,
        }).select("id").single();
        if (err) throw err;
        toast(project ? "Project created. Add its tasks." : "Program created.");
        location.hash = `#/programs/${data.id}/${project ? "tasks" : "journey"}`;
      },
    });
    // Projects: tasks only (no learners or learning journey)
    const sync = () => {
      const project = form.program_type.value === "project";
      form.querySelector("[data-audience]").hidden = project;
      form.querySelector("[data-type-hint]").textContent = project
        ? "A task list with owners, due dates and hours. No learners, modules or enrolling." : "";
      form.querySelector("[type=submit]").textContent = project ? "Create Project" : "Create Program";
      const intro = form.closest(".modal")?.querySelector("header p, .modal-head p");
      if (intro) intro.textContent = project ? "Start with the basics. You can add the tasks next." : "Start with the basics. You can add the learning journey and learners next.";
    };
    form.program_type.addEventListener("change", sync);
    sync();
  }
}
