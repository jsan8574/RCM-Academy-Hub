// Program → Tasks: the Technical Training team's deliverables for one program,
// who owns each, due dates counted from the session date, status, and time spent.
import { sb } from "../supabase.js";
import { esc, toast, openModal, icons } from "../ui.js";

export const TASK_STATUS = ["Not Started", "In Progress", "Done", "Blocked", "N/A"];
export const TASK_CATS = ["Logistics", "Communications", "Content", "Assessment", "Delivery", "Evaluation", "Reporting", "Recognition", "Other"];
export const STATUS_PILL = { "Not Started": "", "In Progress": "prog", Done: "good", Blocked: "crit", "N/A": "" };
export const HOURS_PER_DAY = 8;   // capacity used for utilization

// The Technical Training activity checklist: [activity, category, days from the session date (null = no set date)]
export const CHECKLIST = [
  ["Coordination (Non-Technical Training Faci)", "Logistics", -10],
  ["Coordination (Participant’s Supervisor and Managers)", "Logistics", -7],
  ["Coordination (Participants)", "Logistics", -5],
  ["Pre-Event Communication", "Communications", -7],
  ["Scheduling – Sending Meeting Invites", "Communications", -7],
  ["Group Chat for Participants", "Communications", -7],
  ["Email Reminders", "Communications", -1],
  ["Chat Reminders", "Communications", -1],
  ["Mid-Event Communication", "Communications", 0],
  ["Post-Event Communication", "Communications", 2],
  ["Pre-Session Self-Learning Workbook Activity", "Content", -5],
  ["Sharing of Materials (PDF Copy)", "Content", 1],
  ["Video Repository of Sessions", "Content", 2],
  ["Remove Expiration of Video Recording", "Content", 2],
  ["Manager’s Observation Form (Pre)", "Assessment", -5],
  ["Pre-Session Demo/Interview", "Assessment", -3],
  ["Pre-Assessment", "Assessment", -1],
  ["Session Quizzes", "Assessment", 0],
  ["Post-Assessment", "Assessment", 1],
  ["Post-Session Demo/Interview", "Assessment", 7],
  ["Manager’s Observation Form (Post)", "Assessment", 30],
  ["Mid-Assessment (Annual – Q1/2/3)", "Assessment", null],
  ["Attendance Tracking", "Delivery", 0],
  ["Session Surveys", "Evaluation", 0],
  ["Testimonials (Written)", "Evaluation", 3],
  ["Videos (Participants – Testimonials)", "Evaluation", 3],
  ["Tracking of Takeaway Activities / Workbook Completion / Submission", "Evaluation", 7],
  ["Daily Report", "Reporting", 0],
  ["Post-Event Report", "Reporting", 5],
  ["Weekly Report", "Reporting", 7],
  ["Distribution of Certificates of Completion", "Recognition", 7],
  ["Felicitation", "Recognition", 7],
];

// ---------------------------------------------------------------------
// Dates (plain calendar days, no time zones)
// ---------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, "0");
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDay = (s) => { if (!s) return null; const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
export const today = () => isoDay(new Date());
export const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return isoDay(d); };
export const fmtDay = (s, year = false) => (s ? parseDay(s).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) }) : "");
export const fmtH = (h) => `${Math.round(Number(h || 0) * 100) / 100} h`;
export const whenText = (n) => n == null ? "No Set Date" : n === 0 ? "On The Session Day" : `${Math.abs(n)} Day${Math.abs(n) === 1 ? "" : "s"} ${n < 0 ? "Before" : "After"}`;
// Every day from..to, skipping Sat/Sun unless weekends count
export function workDays(from, to, weekends = false) {
  const out = [];
  if (!from || !to || to < from) return out;
  for (let d = parseDay(from); isoDay(d) <= to; d.setDate(d.getDate() + 1)) {
    if (weekends || (d.getDay() !== 0 && d.getDay() !== 6)) out.push(isoDay(d));
  }
  return out;
}
export const isOpen = (t) => t.status !== "Done" && t.status !== "N/A";
export const isOverdue = (t) => isOpen(t) && t.due_date && t.due_date < today();

