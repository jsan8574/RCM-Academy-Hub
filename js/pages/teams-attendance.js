// Teams attendance reports for Live Session steps.
// Upload the report downloaded from Microsoft Teams (Excel or CSV): enrolled
// learners present for 75% or more of the session are marked attended. Everyone in the report
// is kept, so a joiner who isn't enrolled is marked attended as soon as they're
// enrolled. Joiners who aren't enrolled never count toward completion.
import { sb } from "../supabase.js";
import { esc, toast, openModal, icons, fmtDateTime, LIBS, loadScript, safeName } from "../ui.js";

// Attendance is judged on the share of the session someone stayed for
export const PRESENT_PCT = 75;
const TIERS = [
  [75, "present", "Present", "good"],
  [25, "partial", "Partial Attendance", "warn"],
  [10, "brief", "Absent · Joined Briefly", "crit"],
  [0, "low", "Absent · Under 10%", "crit"],
];
const STATUS = {
  present: ["Present", "good"],
  partial: ["Partial Attendance", "warn"],
  brief: ["Absent · Joined Briefly", "crit"],
  low: ["Absent · Under 10%", "crit"],
  absent: ["Absent · Did Not Join", "crit"],
  not_enrolled: ["Not Listed As Enrolled", "prog"],
  staff: ["Organizer / Staff (Not Counted)", ""],
};
export const fmtMin = (m) => {
  const n = Math.round(Number(m) || 0);
  return n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n}m`;
};
// Session length is kept as the "present" threshold (75% of it)
const lengthFrom = (required) => Number(required) / (PRESENT_PCT / 100);
export const pctOf = (minutes, length) => (length > 0 ? Math.min(100, Math.round((Number(minutes) / length) * 100)) : 0);
export function tierOf(minutes, required) {
  const pct = pctOf(minutes, lengthFrom(required));
  const [, kind, label, cls] = TIERS.find(([min]) => pct >= min);
  return { pct, kind, label, cls };
}

// ---------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------
function parseCsv(text) {
  const first = text.split(/\r?\n/, 40).find((l) => /name/i.test(l)) ?? "";
  const sep = first.includes("\t") ? "\t" : first.split(";").length > first.split(",").length ? ";" : ",";
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function readRows(file) {
  if (/\.xlsx?$/i.test(file.name)) {
    await loadScript(LIBS.xlsx);
    const wb = window.XLSX.read(await file.arrayBuffer(), { cellDates: true });
    return wb.SheetNames.flatMap((n) => window.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: "" }).concat([[]]));
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Teams saves its CSV as UTF-16 with tabs
  const enc = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  return parseCsv(new TextDecoder(enc).decode(bytes).replace(/^﻿/, ""));
}

// "2h 18m 9s", "30m 39s", "1h 25m", "01:18:09" → minutes
function minutesOf(v) {
  if (typeof v === "number") return v < 1 ? v * 1440 : v;
  const s = String(v ?? "").trim();
  const hms = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hms) return Number(hms[1]) * 60 + Number(hms[2]) + Number(hms[3] ?? 0) / 60;
  const part = (re) => Number(s.match(re)?.[1] ?? 0);
  return part(/(\d+)\s*h/i) * 60 + part(/(\d+)\s*m(?!s)/i) + part(/(\d+)\s*s/i) / 60;
}

// "11/10/26, 11:01:37 PM" (month first, or day first when the first number is over 12)
function dateOf(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i);
  if (m) {
    let [, a, b, y, h, mi, se, ap] = m;
    let mo = Number(a), d = Number(b);
    if (mo > 12) [mo, d] = [d, mo];
    y = Number(y) < 100 ? 2000 + Number(y) : Number(y);
    h = ap ? (Number(h) % 12) + (/pm/i.test(ap) ? 12 : 0) : Number(h);
    const out = new Date(y, mo - 1, d, h, Number(mi), Number(se ?? 0));
    return Number.isNaN(out.getTime()) ? null : out;
  }
  const out = new Date(s);
  return Number.isNaN(out.getTime()) ? null : out;
}

// Finds the participants table, whatever else is in the file, and merges repeat joins
function participantsOf(rows) {
  const norm = (c) => String(c ?? "").trim().toLowerCase();
  const head = rows.findIndex((r) => r.some((c) => /^(full )?name$/.test(norm(c))) && r.some((c) => /email|upn|participant id/.test(norm(c))));
  if (head < 0) throw new Error("This doesn't look like a Teams attendance report. It needs Name and Email columns.");
  const h = rows[head].map(norm);
  const col = (...res) => h.findIndex((c) => res.some((re) => re.test(c)));
  const C = {
    name: col(/^(full )?name$/), email: col(/^email/), upn: col(/upn|participant id/), role: col(/^role/),
    join: col(/first join|join time/), leave: col(/last leave|leave time/), dur: col(/duration/),
  };
  if (C.dur < 0) throw new Error("The report needs an In-Meeting Duration column.");
  // Meeting start / end from the report's Summary section, when it has one
  const sum = {};
  for (const r of rows.slice(0, head)) {
    const k = norm(r[0]);
    if (/^(meeting )?start time$/.test(k)) sum.start = dateOf(r[1]);
    if (/^(meeting )?end time$/.test(k)) sum.end = dateOf(r[1]);
    if (/^meeting duration$/.test(k)) sum.minutes = minutesOf(r[1]);
  }
  const people = new Map();
  for (const r of rows.slice(head + 1)) {
    if (!r.length || r.every((c) => norm(c) === "")) break;      // end of the table
    if (/^\d+\.\s/.test(norm(r[0]))) break;                        // next section, e.g. "3. In-Meeting Activities"
    const name = String(r[C.name] ?? "").trim();
    const email = String((C.email >= 0 && r[C.email]) || (C.upn >= 0 && r[C.upn]) || "").trim().toLowerCase();
    if (!name && !email) continue;
    const key = email || `name:${name.toLowerCase()}`;
    const p = people.get(key) ?? { full_name: name || email, email, role: "", minutes: 0, first_join: null, last_leave: null };
    p.minutes += minutesOf(r[C.dur]);
    if (C.role >= 0 && r[C.role]) p.role = String(r[C.role]).trim();
    const j = C.join >= 0 ? dateOf(r[C.join]) : null, l = C.leave >= 0 ? dateOf(r[C.leave]) : null;
    if (j && (!p.first_join || j < p.first_join)) p.first_join = j;
    if (l && (!p.last_leave || l > p.last_leave)) p.last_leave = l;
    people.set(key, p);
  }
  if (!people.size) throw new Error("No participants were found in the report.");
  const list = [...people.values()].map((p) => ({ ...p, minutes: Math.round(p.minutes * 10) / 10 }));
  // Actual session: the Summary times, else first join → last leave across everyone
  const joins = list.map((p) => p.first_join).filter(Boolean), leaves = list.map((p) => p.last_leave).filter(Boolean);
  const start = sum.start ?? (joins.length ? new Date(Math.min(...joins)) : null);
  const end = sum.end ?? (leaves.length ? new Date(Math.max(...leaves)) : null);
  const minutes = start && end && end > start ? (end - start) / 60000 : sum.minutes || Math.max(...list.map((p) => p.minutes));
  return { people: list, actual: { start, end, minutes: Math.round(minutes * 10) / 10 } };
}

// ---------------------------------------------------------------------
// Who is who: enrolled learners, staff, people with accounts
// ---------------------------------------------------------------------
async function loadContext(program, step) {
  const [{ data: enrolled, error }, { data: progress }, { data: people }, { data: delivery }] = await Promise.all([
    sb.from("enrollments").select("id, learner_id, learner:profiles(full_name, email), enrollment_exclusions(step_id)").eq("program_id", program.id),
    sb.from("step_progress").select("enrollment_id, status").eq("step_id", step.id),
    sb.from("profiles").select("id, full_name, email, role, is_active"),
    sb.from("session_delivery").select("*").eq("step_id", step.id).maybeSingle(),
  ]);
  if (error) throw error;
  const mine = (enrolled ?? []).filter((e) => !(e.enrollment_exclusions ?? []).some((x) => x.step_id === step.id));
  return {
    enrolledBy: new Map(mine.map((e) => [String(e.learner?.email ?? "").toLowerCase(), e])),
    enrolled: mine,
    done: new Set((progress ?? []).filter((p) => p.status === "completed").map((p) => p.enrollment_id)),
    profileBy: new Map((people ?? []).map((p) => [String(p.email ?? "").toLowerCase(), p])),
    team: (people ?? []).filter((p) => ["admin", "ld"].includes(p.role) && p.is_active).sort((a, b) => a.full_name.localeCompare(b.full_name)),
    delivery: delivery ?? null,
  };
}

function classify(p, ctx, length) {
  const prof = ctx.profileBy.get(p.email);
  const e = ctx.enrolledBy.get(p.email);
  const pct = pctOf(p.minutes, length);
  const tier = TIERS.find(([min]) => pct >= min)[1];
  if (e) return { kind: tier, tier, pct, e, done: ctx.done.has(e.id) };
  if (/organi[sz]er/i.test(p.role ?? "") || (prof && ["admin", "ld"].includes(prof.role))) return { kind: "staff", tier, pct, prof };
  return { kind: "not_enrolled", tier, pct, prof: prof?.role === "learner" ? prof : null };
}

const ORDER = ["not_enrolled", "present", "partial", "brief", "low", "staff"];
const chips = (counts) => `<div class="ta-chips">${Object.entries(counts).filter(([, n]) => n).map(([k, n]) =>
  `<span class="pill ${STATUS[k][1]}">${STATUS[k][0]}: ${n}</span>`).join("")}</div>`;
const statusCell = (c) => `<span class="pill ${STATUS[c.kind][1]}">${STATUS[c.kind][0]}</span>${
  c.kind === "not_enrolled" || c.kind === "staff" ? ` <span class="muted small">${STATUS[c.tier][0]}</span>` : ""}${
  c.done && c.tier !== "present" ? ' <span class="muted small">· Marked Attended By Staff</span>' : ""}`;
const timeCell = (p, c) => `${fmtMin(p.minutes)} <span class="muted small">(${c.pct}%)</span>`;
const RULES = `<b>Present</b>: stayed 75% or more, marked attended automatically · <b>Partial</b>: 25–74%, not marked (tick in Attendance if it should count) · <b>Absent</b>: under 25%`;

function countsOf(list, absent) {
  const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, 0]));
  for (const { c } of list) counts[c.kind]++;
  counts.absent = absent.length;
  return counts;
}

// ---------------------------------------------------------------------
// Scheduled vs actual session length
// ---------------------------------------------------------------------
export const VARIANCE_MIN = 10;
export const REASONS = {
  short: ["Session Ended Early", "Cancelled Mid-Session (Low Attendance)", "Started Late", "Technical Issues", "Other"],
  long: ["Extended (Time Allotted Not Enough)", "Started Early", "Technical Issues", "Other"],
};
const timeRange = (a, b) => (a && b
  ? `${new Date(a).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} – ${new Date(b).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
  : "");
