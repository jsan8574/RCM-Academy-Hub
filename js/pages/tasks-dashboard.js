// Tasks & Hours: the Technical Training team's deliverables and time across all programs.
// Every program name, bar and number opens that program's Tasks tab.
import { sb } from "../supabase.js";
import { esc, icons } from "../ui.js";
import { TASK_STATUS, HOURS_PER_DAY, isOpen, isOverdue, today, addDays, parseDay, isoDay, fmtDay, fmtH, workDays, setTaskView } from "./program-tasks.js";

const PERIODS = { week: "This Week", month: "This Month", year: "This Year", all: "All Time" };
const filters = { period: "month", program: "", person: "" };

function periodRange(p) {
  const t = parseDay(today());
  if (p === "week") { const s = new Date(t); s.setDate(t.getDate() - ((t.getDay() + 6) % 7)); const e = new Date(s); e.setDate(s.getDate() + 6); return [isoDay(s), isoDay(e)]; }
  if (p === "month") return [isoDay(new Date(t.getFullYear(), t.getMonth(), 1)), isoDay(new Date(t.getFullYear(), t.getMonth() + 1, 0))];
  if (p === "year") return [`${t.getFullYear()}-01-01`, `${t.getFullYear()}-12-31`];
  return [null, null];
}

export async function renderTasksDashboard(main) {
  main.innerHTML = `
    <header class="topbar">
      <div><h1>Tasks &amp; Hours</h1><p>The team's deliverables, deadlines and time across every program.</p></div>
      <div class="top-actions"><div class="seg seg-sm" role="group" aria-label="Period">
        ${Object.entries(PERIODS).map(([k, l]) => `<button type="button" data-period="${k}" class="${k === filters.period ? "on" : ""}">${l}</button>`).join("")}
      </div></div>
    </header>
    <div class="filter-bar"><span class="filter-label">${icons.filter}Filter</span><div class="filter-chips">
      <select class="chip-select" data-f="program" aria-label="Program"><option value="">All Programs</option></select>
      <select class="chip-select" data-f="person" aria-label="Person"><option value="">Everyone</option></select>
    </div></div>
    <div id="thd"><div class="empty"><div>Loading…</div></div></div>`;

  const [{ data: tasks, error }, { data: time }, { data: team }, { data: programs }] = await Promise.all([
    sb.from("program_tasks").select("*"),
    sb.from("task_time").select("*"),
    sb.from("profiles").select("id, full_name, role, is_active").in("role", ["admin", "ld"]).order("full_name"),
    sb.from("programs").select("id, title, status, start_date, task_session_date").neq("status", "archived").order("title"),
  ]);
  const box = main.querySelector("#thd");
  if (error) { box.innerHTML = `<div class="empty"><div><strong>Couldn't Load Tasks</strong>${esc(error.message)}</div></div>`; return; }
  const progName = Object.fromEntries((programs ?? []).map((p) => [p.id, p.title]));
  const name = Object.fromEntries((team ?? []).map((p) => [p.id, p.full_name]));
  const usedPrograms = (programs ?? []).filter((p) => tasks.some((t) => t.program_id === p.id) || (time ?? []).some((e) => e.program_id === p.id));
  const progSel = main.querySelector('[data-f="program"]');
  progSel.insertAdjacentHTML("beforeend", usedPrograms.map((p) => `<option value="${p.id}">${esc(p.title)}</option>`).join(""));
  const personSel = main.querySelector('[data-f="person"]');
  personSel.insertAdjacentHTML("beforeend", (team ?? []).filter((p) => p.is_active).map((p) => `<option value="${p.id}">${esc(p.full_name)}</option>`).join("") + '<option value="none">Unassigned</option>');
  if (!usedPrograms.some((p) => p.id === filters.program)) filters.program = "";
  progSel.value = filters.program;
  personSel.value = filters.person;

  const draw = () => {
    const [from, to] = periodRange(filters.period);
    const inRange = (d) => (!from || d >= from) && (!to || d <= to);
    const T = tasks.filter((t) => progName[t.program_id] !== undefined &&
      (!filters.program || t.program_id === filters.program) &&
      (!filters.person || (filters.person === "none" ? !t.owner_id : t.owner_id === filters.person)));
    const E = (time ?? []).filter((e) => progName[e.program_id] !== undefined &&
      (!filters.program || e.program_id === filters.program) &&
      (!filters.person || e.person_id === filters.person));
    // Hours fall on the days they were worked, so a period only counts its own days
    const hoursOf = (e) => workDays(e.start_date, e.end_date, e.include_weekends).filter(inRange).length * Number(e.hours_per_day);
    const byProgramH = {}, byPersonH = {};
    let totalH = 0;
    for (const e of E) {
      const h = hoursOf(e);
      if (!h) continue;
      totalH += h;
      byProgramH[e.program_id] = (byProgramH[e.program_id] ?? 0) + h;
      if (e.person_id) byPersonH[e.person_id] = (byPersonH[e.person_id] ?? 0) + h;
    }
    const open = T.filter(isOpen);
    const overdue = T.filter(isOverdue);
    const doneIn = T.filter((t) => t.status === "Done" && t.completed_at && inRange(isoDay(new Date(t.completed_at))));
    const dueIn = T.filter((t) => t.due_date && inRange(t.due_date));
    // Capacity: working days so far in the period (or since the first entry, for All Time)
    const capFrom = from ?? (E.length ? E.map((e) => e.start_date).sort()[0] : today());
    const capTo = to && to < today() ? to : today();
    const capDays = workDays(capFrom, capTo).length || 1;
    const people = (team ?? []).filter((p) => p.is_active && (!filters.person || p.id === filters.person));
    const util = people.map((p) => ({ p, h: byPersonH[p.id] ?? 0, pct: Math.round(((byPersonH[p.id] ?? 0) / (capDays * HOURS_PER_DAY)) * 100) }))
      .sort((a, b) => b.h - a.h);
    const teamPct = people.length ? Math.round((totalH / (capDays * HOURS_PER_DAY * people.length)) * 100) : 0;

    // Needs attention: each owner's overdue, due in the next 7 days, and blocked tasks
    const soon = addDays(today(), 7);
    const att = [];
    const owners = [...new Set(open.map((t) => t.owner_id ?? "none"))];
    for (const o of owners) {
      const mine = open.filter((t) => (t.owner_id ?? "none") === o);
      const who = o === "none" ? "Unassigned" : name[o] ?? "Former Member";
      const od = mine.filter(isOverdue), bl = mine.filter((t) => t.status === "Blocked" && !isOverdue(t)),
        up = mine.filter((t) => t.due_date && t.due_date >= today() && t.due_date <= soon && t.status !== "Blocked");
      for (const [list, kind] of [[od, "crit"], [bl, "crit"], [up, "warn"]]) {
        for (const t of list) att.push({ t, who, kind, label: list === od ? "Overdue" : list === bl ? "Blocked" : `Due ${fmtDay(t.due_date)}`, rank: list === od ? 0 : list === bl ? 1 : 2 });
      }
    }
    att.sort((a, b) => a.rank - b.rank || (a.t.due_date ?? "").localeCompare(b.t.due_date ?? ""));
    const shownAtt = att.slice(0, 12);

    const maxProg = Math.max(1, ...Object.values(byProgramH));
    const progRows = usedPrograms.filter((p) => !filters.program || p.id === filters.program).map((p) => {
      const mine = T.filter((t) => t.program_id === p.id);
      const c = Object.fromEntries(TASK_STATUS.map((s) => [s, mine.filter((t) => t.status === s).length]));
      return { p, c, total: mine.length, overdue: mine.filter(isOverdue).length, h: byProgramH[p.id] ?? 0 };
    }).filter((r) => r.total || r.h);
    const go = (pid, status = "", owner = "") => `data-go="${pid}" data-status="${status}" data-owner="${owner}"`;
    const pct = (n) => `${Math.max(0, Math.min(100, n))}%`;

    box.innerHTML = `
      <div class="kpi-grid">
        <button class="card kpi thd-kpi" data-kpi="open"><span class="label">Open Tasks</span><b>${open.length}</b><span class="muted small">across ${new Set(open.map((t) => t.program_id)).size} program${new Set(open.map((t) => t.program_id)).size === 1 ? "" : "s"}</span></button>
        <button class="card kpi thd-kpi ${overdue.length ? "warn" : ""}" data-kpi="overdue"><span class="label">Overdue</span><b style="${overdue.length ? "color:var(--crit-ink)" : ""}">${overdue.length}</b><span class="muted small">past their due date</span></button>
        <div class="card kpi"><span class="label">Done ${esc(PERIODS[filters.period])}</span><b>${doneIn.length}</b><span class="muted small">${filters.period === "all" ? "tasks finished" : `of ${dueIn.length} due in this period`}</span></div>
        <div class="card kpi"><span class="label">Hours Logged</span><b>${fmtH(totalH)}</b><span class="muted small">${people.length ? `utilization ${teamPct}% (${HOURS_PER_DAY} h/day, Mon–Fri)` : ""}</span></div>
      </div>

      <section class="card" style="margin-top:12px">
        <h2 class="section-title">Needs Attention</h2>
        ${shownAtt.length ? `<div class="att-list">${shownAtt.map((a) => `
          <a class="att-item" href="#/programs/${a.t.program_id}/tasks" ${go(a.t.program_id, a.label === "Overdue" ? "overdue" : a.label === "Blocked" ? "Blocked" : "open", a.t.owner_id ?? "none")}>
            <span class="att-dot ${a.kind}">${a.rank === 1 ? icons.flag : icons.clock}</span>
            <span class="att-text"><strong>${esc(a.t.title)}</strong><span>${esc(a.who)} · ${esc(progName[a.t.program_id])}</span></span>
            <span class="pill ${a.kind}">${esc(a.label)}</span>
          </a>`).join("")}</div>${att.length > shownAtt.length ? `<p class="muted small" style="margin:8px 0 0">+ ${att.length - shownAtt.length} more in the table below</p>` : ""}`
          : `<div class="all-clear"><span>${icons.check}</span><div><strong>All Clear</strong><span class="muted small">No overdue, blocked or due-this-week tasks.</span></div></div>`}
      </section>

      <div class="thd-two" style="margin-top:12px">
        <section class="card"><h2 class="section-title">Hours By Program</h2>
          ${Object.keys(byProgramH).length ? `<div class="thd-bars">${progRows.filter((r) => r.h).sort((a, b) => b.h - a.h).map((r) => `
            <a class="thd-bar" href="#/programs/${r.p.id}/tasks" ${go(r.p.id)}><span>${esc(r.p.title)}</span><i><b style="width:${pct((r.h / maxProg) * 100)}"></b></i><em>${fmtH(r.h)}</em></a>`).join("")}</div>`
            : '<p class="muted" style="margin:0">No time logged in this period. Use Log Time on any task.</p>'}
        </section>
        <section class="card"><h2 class="section-title">Team Utilization</h2>
          ${util.length ? `<div class="thd-bars">${util.map((u) => `
            <button type="button" class="thd-bar" data-person="${u.p.id}" title="Show only ${esc(u.p.full_name)}"><span>${esc(u.p.full_name)}</span><i><b class="${u.pct > 100 ? "over" : ""}" style="width:${pct(u.pct)}"></b></i><em>${u.pct}% · ${fmtH(u.h)}</em></button>`).join("")}</div>
            <p class="muted small" style="margin:8px 0 0">Hours logged ÷ (${capDays} working day${capDays === 1 ? "" : "s"} so far × ${HOURS_PER_DAY} h).</p>`
            : '<p class="muted" style="margin:0">No team members yet.</p>'}
        </section>
      </div>

      <h2 class="section-title" style="margin-top:18px">Task Status By Program</h2>
      ${progRows.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Program</th>${TASK_STATUS.map((s) => `<th>${s}</th>`).join("")}<th>Overdue</th><th>Hours ${esc(PERIODS[filters.period])}</th></tr></thead>
        <tbody>${progRows.map((r) => `<tr>
          <td><a class="link-btn dark" href="#/programs/${r.p.id}/tasks" ${go(r.p.id)}><b>${esc(r.p.title)}</b></a></td>
          ${TASK_STATUS.map((s) => `<td>${r.c[s] ? `<a class="link-btn dark" href="#/programs/${r.p.id}/tasks" ${go(r.p.id, s)}>${r.c[s]}</a>` : '<span class="muted">0</span>'}</td>`).join("")}
          <td>${r.overdue ? `<a href="#/programs/${r.p.id}/tasks" ${go(r.p.id, "overdue")}><span class="pill crit">${r.overdue}</span></a>` : '<span class="muted">0</span>'}</td>
          <td>${fmtH(r.h)}</td></tr>`).join("")}</tbody></table></div>`
        : '<div class="empty"><div><strong>No Tasks Yet</strong>Open a program and use its Tasks tab to add the team\'s deliverables.</div></div>'}`;
  };

  // Clicking through to a program opens its Tasks tab with the same filter
  box.addEventListener("click", (e) => {
    const g = e.target.closest("[data-go]");
    if (g) setTaskView({ status: g.dataset.status, owner: g.dataset.owner || (filters.person || "") });
    const p = e.target.closest("[data-person]");
    if (p) { filters.person = p.dataset.person; personSel.value = filters.person; draw(); }
    const k = e.target.closest("[data-kpi]");
    if (k) {
      const list = (k.dataset.kpi === "overdue" ? tasks.filter(isOverdue) : tasks.filter(isOpen))
        .filter((t) => (!filters.program || t.program_id === filters.program));
      const first = list[0];
      if (filters.program || (first && list.every((t) => t.program_id === first.program_id))) {
        setTaskView({ status: k.dataset.kpi, owner: filters.person });
        location.hash = `#/programs/${filters.program || first.program_id}/tasks`;
      } else {
        main.querySelector(".thd-two")?.previousElementSibling?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  });
  main.querySelectorAll("[data-period]").forEach((b) => b.addEventListener("click", () => {
    filters.period = b.dataset.period;
    main.querySelectorAll("[data-period]").forEach((x) => x.classList.toggle("on", x === b));
    draw();
  }));
  main.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("change", () => { filters[el.dataset.f] = el.value; draw(); }));
  draw();
}