// The Technical Training team: anyone who can own a task
export async function loadTeam() {
  const { data } = await sb.from("profiles").select("id, full_name, role").in("role", ["admin", "ld"]).eq("is_active", true).order("full_name");
  return data ?? [];
}

// =====================================================================
// The tab
// =====================================================================
const view = { status: "", owner: "" };
// The Tasks & Hours page opens a program's tab already filtered
export const setTaskView = (v) => { view.status = v.status ?? ""; view.owner = v.owner ?? ""; };

export async function tasksTab(area, program, reload) {
  area.innerHTML = '<div class="empty"><div>Loading…</div></div>';
  const [{ data: tasks, error }, { data: time }, team] = await Promise.all([
    sb.from("program_tasks").select("*").eq("program_id", program.id).order("due_date", { ascending: true, nullsFirst: false }).order("created_at"),
    sb.from("task_time").select("task_id, total_hours").eq("program_id", program.id),
    loadTeam(),
  ]);
  if (error) { area.innerHTML = `<div class="empty"><div><strong>Couldn't Load Tasks</strong>${esc(error.message)}</div></div>`; return; }
  const session = program.task_session_date ?? program.start_date ?? null;
  const name = Object.fromEntries(team.map((p) => [p.id, p.full_name]));
  const hours = {};
  for (const t of time ?? []) hours[t.task_id] = (hours[t.task_id] ?? 0) + Number(t.total_hours);
  const redraw = () => tasksTab(area, program, reload);

  const sessionField = `<label class="field" style="max-width:220px">Session Date
      <input class="input" type="date" data-session value="${esc(session ?? "")}">
      <span class="hint">Checklist due dates count from this.</span></label>`;

  if (!tasks.length) {
    area.innerHTML = `
      <div class="card" style="text-align:center;padding:28px 18px">
        <h2 style="margin:0 0 6px">Add This Program's Tasks</h2>
        <p class="muted" style="max-width:540px;margin:0 auto 14px">List the deliverables for ${esc(program.title)} and who owns each one. Start from the Technical Training checklist, or add your own.</p>
        <div style="display:flex;justify-content:center;margin-bottom:14px;text-align:left">${sessionField}</div>
        <button class="btn primary" data-checklist>Add From Checklist</button>
        <button class="btn" data-add>${icons.plus} Add Task</button>
      </div>`;
  } else {
    const shown = tasks.filter((t) =>
      (!view.status || (view.status === "open" ? isOpen(t) : view.status === "overdue" ? isOverdue(t) : t.status === view.status)) &&
      (!view.owner || (view.owner === "none" ? !t.owner_id : t.owner_id === view.owner)));
    const total = Object.values(hours).reduce((a, b) => a + b, 0);
    const done = tasks.filter((t) => t.status === "Done").length;
    const overdue = tasks.filter(isOverdue).length;
    area.innerHTML = `
      <div class="tab-head">
        <div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap">
          ${sessionField}
          <p class="muted" style="margin:0 0 6px">${done} of ${tasks.length} done${overdue ? ` · <b style="color:var(--crit-ink)">${overdue} overdue</b>` : ""} · ${fmtH(total)} logged</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" data-checklist>Add From Checklist</button>
          <button class="btn primary" data-add>${icons.plus} Add Task</button>
        </div>
      </div>
      <div class="toolbar">
        <select class="select" data-v="status" aria-label="Status">
          <option value="">All Tasks</option><option value="open">Open (Not Done)</option><option value="overdue">Overdue</option>
          ${TASK_STATUS.map((s) => `<option>${s}</option>`).join("")}
        </select>
        <select class="select" data-v="owner" aria-label="Owner">
          <option value="">Everyone</option><option value="none">Unassigned</option>
          ${team.map((p) => `<option value="${p.id}">${esc(p.full_name)}</option>`).join("")}
        </select>
        <span class="count">${shown.length} of ${tasks.length}</span>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Task</th><th>Category</th><th>Owner</th><th>Due</th><th>Status</th><th>Hours</th><th></th></tr></thead>
        <tbody>${shown.map((t) => `<tr>
          <td class="name"><button class="link-btn dark" style="text-align:left" data-edit="${t.id}"><strong>${esc(t.title)}</strong></button>
            ${t.details ? `<span style="display:block">${esc(t.details.length > 90 ? `${t.details.slice(0, 90)}…` : t.details)}</span>` : ""}</td>
          <td>${esc(t.category)}</td>
          <td>${t.owner_id ? esc(name[t.owner_id] ?? "Former Member") : '<span class="muted">Unassigned</span>'}</td>
          <td style="white-space:nowrap">${t.due_date ? esc(fmtDay(t.due_date)) : '<span class="muted">No Date</span>'}${isOverdue(t) ? ' <span class="pill crit">Overdue</span>' : ""}</td>
          <td><select class="select" data-status="${t.id}" style="min-width:128px">${TASK_STATUS.map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select></td>
          <td>${fmtH(hours[t.id] ?? 0)}</td>
          <td class="actions"><button class="btn sm" data-time="${t.id}">${icons.clock} Log Time</button></td>
        </tr>`).join("") || '<tr><td colspan="7" class="muted">No tasks match.</td></tr>'}</tbody>
      </table></div>`;
    area.querySelector('[data-v="status"]').value = view.status;
    area.querySelector('[data-v="owner"]').value = view.owner;
    area.querySelectorAll("[data-v]").forEach((el) => el.addEventListener("change", () => { view[el.dataset.v] = el.value; redraw(); }));
  }

  area.querySelector("[data-session]").addEventListener("change", async (e) => {
    const value = e.target.value || null;
    const { error: err } = await sb.from("programs").update({ task_session_date: value }).eq("id", program.id);
    if (err) return toast(err.message, "err");
    program.task_session_date = value;
    const movable = tasks.filter((t) => t.offset_days != null && isOpen(t));
    if (value && movable.length) {
      openModal({
        title: "Move Checklist Due Dates?",
        intro: `${movable.length} open checklist task${movable.length === 1 ? "" : "s"} can move to match the new session date. Tasks you added yourself, and done tasks, stay as they are.`,
        body: "",
        submitLabel: "Move Due Dates",
        cancelLabel: "Keep Dates",
        onSubmit: async () => {
          await Promise.all(movable.map((t) => sb.from("program_tasks").update({ due_date: addDays(value, t.offset_days) }).eq("id", t.id)));
          toast("Due dates updated.");
          redraw();
        },
      });
    } else toast("Session date saved.");
  });
  area.querySelector("[data-checklist]").addEventListener("click", () => addFromChecklist(program, tasks, team, redraw));
  area.querySelector("[data-add]").addEventListener("click", () => editTask(program, null, team, redraw));
  area.querySelector("tbody")?.addEventListener("click", (e) => {
    const ed = e.target.closest("[data-edit]");
    const tm = e.target.closest("[data-time]");
    if (ed) editTask(program, tasks.find((t) => t.id === ed.dataset.edit), team, redraw);
    if (tm) openTimeLog(tasks.find((t) => t.id === tm.dataset.time), program, team, redraw);
  });
  area.querySelector("tbody")?.addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-status]");
    if (!sel) return;
    const { error: err } = await sb.from("program_tasks").update({ status: sel.value }).eq("id", sel.dataset.status);
    if (err) return toast(err.message, "err");
    toast(`Status: ${sel.value}`);
    redraw();
  });
}