export const diffText = (actual, sched) => {
  const d = Math.round(actual - sched);
  return d === 0 ? "On time" : `${fmtMin(Math.abs(d))} ${d > 0 ? "longer" : "shorter"}`;
};

// The confirmation fields (reason, note, which length counts). Defaults follow the direction.
function confirmFields(actual, sched, current = {}) {
  const long = actual > sched;
  const reasons = REASONS[long ? "long" : "short"];
  const basis = current.basis ?? (long ? "scheduled" : "actual");
  const reason = current.reason && reasons.includes(current.reason) ? current.reason : reasons[0];
  return `
    <div class="two">
      <label class="field">Reason
        <select class="select" name="reason">${reasons.map((r) => `<option ${r === reason ? "selected" : ""}>${esc(r)}</option>`).join("")}</select></label>
      <label class="field">Note (Optional) <input class="input" name="note" value="${esc(current.note ?? "")}" placeholder="e.g. Only 4 joined; rescheduled to Friday"></label>
    </div>
    <div class="field">Count Attendance Against
      <label class="check"><input type="radio" name="basis" value="actual" ${basis === "actual" ? "checked" : ""}> Actual length (${fmtMin(actual)})</label>
      <label class="check"><input type="radio" name="basis" value="scheduled" ${basis === "scheduled" ? "checked" : ""}> Scheduled length (${fmtMin(sched)})</label>
      <span class="hint">${long ? "Scheduled is fairer when a session runs over: people who left at the planned end still count as Present." : "Actual is fairer when a session ends early: nobody is marked absent for time that didn't happen."}</span>
    </div>`;
}

