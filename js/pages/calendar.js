// Calendar: every program's live sessions, start and due dates, and step deadlines, by month.
// Clicking an item opens the program. On a phone the month shows as a list of days.
import { sb } from "../supabase.js";
import { esc, openModal, PROGRAM_STATUS, isProject } from "../ui.js";

const filters = { status: "current", client: "", show: "all" };
const MAX_IN_CELL = 3;
const KIND = {
  session: { label: "Live Session", cls: "session" },
  start:   { label: "Starts", cls: "start" },
  due:     { label: "Program Due", cls: "due" },
  stepdue: { label: "Step Due", cls: "stepdue" },
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeText = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export async function renderCalendar(main, ctx) {
  // #/calendar/2026-11 → that month; otherwise this month
  const m = /^(\d{4})-(\d{2})$/.exec(ctx.params[0] ?? "");
  const today = new Date();
  const month = m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : new Date(today.getFullYear(), today.getMonth(), 1);
  const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const go = (offset) => { location.hash = `#/calendar/${ym(new Date(month.getFullYear(), month.getMonth() + offset, 1))}`; };

  main.innerHTML = `
    <header class="topbar">
      <div><h1>Calendar</h1><p>Live sessions, start and due dates for all programs. Click an item to open the program.</p></div>
      <div class="top-actions">
        <button class="btn" data-go="-1" aria-label="Previous month">‹</button>
        <button class="btn" data-go="today">Today</button>
        <button class="btn" data-go="1" aria-label="Next month">›</button>
      </div>
    </header>
    <div class="toolbar">
      <h2 class="cal-month">${esc(month.toLocaleDateString(undefined, { month: "long", year: "numeric" }))}</h2>
      <select class="select" data-f="show">
        <option value="all">All Dates</option>
        <option value="session">Live Sessions Only</option>
      </select>
      <select class="select" data-f="status">
        <option value="current">Not Archived</option>
        ${Object.entries(PROGRAM_STATUS).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join("")}
        <option value="">All</option>
      </select>
      <select class="select" data-f="client" hidden><option value="">All Clients / Groups</option></select>
      <span class="count"></span>
    </div>
    <div class="cal-legend">${Object.values(KIND).map((k) => `<span><i class="cal-dot ${k.cls}"></i>${k.label}</span>`).join("")}</div>
    <div id="cal"><div class="empty"><div>Loading…</div></div></div>`;

  main.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.go === "today") location.hash = `#/calendar/${ym(today)}`;
    else go(Number(b.dataset.go));
  }));

  const { data: programs, error } = await sb.from("programs")
    .select("id, title, program_type, client, status, start_date, due_date, program_steps(id, title, step_type, session_start, session_end, due_at)");
  const box = main.querySelector("#cal");
  if (!box.isConnected) return;
  if (error) {
    box.innerHTML = `<div class="empty"><div><strong>Couldn't Load The Calendar</strong>${esc(error.message)}</div></div>`;
    return;
  }

  // Client / Group filter from what's been typed on programs
  const clients = [...new Set(programs.map((p) => (p.client ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const clientSel = main.querySelector('[data-f="client"]');
  if (clients.length) {
    clientSel.insertAdjacentHTML("beforeend", clients.map((c) => `<option>${esc(c)}</option>`).join(""));
    clientSel.hidden = false;
  }
  if (!clients.includes(filters.client)) filters.client = "";
  for (const k of Object.keys(filters)) main.querySelector(`[data-f="${k}"]`).value = filters[k];

  // Every dated item, keyed by local day
  const allItems = [];
  for (const p of programs) {
    const open = `#/programs/${p.id}`;
    const base = { program: p.title, client: p.client, status: p.status };
    if (p.start_date) allItems.push({ ...base, kind: "start", day: p.start_date, sort: "~0", title: p.title, sub: isProject(p) ? "Project starts" : "Program starts", href: open });
    if (p.due_date) allItems.push({ ...base, kind: "due", day: p.due_date, sort: "~1", title: p.title, sub: isProject(p) ? "Project due" : "Program due", href: open });
    for (const s of p.program_steps ?? []) {
      if (s.step_type === "ilt_session" && s.session_start) {
        const a = new Date(s.session_start);
        const b = s.session_end ? new Date(s.session_end) : null;
        allItems.push({ ...base, kind: "session", day: dayKey(a), sort: a.toISOString(), time: `${timeText(a)}${b ? ` – ${timeText(b)}` : ""}`,
          title: s.title, sub: p.title, href: `${open}/journey` });
      } else if (s.due_at) {
        const d = new Date(s.due_at);
        allItems.push({ ...base, kind: "stepdue", day: dayKey(d), sort: d.toISOString(), time: timeText(d), title: s.title, sub: `Due · ${p.title}`, href: `${open}/journey` });
      }
    }
  }

  const draw = () => {
    const items = allItems.filter((i) =>
      (filters.status === "" || (filters.status === "current" ? i.status !== "archived" : i.status === filters.status)) &&
      (!filters.client || (i.client ?? "").trim() === filters.client) &&
      (filters.show === "all" || i.kind === "session"));
    const byDay = {};
    for (const i of items) (byDay[i.day] ??= []).push(i);
    for (const list of Object.values(byDay)) list.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));

    // Weeks from the Sunday on or before the 1st to the Saturday on or after the last day
    const first = new Date(month);
    first.setDate(1 - first.getDay());
    const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
    last.setDate(last.getDate() + (6 - last.getDay()));
    const days = [];
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) days.push(new Date(d));

    const inMonth = (d) => d.getMonth() === month.getMonth();
    const monthDays = days.filter(inMonth).map(dayKey);
    const sessions = monthDays.reduce((n, k) => n + (byDay[k] ?? []).filter((i) => i.kind === "session").length, 0);
    main.querySelector(".count").textContent = `${sessions} live session${sessions === 1 ? "" : "s"} this month`;

    const chip = (i) => `
      <a class="cal-item ${KIND[i.kind].cls}" href="${esc(i.href)}" title="${esc([i.time, i.title, i.sub].filter(Boolean).join(" · "))}">
        ${i.time ? `<b>${esc(i.time.split(" – ")[0])}</b> ` : ""}${esc(i.title)}${i.kind === "stepdue" ? "" : `<small>${esc(i.sub)}</small>`}
      </a>`;
    const todayKey = dayKey(today);

    const grid = `
      <div class="cal-grid" role="grid">
        ${WEEKDAYS.map((w) => `<div class="cal-head" role="columnheader">${w}</div>`).join("")}
        ${days.map((d) => {
          const k = dayKey(d);
          const list = byDay[k] ?? [];
          const more = list.length - MAX_IN_CELL;
          return `
            <div class="cal-cell${inMonth(d) ? "" : " other"}${k === todayKey ? " today" : ""}" role="gridcell">
              <span class="cal-num">${d.getDate()}</span>
              ${list.slice(0, more > 0 ? MAX_IN_CELL - 1 : MAX_IN_CELL).map(chip).join("")}
              ${more > 0 ? `<button class="cal-more" data-day="${k}">+${more + 1} More</button>` : ""}
            </div>`;
        }).join("")}
      </div>`;

    // Phone: the month's days that have something, as a list
    const agendaDays = monthDays.filter((k) => byDay[k]?.length);
    const agenda = `
      <div class="cal-agenda">
        ${agendaDays.length ? agendaDays.map((k) => dayBlock(k, byDay[k], k === todayKey)).join("")
          : '<div class="empty"><div><strong>Nothing This Month</strong>No sessions or dates match the filters.</div></div>'}
      </div>`;

    box.innerHTML = grid + agenda;
    box.querySelectorAll("[data-day]").forEach((b) => b.addEventListener("click", () => showDay(b.dataset.day, byDay[b.dataset.day])));
  };

  main.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("input", () => { filters[el.dataset.f] = el.value; draw(); }));
  draw();
}

function dayLabel(k) {
  const [y, mo, d] = k.split("-").map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

function dayBlock(k, list, isToday = false) {
  return `
    <section class="cal-day${isToday ? " today" : ""}">
      <h3>${esc(dayLabel(k))}${isToday ? ' <span class="pill teal">Today</span>' : ""}</h3>
      ${list.map((i) => `
        <a class="cal-row ${KIND[i.kind].cls}" href="${esc(i.href)}">
          <i class="cal-dot ${KIND[i.kind].cls}"></i>
          <span class="cal-when">${esc(i.time ?? KIND[i.kind].label)}</span>
          <span><strong>${esc(i.title)}</strong><small>${esc(i.sub)}</small></span>
        </a>`).join("")}
    </section>`;
}

function showDay(k, list) {
  const { form, close } = openModal({ title: dayLabel(k), body: dayBlock(k, list).replace(/<h3>.*?<\/h3>/s, ""), submitLabel: "", cancelLabel: "Close" });
  form.addEventListener("click", (e) => { if (e.target.closest("a[href]")) close(); });
}