// ---------------------------------------------------------------------
// Add from checklist
// ---------------------------------------------------------------------
function addFromChecklist(program, tasks, team, redraw) {
  const session = program.task_session_date ?? program.start_date ?? null;
  const have = new Set(tasks.map((t) => t.title.trim().toLowerCase()));
  const cats = [...new Set(CHECKLIST.map((c) => c[1]))];
  const ownerSel = (i) => `<select class="select" data-owner="${i}" style="min-width:130px"><option value="">Unassigned</option>${team.map((p) => `<option value="${p.id}">${esc(p.full_name)}</option>`).join("")}</select>`;
  const { form } = openModal({
    title: "Add From Checklist",
    intro: session
      ? `Session Date <b>${esc(fmtDay(session, true))}</b>. Untick anything this program doesn't need. Owners can be set now or later.`
      : "No session date yet, so these tasks start without due dates. Set the Session Date on the Tasks tab to fill them in.",
    wide: true,
    body: `<div class="table-wrap" style="max-height:52vh"><table class="data">
      <thead><tr><th>Activity</th><th>When</th><th>Due</th><th>Owner</th></tr></thead>
      <tbody>${cats.map((cat) => `
        <tr><td colspan="4" style="background:var(--surface-2);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2)">
          <label class="check" style="margin:0"><input type="checkbox" data-cat="${esc(cat)}" checked> ${esc(cat)}</label></td></tr>
        ${CHECKLIST.map((c, i) => [c, i]).filter(([c]) => c[1] === cat).map(([[title, , off], i]) => {
          const added = have.has(title.toLowerCase());
          return `<tr>
            <td><label class="check" style="margin:0"><input type="checkbox" data-i="${i}" data-in="${esc(cat)}" ${added ? "disabled" : "checked"}> ${esc(title)}</label>
              ${added ? '<span class="pill good" style="margin-left:6px">Already Added</span>' : ""}</td>
            <td class="muted small" style="white-space:nowrap">${whenText(off)}</td>
            <td style="white-space:nowrap"><b>${session && off != null ? esc(fmtDay(addDays(session, off))) : "—"}</b></td>
            <td>${added ? "" : ownerSel(i)}</td></tr>`;
        }).join("")}`).join("")}</tbody></table></div>`,
    submitLabel: "Add Tasks",
    onSubmit: async (f) => {
      const picked = [...f.querySelectorAll("input[data-i]:checked:not(:disabled)")].map((el) => Number(el.dataset.i));
      if (!picked.length) throw new Error("Tick at least one activity.");
      const rows = picked.map((i) => {
        const [title, category, off] = CHECKLIST[i];
        return { program_id: program.id, title, category, offset_days: off, due_date: session && off != null ? addDays(session, off) : null,
          owner_id: f.querySelector(`[data-owner="${i}"]`)?.value || null };
      });
      const { error } = await sb.from("program_tasks").insert(rows);
      if (error) throw error;
      toast(`${rows.length} task${rows.length === 1 ? "" : "s"} added.`);
      redraw();
    },
  });
  const btn = form.querySelector('[type="submit"]');
  const sync = () => {
    const n = form.querySelectorAll("input[data-i]:checked:not(:disabled)").length;
    btn.textContent = n ? `Add ${n} Task${n === 1 ? "" : "s"}` : "Add Tasks";
  };
  form.addEventListener("change", (e) => {
    if (e.target.dataset.cat) form.querySelectorAll(`input[data-in="${CSS.escape(e.target.dataset.cat)}"]:not(:disabled)`).forEach((c) => { c.checked = e.target.checked; });
    sync();
  });
  sync();
}