const deliveryPanel = (sched, actual, schedRange, actualRange, extra = "") => `
  <div class="ta-delivery">
    <div><span>Scheduled</span><b>${fmtMin(sched)}</b><em>${esc(schedRange)}</em></div>
    <div><span>Actual (Teams)</span><b>${fmtMin(actual)}</b><em>${esc(actualRange)}</em></div>
    <div><span>Difference</span><b class="${Math.abs(actual - sched) > VARIANCE_MIN ? "warn" : ""}">${diffText(actual, sched)}</b><em>${Math.abs(actual - sched) > VARIANCE_MIN ? `More than ${VARIANCE_MIN} minutes` : `Within ${VARIANCE_MIN} minutes`}</em></div>
    ${extra}
  </div>`;

const scheduledOf = (step) => (step.session_start && step.session_end ? (new Date(step.session_end) - new Date(step.session_start)) / 60000 : 0);

// ---------------------------------------------------------------------
// Import: choose file → check → save
// ---------------------------------------------------------------------
export function importTeamsReport(program, step, after) {
  if (scheduledOf(step) <= 0) {
    openModal({
      title: "Set The Session Times First",
      intro: `Attendance is measured against the scheduled session. Add the start and end times to <b>${esc(step.title)}</b> (Learning Journey → Edit), then import the report.`,
      body: "", submitLabel: "OK", cancelLabel: "",
    });
    return;
  }
  openModal({
    title: `Import Teams Report: ${step.title}`,
    intro: "In the Teams meeting, open <b>Attendance</b> and download the report (Excel or CSV). Upload it here as it is, or after tidying it in Excel.",
    body: `
      <label class="dropzone">
        ${icons.upload}
        <strong data-file-name>Choose The Attendance Report</strong>
        <span class="muted">Excel (.xlsx) or CSV, as downloaded from Teams</span>
        <input type="file" name="file" accept=".csv,.txt,.xlsx,.xls" hidden>
      </label>`,
    submitLabel: "Check Report",
    onSubmit: async (f) => {
      const file = f.file.files[0];
      if (!file) throw new Error("Choose the report first.");
      if (file.size > 5 * 1024 * 1024) throw new Error("The file is over 5 MB. Is it the attendance report?");
      const report = participantsOf(await readRows(file));
      const ctx = await loadContext(program, step);
      reviewImport(program, step, report, ctx, file.name, after);
    },
  }).form.file.addEventListener("change", (e) => {
    e.target.closest("form").querySelector("[data-file-name]").textContent = e.target.files[0]?.name ?? "Choose The Attendance Report";
  });
}