// ---------------------------------------------------------------------
// Add / edit one task
// ---------------------------------------------------------------------
function editTask(program, task, team, redraw) {
  const t = task ?? { category: "Other", status: "Not Started" };
  const { form } = openModal({
    title: task ? "Edit Task" : "Add Task",
    body: `
      <label class="field">Task <input class="input" name="title" maxlength="300" value="${esc(t.title ?? "")}" placeholder="e.g. Book training room for Day 2"></label>
      <div class="two">
        <label class="field">Category <select class="select" name="category">${TASK_CATS.map((c) => `<option ${c === t.category ? "selected" : ""}>${c}</option>`).join("")}</select></label>
        <label class="field">Owner <select class="select" name="owner"><option value="">Unassigned</option>${team.map((p) => `<option value="${p.id}" ${p.id === t.owner_id ? "selected" : ""}>${esc(p.full_name)}</option>`).join("")}</select>
          <span class="hint">Anyone in the Technical Training team</span></label>
      </div>
      <div class="two">
        <label class="field">Due Date <input class="input" type="date" name="due" value="${esc(t.due_date ?? "")}"></label>
        <label class="field">Status <select class="select" name="status">${TASK_STATUS.map((s) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      </div>
      <label class="field">Details / Requirements <span class="hint">(Optional)</span>
        <textarea class="input prose short" name="details">${esc(t.details ?? "")}</textarea></label>
      ${task ? '<div><button type="button" class="btn sm ghost danger" data-del>Delete Task</button></div>' : ""}`,
    submitLabel: task ? "Save Task" : "Add Task",
    onSubmit: async (f) => {
      const title = f.title.value.trim();
      if (!title) throw new Error("Please name the task.");
      const row = { title, category: f.category.value, owner_id: f.owner.value || null, due_date: f.due.value || null,
        status: f.status.value, details: f.details.value.trim() || null };
      // A date changed by hand no longer follows the session date
      if (task && task.due_date !== row.due_date) row.offset_days = null;
      const { error } = task
        ? await sb.from("program_tasks").update(row).eq("id", task.id)
        : await sb.from("program_tasks").insert({ ...row, program_id: program.id });
      if (error) throw error;
      toast(task ? "Task saved." : "Task added.");
      redraw();
    },
  });
  form.querySelector("[data-del]")?.addEventListener("click", () => {
    form.closest(".modal-backdrop").remove();
    openModal({
      title: "Delete This Task?",
      intro: `"${esc(task.title)}" and the time logged against it will be removed. This can't be undone.`,
      body: "",
      submitLabel: "Delete Task",
      danger: true,
      onSubmit: async () => {
        const { error } = await sb.from("program_tasks").delete().eq("id", task.id);
        if (error) throw error;
        toast("Task deleted.");
        redraw();
      },
    });
  });
}

// ---------------------------------------------------------------------
// Time spent on a task
// ---------------------------------------------------------------------
export async function openTimeLog(task, program, team, onChange) {
  const { data: entries } = await sb.from("task_time").select("*").eq("task_id", task.id).order("start_date");
  const { data: meRow } = await sb.from("profiles").select("id").eq("user_id", (await sb.auth.getUser()).data.user?.id ?? "").maybeSingle();
  const name = Object.fromEntries(team.map((p) => [p.id, p.full_name]));
  const total = (entries ?? []).reduce((a, e) => a + Number(e.total_hours), 0);
  const who = task.owner_id && name[task.owner_id] ? task.owner_id : meRow?.id;
  const { form, close } = openModal({
    title: "Time Spent",
    intro: `${esc(task.title)} · ${esc(program.title)}`,
    wide: true,
    body: `
      <div class="notice info">Log each stretch of work: <b>from</b> and <b>to</b> dates and the <b>hours per day</b>. Work spread over several days, a few hours a day, is one entry. Totals count Mon–Fri unless you tick Include Weekends.</div>
      <div class="two">
        <label class="field">Who Worked On It <select class="select" name="person">${team.map((p) => `<option value="${p.id}" ${p.id === who ? "selected" : ""}>${esc(p.full_name)}</option>`).join("")}</select></label>
        <label class="field">Hours Per Day <input class="input" type="number" name="hours" min="0.25" max="24" step="0.25" value="1"></label>
      </div>
      <div class="two">
        <label class="field">From <input class="input" type="date" name="from" value="${today()}"></label>
        <label class="field">To <input class="input" type="date" name="to" value="${today()}"></label>
      </div>
      <label class="field">Notes <span class="hint">(Optional)</span><input class="input" name="notes" maxlength="200" placeholder="e.g. drafting slides, venue calls"></label>
      <label class="check"><input type="checkbox" name="weekends"> Include Weekends</label>
      <div class="notice" data-sum style="background:var(--surface-2);color:var(--ink)"></div>
      <h3 class="section-title" style="margin:6px 0 0">Logged So Far · ${fmtH(total)}</h3>
      ${(entries ?? []).length ? `<div class="table-wrap" style="max-height:220px"><table class="data">
        <thead><tr><th>Person</th><th>Dates</th><th>Per Day</th><th>Days</th><th>Total</th><th>Notes</th><th></th></tr></thead>
        <tbody>${entries.map((e) => `<tr>
          <td>${esc(name[e.person_id] ?? "Former Member")}</td>
          <td style="white-space:nowrap">${esc(fmtDay(e.start_date))}${e.end_date !== e.start_date ? ` – ${esc(fmtDay(e.end_date))}` : ""}</td>
          <td>${fmtH(e.hours_per_day)}</td><td>${e.working_days}${e.include_weekends ? ' <span class="muted small">incl. weekends</span>' : ""}</td>
          <td><b>${fmtH(e.total_hours)}</b></td><td>${esc(e.notes ?? "")}</td>
          <td class="actions"><button type="button" class="btn sm ghost danger" data-del="${e.id}">Delete</button></td></tr>`).join("")}</tbody></table></div>`
        : '<p class="muted" style="margin:0">No time logged yet.</p>'}`,
    submitLabel: "Add Time",
    cancelLabel: "Done",
    onSubmit: async (f) => {
      const c = calc();
      if (!c) throw new Error("Please fix the dates and hours first.");
      const { error } = await sb.from("task_time").insert({
        task_id: task.id, program_id: program.id, person_id: f.person.value, start_date: c.from, end_date: c.to,
        hours_per_day: c.hours, include_weekends: f.weekends.checked, working_days: c.days.length,
        total_hours: Math.round(c.days.length * c.hours * 100) / 100, notes: f.notes.value.trim() || null,
      });
      if (error) throw error;
      toast(`${fmtH(c.days.length * c.hours)} logged for ${name[f.person.value] ?? "the team"}.`);
      onChange?.();
      setTimeout(() => openTimeLog(task, program, team, onChange), 0);
    },
  });
  const sum = form.querySelector("[data-sum]");
  function calc() {
    const from = form.from.value, to = form.to.value || from, hours = Number(form.hours.value);
    if (!from || to < from) { sum.innerHTML = '<span style="color:var(--crit-ink)">The "To" date must be on or after "From".</span>'; return null; }
    const days = workDays(from, to, form.weekends.checked);
    if (!days.length) { sum.innerHTML = '<span style="color:var(--crit-ink)">No working days in this range. Tick Include Weekends if you worked on a weekend.</span>'; return null; }
    if (!(hours > 0 && hours <= 24)) { sum.innerHTML = '<span style="color:var(--crit-ink)">Enter hours per day between 0.25 and 24.</span>'; return null; }
    sum.innerHTML = `<b>${days.length}</b> day${days.length === 1 ? "" : "s"} × <b>${fmtH(hours)}</b> per day = <b>${fmtH(days.length * hours)}</b> total`;
    return { from, to, hours, days };
  }
  form.addEventListener("input", calc);
  form.addEventListener("change", calc);
  calc();
  form.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (!del) return;
    del.disabled = true;
    sb.from("task_time").delete().eq("id", del.dataset.del).then(({ error }) => {
      if (error) { del.disabled = false; return toast(error.message, "err"); }
      toast("Time entry deleted.");
      close();
      onChange?.();
      openTimeLog(task, program, team, onChange);
    });
  });
}