function reviewImport(program, step, { people, actual }, ctx, fileName, after) {
  const sched = Math.round(scheduledOf(step) * 10) / 10;
  const variance = Math.abs(actual.minutes - sched) > VARIANCE_MIN;
  // Trainers who delivered it: staff in the report, else the program owner
  const inReport = new Set(people.map((p) => p.email));
  let picked = ctx.team.filter((s) => inReport.has(String(s.email ?? "").toLowerCase())).map((s) => s.id);
  if (!picked.length && program.owner_id) picked = [program.owner_id];

  const { form, close } = openModal({
    title: `Check Attendance: ${step.title}`,
    intro: `${esc(fileName)} · ${people.length} people joined.`,
    wide: true,
    body: `
      ${deliveryPanel(sched, actual.minutes, timeRange(step.session_start, step.session_end), timeRange(actual.start, actual.end))}
      ${variance ? `<div class="notice warn ta-confirm">
          <strong>Session Length Needs Confirmation</strong>
          <span>The session ran ${diffText(actual.minutes, sched)} than scheduled. Confirm why, and which length attendance is measured against. Nobody is marked attended until this is confirmed.</span>
          ${confirmFields(actual.minutes, sched)}
        </div>` : ""}
      <div class="field">Delivered By <span class="hint" style="display:inline">· their delivered hours (${fmtMin(actual.minutes)}) go to Tasks & Hours</span>
        <div class="ta-team">${ctx.team.map((s) => `<label class="check"><input type="checkbox" name="trainer" value="${s.id}" ${picked.includes(s.id) ? "checked" : ""}> ${esc(s.full_name)}</label>`).join("") || '<span class="muted small">No Admin or Trainer accounts found.</span>'}</div>
      </div>
      <p class="muted small" style="margin:0">${RULES}</p>
      <div data-sum></div>
      <div class="table-wrap" style="max-height:40vh"><table class="data">
        <thead><tr><th>Name</th><th>In Meeting</th><th>Status</th></tr></thead>
        <tbody data-rows></tbody></table></div>
      <p class="muted small" style="margin:0">People not listed as enrolled are kept with this session. If they were present, they're marked attended as soon as they're enrolled. They don't count toward completion or the dashboards until then.</p>`,
    submitLabel: variance ? "Confirm And Mark Attendance" : "Save And Mark Attendance",
    onSubmit: (f) => save(f, true),
  });

  async function save(f, confirm) {
    const rows = people.map((p) => ({
      full_name: p.full_name, email: p.email || null, role: p.role || null,
      first_join: p.first_join?.toISOString() ?? null, last_leave: p.last_leave?.toISOString() ?? null, minutes: p.minutes,
    }));
    const trainers = [...f.querySelectorAll("[name=trainer]:checked")].map((c) => c.value);
    const { data, error } = await sb.rpc("import_session_attendance", {
      p_step: step.id, p_rows: rows, p_actual_start: actual.start?.toISOString() ?? null, p_actual_end: actual.end?.toISOString() ?? null,
      p_actual_minutes: actual.minutes, p_trainers: trainers,
      p_confirm: variance && confirm ? { basis: f.querySelector("[name=basis]:checked").value, reason: f.reason.value, note: f.note.value.trim() } : null,
    });
    if (error) throw error;
    toast(data?.status === "needs_confirmation"
      ? "Report saved. The session is flagged until its length is confirmed."
      : `Report saved. ${data?.marked ?? 0} learner${data?.marked === 1 ? "" : "s"} marked present.`);
    after?.();
    showTeamsReport(program, step, after);
  }

  if (variance) {
    form.querySelector("[type=submit]").insertAdjacentHTML("beforebegin", '<button type="button" class="btn" data-later>Save, Confirm Later</button>');
    form.querySelector("[data-later]").addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try { await save(form, false); close(); } catch (err) { toast(err.message, "err"); ev.target.disabled = false; }
    });
  }

  const absent = ctx.enrolled.filter((e) => !people.some((p) => p.email && p.email === String(e.learner?.email ?? "").toLowerCase()));
  const draw = () => {
    const basis = variance ? form.querySelector("[name=basis]:checked").value : "scheduled";
    const length = basis === "actual" ? actual.minutes : sched;
    const list = people.map((p) => ({ p, c: classify(p, ctx, length) }));
    form.querySelector("[data-sum]").innerHTML = chips(countsOf(list, absent));
    form.querySelector("[data-rows]").innerHTML = list.sort((a, b) => ORDER.indexOf(a.c.kind) - ORDER.indexOf(b.c.kind) || b.c.pct - a.c.pct)
      .map(({ p, c }) => `<tr><td class="name"><strong>${esc(p.full_name)}</strong><span>${esc(p.email || "No email in report")}</span></td>
        <td style="white-space:nowrap">${timeCell(p, c)}</td><td>${statusCell(c)}</td></tr>`).join("")
      + absent.map((e) => `<tr><td class="name"><strong>${esc(e.learner?.full_name ?? "")}</strong><span>${esc(e.learner?.email ?? "")}</span></td><td>–</td>
        <td><span class="pill ${STATUS.absent[1]}">${STATUS.absent[0]}</span></td></tr>`).join("");
  };
  form.querySelectorAll("[name=basis]").forEach((r) => r.addEventListener("change", draw));
  draw();
}

// ---------------------------------------------------------------------
// The saved report: delivery, confirmation, attendance, enrolling
// ---------------------------------------------------------------------
export async function showTeamsReport(program, step, after) {
  const [{ data: rows, error }, ctx] = await Promise.all([
    sb.from("session_attendance").select("*, importer:profiles!session_attendance_imported_by_fkey(full_name)").eq("step_id", step.id).order("full_name"),
    loadContext(program, step),
  ]);
  if (error) return toast(error.message, "err");
  if (!rows?.length) return toast("No Teams report has been imported for this session yet.", "err");
  const d = ctx.delivery;
  const pending = d?.status === "needs_confirmation";
  const length = d ? Number(d.basis_minutes ?? d.scheduled_minutes) : lengthFrom(rows[0].required_minutes);
  const list = rows.map((p) => ({ p, c: classify({ ...p, email: p.email ?? "" }, ctx, length) }))
    .sort((a, b) => ORDER.indexOf(a.c.kind) - ORDER.indexOf(b.c.kind) || b.c.pct - a.c.pct);
  const inReport = new Set(rows.map((r) => r.email).filter(Boolean));
  const absent = ctx.enrolled.filter((e) => !inReport.has(String(e.learner?.email ?? "").toLowerCase()));
  const counts = countsOf(list, absent);
  const nameOf = (id) => ctx.team.find((s) => s.id === id)?.full_name ?? [...ctx.profileBy.values()].find((p) => p.id === id)?.full_name ?? "Former Member";
  const sched = Number(d?.scheduled_minutes ?? 0), act = Number(d?.actual_minutes ?? 0);

  const { form } = openModal({
    title: `Teams Report: ${step.title}`,
    intro: `Imported ${esc(fmtDateTime(rows[0].imported_at))} by ${esc(rows[0].importer?.full_name ?? "staff")}${d?.trainer_ids?.length ? ` · delivered by ${esc(d.trainer_ids.map(nameOf).join(", "))}` : ""}.`,
    wide: true,
    body: `
      ${d ? deliveryPanel(sched, act, timeRange(step.session_start, step.session_end), timeRange(d.actual_start, d.actual_end),
        `<div><span>Counted Against</span><b>${pending ? "Not Confirmed" : `${d.basis === "actual" ? "Actual" : "Scheduled"} (${fmtMin(length)})`}</b><em>${esc(d.reason ?? (d.status === "matched" ? "Ran as scheduled" : ""))}${d.note ? ` · ${esc(d.note)}` : ""}</em></div>`) : ""}
      ${pending ? `<div class="notice warn ta-confirm">
          <strong>Session Length Needs Confirmation</strong>
          <span>The session ran ${diffText(act, sched)} than scheduled. Nobody is marked attended, and no delivered hours are logged, until this is confirmed. The statuses below are provisional (measured against the scheduled length).</span>
          ${confirmFields(act, sched)}
          <div><button type="button" class="btn primary" data-confirm>Confirm And Mark Attendance</button></div>
        </div>` : d && d.status === "confirmed" ? `<details class="ta-change"><summary>Change The Reason Or Length</summary>
          <div class="ta-confirm">${confirmFields(act, sched, d)}<div><button type="button" class="btn" data-confirm>Save Change</button></div></div></details>` : ""}
      <p class="muted small" style="margin:0">${RULES}</p>
      ${chips(counts)}
      ${counts.not_enrolled ? `<div class="notice info" style="margin:0">${counts.not_enrolled} ${counts.not_enrolled === 1 ? "person isn't" : "people aren't"} listed as enrolled. Enroll them (or add them in People first, then enroll). If they were present, their attendance updates automatically. Until then they don't count toward completion or the dashboards.</div>` : ""}
      <div class="table-wrap" style="max-height:44vh"><table class="data">
        <thead><tr><th>Name</th><th>In Meeting</th><th>Status</th><th></th></tr></thead>
        <tbody data-report>${list.map(({ p, c }) => `
          <tr><td class="name"><strong>${esc(p.full_name)}</strong><span>${esc(p.email || "No email in report")}</span></td>
            <td style="white-space:nowrap">${timeCell(p, c)}</td><td>${statusCell(c)}</td>
            <td class="actions">${c.kind === "not_enrolled"
              ? c.prof ? `<button type="button" class="btn sm primary" data-enroll="${c.prof.id}">Enroll</button>` : '<a class="btn sm" href="#/people">Add In People</a>'
              : ""}</td></tr>`).join("")}
          ${absent.map((e) => `<tr><td class="name"><strong>${esc(e.learner?.full_name ?? "")}</strong><span>${esc(e.learner?.email ?? "")}</span></td><td>–</td>
            <td><span class="pill ${STATUS.absent[1]}">${STATUS.absent[0]}</span>${ctx.done.has(e.id) ? ' <span class="muted small">· Marked Attended By Staff</span>' : ""}</td><td></td></tr>`).join("")}
        </tbody></table></div>`,
    submitLabel: "Close",
    cancelLabel: "",
  });
  const reopen = () => { form.closest(".modal-backdrop").remove(); after?.(); showTeamsReport(program, step, after); };

  form.querySelector("[data-confirm]")?.addEventListener("click", async (ev) => {
    const box = ev.target.closest(".ta-confirm");
    ev.target.disabled = true;
    const { data, error: err } = await sb.rpc("confirm_session_delivery", {
      p_step: step.id, p_basis: box.querySelector("[name=basis]:checked").value,
      p_reason: box.querySelector("[name=reason]").value, p_note: box.querySelector("[name=note]").value.trim(),
    });
    if (err) { ev.target.disabled = false; return toast(err.message, "err"); }
    toast(`Confirmed. ${data?.marked ?? 0} learner${data?.marked === 1 ? "" : "s"} marked present.`);
    reopen();
  });

  form.querySelector("[type=submit]").insertAdjacentHTML("beforebegin", `<button type="button" class="btn" data-xlsx>${icons.download} Export Excel</button>`);
  form.querySelector("[data-xlsx]").addEventListener("click", async () => {
    await loadScript(LIBS.xlsx);
    const XLSX = window.XLSX;
    const data = [
      ...list.map(({ p, c }) => ({ Name: p.full_name, Email: p.email ?? "", Role: p.role ?? "", "First Join": p.first_join ? new Date(p.first_join) : "",
        "Last Leave": p.last_leave ? new Date(p.last_leave) : "", "Minutes In Meeting": Number(p.minutes), "% Of Session": c.pct,
        Attendance: STATUS[c.tier][0] + (pending ? " (Provisional)" : ""), Enrolled: c.kind === "not_enrolled" ? "Not Listed As Enrolled" : c.kind === "staff" ? "Organizer / Staff" : "Yes" })),
      ...absent.map((e) => ({ Name: e.learner?.full_name ?? "", Email: e.learner?.email ?? "", Role: "", "First Join": "", "Last Leave": "",
        "Minutes In Meeting": 0, "% Of Session": 0, Attendance: STATUS.absent[0], Enrolled: "Yes" })),
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), "Attendance");
    if (d) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{
      Session: step.title, "Scheduled Minutes": sched, "Actual Minutes": act, Difference: diffText(act, sched),
      Status: { matched: "Ran As Scheduled", confirmed: "Confirmed", needs_confirmation: "Needs Confirmation" }[d.status],
      "Counted Against": pending ? "" : d.basis === "actual" ? "Actual" : "Scheduled", Reason: d.reason ?? "", Note: d.note ?? "",
      "Delivered By": (d.trainer_ids ?? []).map(nameOf).join(", "),
    }]), "Session");
    XLSX.writeFile(wb, `${safeName(`${program.title} - ${step.title} - Attendance`)}.xlsx`);
  });

  form.querySelector("[data-report]").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-enroll]");
    if (!b) return;
    b.disabled = true;
    const { error: err } = await sb.from("enrollments").insert({ program_id: program.id, learner_id: b.dataset.enroll });
    if (err) { b.disabled = false; return toast(err.message, "err"); }
    toast(pending ? "Enrolled. Their attendance is marked once the session is confirmed." : "Enrolled. If they were present, their attendance is updated.");
    reopen();
  });
}
