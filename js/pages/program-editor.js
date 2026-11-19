// One program: Details · Welcome & reading · Learning journey · Learners, plus status changes.
import { sb } from "../supabase.js";
import { brand, team,
  esc, toast, openModal, icons, stepIcon, statusPill, fmtDate, fmtDateTime, toLocalInput, fromLocalInput,
  PROGRAM_TYPE, TRAINING_TYPE, isProject, PROGRAM_STATUS, STEP_TYPE, LIBS, loadScript, downloadBlob, safeName, learningMinutes,
} from "../ui.js";
import { renderFormBuilder } from "./form-builder.js";
import { renderFormResults } from "./form-results.js";
import { tasksTab } from "./program-tasks.js";
import { reviewsTab } from "./program-reviews.js";
import { importTeamsReport, showTeamsReport, fmtMin, tierOf, diffText } from "./teams-attendance.js";

const VIDEO_BUCKET = "welcome-videos";
const UPLOAD_BUCKET = "learner-uploads";
const MAX_VIDEO_MB = 50;

const TABS = [
  ["details", "Details"],
  ["welcome", "Welcome & Reading"],
  ["journey", "Learning Journey"],
  ["learners", "Learners"],
  ["reviews", "Reviews"],
  ["tasks", "Tasks"],
];

// Projects / initiatives: a task list only
const PROJECT_TABS = [["tasks", "Tasks"], ["details", "Details"]];
const PROJECT_NEXT = {
  draft:     [["live", "Start Project"]],
  scheduled: [["live", "Start Project"]],
  live:      [["completed", "Mark Completed"], ["on_hold", "Put On Hold"]],
  on_hold:   [["live", "Resume"], ["completed", "Mark Completed"]],
  completed: [["archived", "Archive"], ["live", "Reopen"]],
  archived:  [["completed", "Unarchive"]],
};
const PROJECT_EFFECT = {
  live: "The project is under way.",
  on_hold: "The project is paused. Tasks and hours stay as they are.",
  completed: "The project is marked completed. Tasks and hours stay on Tasks & Hours.",
  archived: "The project leaves the Programs list (choose All to see it) and the Tasks & Hours dashboard. Nothing is deleted.",
};

// Which status buttons to offer, and what each change means for learners
const NEXT_STATUS = {
  draft:     [["scheduled", "Schedule"], ["live", "Go Live"]],
  scheduled: [["live", "Go Live"], ["draft", "Back To Draft"]],
  live:      [["on_hold", "Put On Hold"], ["completed", "Mark Completed"]],
  on_hold:   [["live", "Resume"], ["completed", "Mark Completed"]],
  completed: [["live", "Reopen"]],
  archived:  [],
};
const STATUS_EFFECT = {
  draft: "Learners will no longer see this program.",
  scheduled: "Enrolled learners can see the program, its dates and the welcome message, but nothing opens until it goes live.",
  live: "Learners can open each step once its “available from” date arrives.",
  on_hold: "Learners still see the program, but every link, module and assessment is locked until you resume it. Deadlines are paused.",
  completed: "Learners keep seeing their results, but links, modules and assessments close.",
};

const LINK_HINT = {
  module: "The module's address on the team's GitHub, e.g. https://….github.io/module-1/",
  ilt_session: "The Microsoft Teams meeting link.",
  survey: "Optional: an external survey link (e.g. Microsoft Forms). Leave empty to build the survey here with Build.",
  resource: "The SharePoint link to the document or folder (Share → Copy Link). Learners need SharePoint access to open it. It's an extra: learners click Mark As Reviewed, and it doesn't count toward completion.",
};

export async function renderProgramEditor(main, ctx) {
  const [id, tabParam] = ctx.params;
  const reload = () => renderProgramEditor(main, ctx);

  main.innerHTML = '<div class="empty" style="margin-top:24px"><div>Loading…</div></div>';
  const { data: program, error } = await sb.from("programs").select("*").eq("id", id).maybeSingle();
  if (error || !program) {
    main.innerHTML = `
      <header class="topbar"><div><a class="back-link" href="#/programs">${icons.back} Programs</a><h1>Program Not Found</h1></div></header>
      <div class="empty"><div>It may have been deleted.</div></div>`;
    return;
  }

  // Assessment / survey builder and results have their own pages
  if (tabParam === "form") return renderFormBuilder(main, program, ctx.params[2]);
  if (tabParam === "results") return renderFormResults(main, program, ctx.params[2], ctx.me);

  const project = isProject(program);
  const tabList = project ? PROJECT_TABS : TABS;
  const tab = tabList.some(([k]) => k === tabParam) ? tabParam : tabList[0][0];
  const canDelete = program.status === "draft" || ctx.me.role === "admin";
  main.innerHTML = `
    <header class="topbar">
      <div>
        <a class="back-link" href="#/programs">${icons.back} Programs</a>
        <h1>${esc(program.title)}</h1>
        <p>${statusPill(program.status)} &nbsp;${esc(PROGRAM_TYPE[program.program_type])}${program.client ? ` · ${esc(program.client)}` : ""}${program.audience && !project ? ` · ${esc(program.audience)}` : ""}</p>
      </div>
      <div class="top-actions">
        ${(project ? PROJECT_NEXT : NEXT_STATUS)[program.status].map(([to, label], i) =>
          `<button class="btn ${i === 0 ? "primary" : ""}" data-status="${to}">${label}</button>`).join("")}
        ${project ? "" : `<a class="btn" href="#/preview/new/${id}">${icons.eye} Preview As Learner</a>`}
        ${program.status === "completed" && !project ? `<button class="btn primary" data-archive>${icons.archive} Close &amp; Archive</button>` : ""}
        ${project ? "" : `<button class="btn" data-duplicate>Duplicate</button>`}
        ${canDelete ? `<button class="btn danger" data-delete>${icons.trash} Delete</button>` : ""}
      </div>
    </header>
    <nav class="tabs">
      ${tabList.map(([k, label]) => `<a href="#/programs/${id}/${k}" class="${k === tab ? "active" : ""}">${label}</a>`).join("")}
    </nav>
    <div data-task-nudge></div>
    <section id="tab"></section>`;

  main.querySelectorAll("[data-status]").forEach((b) =>
    b.addEventListener("click", () => changeStatus(program, b.dataset.status, b.textContent, reload)));
  main.querySelector("[data-duplicate]")?.addEventListener("click", () => duplicateProgram(program, ctx.me));
  main.querySelector("[data-archive]")?.addEventListener("click", () => closeAndArchive(program, reload));
  main.querySelector("[data-delete]")?.addEventListener("click", () => deleteProgram(program));

  const area = main.querySelector("#tab");
  const tabs = { details: detailsTab, welcome: welcomeTab, journey: journeyTab, learners: learnersTab, reviews: reviewsTab, tasks: tasksTab };
  // New programs: a nudge to list the team's tasks once
  if (tab !== "tasks" && !project) {
    sb.from("program_tasks").select("id", { count: "exact", head: true }).eq("program_id", id).then(({ count, error: err }) => {
      const box = main.querySelector("[data-task-nudge]");
      if (box && !err && count === 0) box.innerHTML = `<div class="notice info" style="margin-bottom:12px">Next: list this program's tasks and owners. <a href="#/programs/${id}/tasks"><b>Open Tasks</b></a></div>`;
    });
  }
  await tabs[tab](area, program, reload, ctx.me);
}

// =====================================================================
// Status, duplicate, delete
// =====================================================================
async function changeStatus(program, to, label, reload) {
  let warning = "";
  const project = isProject(program);
  if (!project && (to === "live" || to === "scheduled")) {
    const [{ count: steps }, { count: learners }] = await Promise.all([
      sb.from("program_steps").select("id", { count: "exact", head: true }).eq("program_id", program.id),
      sb.from("enrollments").select("id", { count: "exact", head: true }).eq("program_id", program.id),
    ]);
    const missing = [!steps && "no learning-journey steps", !learners && "no learners enrolled"].filter(Boolean);
    if (missing.length) warning = `<div class="notice">This program has ${missing.join(" and ")} yet.</div>`;
  }
  openModal({
    title: `${label}?`,
    intro: esc((project ? PROJECT_EFFECT : STATUS_EFFECT)[to] ?? ""),
    body: warning,
    submitLabel: label,
    onSubmit: async () => {
      const { error } = await sb.from("programs").update({ status: to }).eq("id", program.id);
      if (error) throw error;
      toast(`${project ? "Project" : "Program"} is now ${PROGRAM_STATUS[to].label.toLowerCase()}.`);
      reload();
    },
  });
}

function deleteProgram(program) {
  openModal({
    title: `Delete “${program.title}”?`,
    intro: "This permanently removes the program, its learning journey, enrolments, progress, scores and the welcome video.",
    body: '<label class="field">Type DELETE To Confirm <input class="input" name="confirm" autocomplete="off"></label>',
    submitLabel: "Delete Permanently",
    danger: true,
    onSubmit: async (f) => {
      if (f.confirm.value.trim() !== "DELETE") throw new Error("Type DELETE in capitals to confirm.");
      if (program.welcome_video_path) await sb.storage.from(VIDEO_BUCKET).remove([program.welcome_video_path]);
      const { error } = await sb.from("programs").delete().eq("id", program.id);
      if (error) throw error;
      toast("Program deleted.");
      location.hash = "#/programs";
    },
  });
}

function duplicateProgram(program, me) {
  openModal({
    title: "Duplicate Program",
    intro: "Copies the details, welcome message and video, required reading, and the whole learning journey with its links and assessment questions. Learners and dates are not copied.",
    body: `<label class="field">New Title <input class="input" name="title" value="${esc(`${program.title} (copy)`)}"></label>`,
    submitLabel: "Duplicate",
    onSubmit: async (f) => {
      const title = f.title.value.trim();
      if (!title) throw new Error("Please give the copy a title.");

      const { data: copy, error } = await sb.from("programs").insert({
        title, program_type: program.program_type, audience: program.audience, client: program.client, objectives: program.objectives,
        overview: program.overview, welcome_message: program.welcome_message, required_reading: program.required_reading,
        owner_id: me.id,
      }).select("id").single();
      if (error) throw error;

      if (program.welcome_video_path) {
        const fileName = program.welcome_video_path.split("/").pop();
        const newPath = `${copy.id}/${fileName}`;
        const { error: copyErr } = await sb.storage.from(VIDEO_BUCKET).copy(program.welcome_video_path, newPath);
        if (!copyErr) await sb.from("programs").update({ welcome_video_path: newPath }).eq("id", copy.id);
      }

      const { data: steps } = await sb.from("program_steps")
        .select("*, step_links(url), form_sections(*), assessment_questions(*, assessment_answer_keys(correct, correct_option))")
        .eq("program_id", program.id).order("position");
      for (const s of steps ?? []) {
        const { data: newStep, error: stepErr } = await sb.from("program_steps").insert({
          program_id: copy.id, position: s.position, step_type: s.step_type, title: s.title, description: s.description,
          is_required: s.is_required, passing_score: s.passing_score, completion_text: s.completion_text,
          time_limit_minutes: s.time_limit_minutes, max_attempts: s.max_attempts, shuffle_questions: s.shuffle_questions,
          shuffle_options: s.shuffle_options, show_answers: s.show_answers, identity_mode: s.identity_mode, thank_you: s.thank_you,
          max_files: s.max_files ?? 1, secure_mode: s.secure_mode ?? true, standard_minutes: s.standard_minutes ?? null,
        }).select("id").single();
        if (stepErr) throw stepErr;
        const url = linkOf(s);
        if (url) await sb.from("step_links").insert({ step_id: newStep.id, url });

        // Sections, questions and answer keys, with fresh ids
        const sectionIds = {};
        const sectionRows = (s.form_sections ?? []).map((sec) => {
          sectionIds[sec.id] = crypto.randomUUID();
          return { id: sectionIds[sec.id], step_id: newStep.id, position: sec.position, title: sec.title, description: sec.description };
        });
        if (sectionRows.length) await sb.from("form_sections").insert(sectionRows);
        const keyRows = [];
        const questionRows = (s.assessment_questions ?? []).map((q) => {
          const id = crypto.randomUUID();
          const k = Array.isArray(q.assessment_answer_keys) ? q.assessment_answer_keys[0] : q.assessment_answer_keys;
          if (k) keyRows.push({ question_id: id, correct: k.correct, correct_option: k.correct_option });
          return {
            id, step_id: newStep.id, section_id: sectionIds[q.section_id] ?? null, position: q.position, qtype: q.qtype,
            question: q.question, description: q.description, options: q.options, points: q.points, required: q.required,
          };
        });
        if (questionRows.length) await sb.from("assessment_questions").insert(questionRows);
        if (keyRows.length) await sb.from("assessment_answer_keys").insert(keyRows);
      }
      toast("Program duplicated. Set its dates before going live.");
      location.hash = `#/programs/${copy.id}/details`;
    },
  });
}

// =====================================================================
// Close & Archive: download the learners' files and the full records,
// then delete the files and video to free storage. Text records stay.
// =====================================================================
async function closeAndArchive(program, reload) {
  const [{ data: enrolled, error }, { data: steps }] = await Promise.all([
    sb.from("enrollments").select("id, learner_id, due_date_override, enrolled_at, welcome_completed_at, reading_ack_at, learner:profiles(full_name, email, department, designation, market, manager)").eq("program_id", program.id),
    sb.from("program_steps").select("*, step_links(url)").eq("program_id", program.id).order("position"),
  ]);
  if (error) return toast(error.message, "err");
  const ids = enrolled.map((e) => e.id);
  const none = Promise.resolve({ data: [] });
  const [{ data: uploads }, { data: progress }, { data: attempts }, { data: threads }, { data: summary }] = await Promise.all([
    ids.length ? sb.from("uploads").select("*, reviewer:profiles!uploads_reviewed_by_fkey(full_name)").in("enrollment_id", ids).order("uploaded_at") : none,
    ids.length ? sb.from("step_progress").select("*").in("enrollment_id", ids) : none,
    ids.length ? sb.from("assessment_attempts").select("*").in("enrollment_id", ids).order("submitted_at") : none,
    sb.from("message_threads").select("subject, status, created_at, learner:profiles(full_name), thread_messages(body, created_at, author:profiles(full_name))").eq("program_id", program.id),
    sb.from("v_enrollment_progress").select("*").eq("program_id", program.id),
  ]);
  const enrollmentById = Object.fromEntries(enrolled.map((e) => [e.id, e]));
  const stepById = Object.fromEntries(steps.map((s) => [s.id, s]));
  const pending = uploads.filter((u) => u.status === "pending").length;
  const done = { zip: uploads.length === 0, excel: false };

  const { form } = openModal({
    title: `Close & Archive “${program.title}”`,
    intro: `Download everything first. Archiving then deletes the uploaded files and the welcome video to free storage. Names, progress, scores and dates stay in ${brand.platform} for the dashboard.`,
    wide: true,
    body: `
      <ol class="wizard">
        <li class="${pending ? "blocked" : "ok"}">
          <strong>Check Reviews</strong>
          ${pending ? `<div class="notice">${pending} upload${pending === 1 ? " is" : "s are"} still waiting for review. <a href="#/review">Open the Review Queue</a> and review ${pending === 1 ? "it" : "them"} first.</div>`
            : '<span class="muted">No uploads are waiting for review.</span>'}
        </li>
        <li data-zip class="${done.zip ? "ok" : ""}">
          <strong>Download Learner Files (ZIP)</strong>
          ${uploads.length ? `<span class="muted">${uploads.length} file${uploads.length === 1 ? "" : "s"}, one folder per learner.</span>
            <button type="button" class="btn" data-get-zip ${pending ? "disabled" : ""}>${icons.download} Download ZIP</button>` : '<span class="muted">No learner files to download.</span>'}
        </li>
        <li data-xlsx>
          <strong>Download Program Records (Excel)</strong>
          <span class="muted">Details, learning journey, learners, progress, scores, uploads and messages.</span>
          <button type="button" class="btn" data-get-xlsx ${pending ? "disabled" : ""}>${icons.download} Download Excel</button>
        </li>
        <li data-confirm>
          <strong>Confirm</strong>
          <span class="muted">Save both downloads to your team's shared drive. Then type the program title to archive it.</span>
          <input class="input" name="confirm" autocomplete="off" placeholder="${esc(program.title)}" disabled>
        </li>
      </ol>`,
    submitLabel: "Archive And Delete Files",
    danger: true,
    onSubmit: async (f) => {
      if (pending) throw new Error("Review the waiting uploads first.");
      if (!done.zip || !done.excel) throw new Error("Download the ZIP and the Excel file first.");
      if (f.confirm.value.trim() !== program.title.trim()) throw new Error("Type the program title exactly to confirm.");

      const submit = f.querySelector('[type="submit"]');
      submit.textContent = "Deleting files…";
      // Every file in each learner's folder, including any not listed in uploads
      const paths = [];
      for (const id of ids) {
        const { data: folders } = await sb.storage.from(UPLOAD_BUCKET).list(id, { limit: 1000 });
        for (const folder of folders ?? []) {
          const { data: files } = await sb.storage.from(UPLOAD_BUCKET).list(`${id}/${folder.name}`, { limit: 1000 });
          for (const file of files ?? []) paths.push(`${id}/${folder.name}/${file.name}`);
        }
      }
      for (let i = 0; i < paths.length; i += 100) {
        const { error: rmErr } = await sb.storage.from(UPLOAD_BUCKET).remove(paths.slice(i, i + 100));
        if (rmErr) throw rmErr;
      }
      if (program.welcome_video_path) await sb.storage.from(VIDEO_BUCKET).remove([program.welcome_video_path]);

      const { error: upErr } = await sb.from("programs")
        .update({ status: "archived", files_purged_at: new Date().toISOString(), welcome_video_path: null })
        .eq("id", program.id);
      if (upErr) throw upErr;
      toast(`Archived. ${paths.length} file${paths.length === 1 ? "" : "s"} deleted from storage.`);
      reload();
    },
  });

  const submit = form.querySelector('[type="submit"]');
  const confirm = form.confirm;
  const sync = () => {
    form.querySelector("[data-zip]").classList.toggle("ok", done.zip);
    form.querySelector("[data-xlsx]").classList.toggle("ok", done.excel);
    confirm.disabled = !(done.zip && done.excel) || !!pending;
    submit.disabled = confirm.disabled || confirm.value.trim() !== program.title.trim();
  };
  confirm.addEventListener("input", sync);
  sync();

  const busy = async (btn, fn) => {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = "Preparing…";
    try { await fn(); } catch (err) { toast(err.message, "err"); } finally { btn.disabled = false; btn.innerHTML = label; sync(); }
  };

  form.querySelector("[data-get-zip]")?.addEventListener("click", (e) => { const btn = e.currentTarget; busy(btn, async () => {
    await loadScript(LIBS.jszip);
    const zip = new window.JSZip();
    const used = new Set();
    let missing = 0;
    for (const [i, u] of uploads.entries()) {
      btn.textContent = `Adding ${i + 1} of ${uploads.length}…`;
      const { data: blob } = await sb.storage.from(UPLOAD_BUCKET).download(u.file_path);
      if (!blob) { missing += 1; continue; }
      const learner = safeName(enrollmentById[u.enrollment_id]?.learner.full_name);
      const status = { approved: "Approved", pending: "Waiting", rejected: "Returned" }[u.status];
      const base = `${learner}/${safeName(stepById[u.step_id]?.title)} - ${status} - ${safeName(u.file_name)}`;
      let name = base;
      for (let n = 2; used.has(name); n++) name = base.replace(/(\.[a-z0-9]+)?$/i, ` (${n})$1`);
      used.add(name);
      zip.file(name, blob);
    }
    const out = await zip.generateAsync({ type: "blob" });
    downloadBlob(out, `${safeName(program.title)} - Learner Files.zip`);
    done.zip = true;
    toast(missing ? `ZIP downloaded. ${missing} returned file${missing === 1 ? " was" : "s were"} already replaced and not included.` : "ZIP downloaded.");
  }); });

  form.querySelector("[data-get-xlsx]").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    await loadScript(LIBS.xlsx);
    const X = window.XLSX;
    const wb = X.utils.book_new();
    const add = (name, rows, widths) => {
      const ws = Array.isArray(rows[0]) ? X.utils.aoa_to_sheet(rows, { cellDates: true }) : X.utils.json_to_sheet(rows, { cellDates: true });
      ws["!cols"] = widths.map((w) => ({ wch: w }));
      X.utils.book_append_sheet(wb, ws, name);
    };
    const d = (v) => (v ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v) : "");
    const who = (id) => enrollmentById[id]?.learner ?? {};
    const pctBy = Object.fromEntries((summary ?? []).map((p) => [p.enrollment_id, p]));

    add("Program", [
      ["Title", program.title], ["Type", PROGRAM_TYPE[program.program_type]], ["Audience", program.audience ?? ""],
      ["Start Date", d(program.start_date)], ["Due Date", d(program.due_date)], ["Status", PROGRAM_STATUS[program.status].label],
      ["Overview", program.overview ?? ""], ["Objectives", program.objectives ?? ""], ["Welcome Message", program.welcome_message ?? ""],
      ["Required Reading", program.required_reading ?? ""], ["Archived On", new Date()],
    ], [20, 90]);
    add("Learning Journey", steps.map((s) => ({
      "#": s.position, Step: s.title, Type: STEP_TYPE[s.step_type].short, Required: s.is_required ? "Yes" : "No",
      "Available From": d(s.unlock_at), Due: d(s.due_at), "Session Start": d(s.session_start), "Pass Mark %": s.passing_score ?? "", "Final Screen Words": s.completion_text ?? "",
      Link: linkOf(s), Instructions: s.description ?? "",
    })), [4, 34, 14, 9, 18, 18, 18, 11, 40, 40]);
    const { data: exclusions } = ids.length ? await sb.from("enrollment_exclusions").select("enrollment_id, step_id").in("enrollment_id", ids) : { data: [] };
    const removedFor = (id) => new Set((exclusions ?? []).filter((x) => x.enrollment_id === id).map((x) => x.step_id));
    add("Learners", enrolled.map((e) => ({
      Learner: e.learner.full_name, Email: e.learner.email, Department: e.learner.department ?? "", Designation: e.learner.designation ?? "",
      Market: e.learner.market ?? "", "Reporting Manager": e.learner.manager ?? "",
      "Completion %": Math.round(Number(pctBy[e.id]?.percent_complete ?? 0)),
      "Steps Done": pctBy[e.id]?.completed_steps ?? 0, "Steps Required": pctBy[e.id]?.required_steps ?? 0,
      "Due Date": d(e.due_date_override ?? program.due_date), Enrolled: d(e.enrolled_at),
      "Watched Welcome Video": d(e.welcome_completed_at), "Read Required Reading": d(e.reading_ack_at),
      "Steps Assigned": removedFor(e.id).size ? steps.filter((s) => !removedFor(e.id).has(s.id)).map((s) => s.title).join("; ") : "All",
    })), [26, 32, 20, 20, 13, 22, 13, 11, 14, 12, 18, 22, 22, 50]);
    add("Step Progress", progress.map((p) => ({
      Learner: who(p.enrollment_id).full_name, Email: who(p.enrollment_id).email, Step: stepById[p.step_id]?.title ?? "",
      Status: { not_started: "Not Started", in_progress: "In Progress", submitted: "Submitted", completed: "Completed", rejected: "Returned" }[p.status],
      "Score %": p.score ?? "", Started: d(p.started_at), Completed: d(p.completed_at),
    })), [26, 32, 34, 13, 9, 18, 18]);
    add("Assessment Attempts", attempts.length ? attempts.map((a) => ({
      Learner: who(a.enrollment_id).full_name, Email: who(a.enrollment_id).email, Assessment: stepById[a.step_id]?.title ?? "",
      Score: a.score, "Out Of": a.max_score, "Score %": Number(a.percent), Result: a.passed ? "Passed" : "Not Passed", Submitted: d(a.submitted_at),
    })) : [["No assessment attempts."]], [26, 32, 32, 7, 7, 9, 12, 18]);
    add("Uploads", uploads.length ? uploads.map((u) => ({
      Learner: who(u.enrollment_id).full_name, Email: who(u.enrollment_id).email, Step: stepById[u.step_id]?.title ?? "",
      File: u.file_name, Status: { approved: "Approved", pending: "Waiting For Review", rejected: "Returned" }[u.status],
      Uploaded: d(u.uploaded_at), "Reviewed By": u.reviewer?.full_name ?? "", Reviewed: d(u.reviewed_at), Comment: u.review_comment ?? "",
    })) : [["No uploads."]], [26, 32, 30, 30, 18, 18, 20, 18, 40]);
    const surveySteps = steps.filter((x) => x.step_type === "survey").map((x) => x.id);
    const { data: responses } = surveySteps.length
      ? await sb.from("survey_responses").select("step_id, respondent_id, answers, submitted_at").in("step_id", surveySteps)
      : { data: [] };
    const { data: surveyQs } = surveySteps.length
      ? await sb.from("assessment_questions").select("id, step_id, question, qtype, options").in("step_id", surveySteps).order("position")
      : { data: [] };
    const nameOf = Object.fromEntries(enrolled.map((e) => [e.learner_id, e.learner.full_name]));
    const qText = (q, v) => (v == null ? "" : q.qtype === "single" ? q.options[v] ?? v : q.qtype === "multi" ? [].concat(v).map((i) => q.options[i] ?? i).join("; ") : q.qtype === "likert" ? ["Strongly Disagree", "Disagree", "Neutral", "Agree", "Strongly Agree"][v] ?? v : v);
    add("Survey Responses", (responses ?? []).length ? responses.flatMap((r) => (surveyQs ?? []).filter((q) => q.step_id === r.step_id).map((q) => ({
      Survey: stepById[r.step_id]?.title ?? "", Submitted: d(r.submitted_at), Respondent: r.respondent_id ? nameOf[r.respondent_id] ?? "Learner" : "Anonymous",
      Question: q.question, Answer: qText(q, r.answers?.[q.id]),
    }))) : [["No survey responses."]], [26, 18, 24, 50, 50]);
    add("Messages", (threads ?? []).length ? threads.flatMap((t) => [...t.thread_messages]
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map((m) => ({ Conversation: t.subject, Learner: t.learner?.full_name ?? "", Status: t.status === "open" ? "Open" : "Resolved",
        From: m.author?.full_name ?? "", Sent: d(m.created_at), Message: m.body })))
      : [["No messages."]], [30, 24, 10, 24, 18, 80]);

    X.writeFile(wb, `${safeName(program.title)} - Program Records.xlsx`);
    done.excel = true;
    toast("Excel records downloaded.");
  }));
}

// RCM Academy Hub can only see a module's screen when both are on the same website
// (the same GitHub account), e.g. https://<account>.github.io/...
const sameSite = (url) => { try { return new URL(url).origin === location.origin; } catch { return false; } };

// Embedded one-to-one rows come back as an object or a one-item list
const linkOf = (step) => (Array.isArray(step.step_links) ? step.step_links[0]?.url : step.step_links?.url) ?? "";

// =====================================================================
// Details
// =====================================================================
async function detailsTab(area, program, reload) {
  const project = isProject(program);
  const [{ data: staff }, { data: others }] = await Promise.all([
    sb.from("profiles").select("id, full_name").in("role", ["admin", "ld"]).eq("is_active", true).order("full_name"),
    sb.from("programs").select("client"),
  ]);
  const clients = [...new Set((others ?? []).map((p) => (p.client ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  area.innerHTML = `
    <form class="card form-grid" novalidate>
      <div class="form-error" hidden></div>
      <label class="field span-2">Title <input class="input" name="title" value="${esc(program.title)}" required></label>
      <label class="field">Type
        <select class="select" name="program_type" ${project ? "disabled" : ""}>
          ${Object.entries(project ? { project: PROGRAM_TYPE.project } : TRAINING_TYPE).map(([k, l]) => `<option value="${k}" ${k === program.program_type ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </label>
      <label class="field">${project ? "Project Owner" : "Program Owner (Trainer)"}
        <select class="select" name="owner_id">
          <option value="">Not Assigned</option>
          ${(staff ?? []).map((s) => `<option value="${s.id}" ${s.id === program.owner_id ? "selected" : ""}>${esc(s.full_name)}</option>`).join("")}
        </select>
      </label>
      <label class="field span-2">Client / Group (Optional)
        <input class="input" name="client" list="client-list" value="${esc(program.client ?? "")}" placeholder="e.g. UT Health, VMMC, Patient Access team" autocomplete="off">
        <datalist id="client-list">${clients.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
        <span class="hint">The client or group this ${project ? "project" : "program"} supports. Pick one already used to keep names consistent.</span></label>
      <label class="field span-2" ${project ? "hidden" : ""}>Audience <input class="input" name="audience" value="${esc(program.audience ?? "")}" placeholder="e.g. Team leads, new hires"></label>
      <label class="field">Start Date <input class="input" type="date" name="start_date" value="${esc(program.start_date ?? "")}"></label>
      <label class="field">Due Date <input class="input" type="date" name="due_date" value="${esc(program.due_date ?? "")}">
        <span class="hint">${project ? "The project deadline." : "The program deadline. You can extend it for individual learners on the Learners tab."}</span></label>
      <label class="field span-2">Overview <textarea class="input prose" name="overview" placeholder="What this ${project ? "project" : "program"} is about, in a few sentences.">${esc(program.overview ?? "")}</textarea></label>
      <label class="field span-2">Objectives <textarea class="input prose" name="objectives" placeholder="One objective per line">${esc(program.objectives ?? "")}</textarea>
        <span class="hint">One per line.${project ? "" : " Learners see them as a list."}</span></label>
      <div class="span-2 form-actions"><button class="btn primary" type="submit">Save Details</button></div>
    </form>`;

  const form = area.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorBox = form.querySelector(".form-error");
    errorBox.hidden = true;
    const title = form.title.value.trim();
    if (!title) { errorBox.textContent = "Please give the program a title."; errorBox.hidden = false; return; }
    if (form.start_date.value && form.due_date.value && form.due_date.value < form.start_date.value) {
      errorBox.textContent = "The due date is before the start date."; errorBox.hidden = false; return;
    }
    const { error } = await sb.from("programs").update({
      title,
      program_type: project ? "project" : form.program_type.value,
      owner_id: form.owner_id.value || null,
      client: form.client.value.trim() || null,
      audience: form.audience.value.trim() || null,
      start_date: form.start_date.value || null,
      due_date: form.due_date.value || null,
      overview: form.overview.value.trim() || null,
      objectives: form.objectives.value.trim() || null,
    }).eq("id", program.id);
    if (error) { errorBox.textContent = error.message; errorBox.hidden = false; return; }
    toast("Details saved.");
    reload();
  });
}

// =====================================================================
// Welcome video, welcome message and required reading
// =====================================================================
async function welcomeTab(area, program, reload) {
  let videoUrl = "";
  if (program.welcome_video_path) {
    const { data } = await sb.storage.from(VIDEO_BUCKET).createSignedUrl(program.welcome_video_path, 3600);
    videoUrl = data?.signedUrl ?? "";
  }

  area.innerHTML = `
    <div class="stack">
      <div class="card">
        <div class="card-head"><h2>Welcome Video <span class="muted">(Optional)</span></h2></div>
        <p class="muted" style="margin-top:0">If you add a video, learners must watch it to the end before the rest of the program opens. They can't skip ahead. MP4 works best; up to ${MAX_VIDEO_MB} MB (a 2–3 minute video at 720p fits easily).</p>
        ${program.welcome_video_path ? `
          ${videoUrl ? `<video class="video-box" src="${esc(videoUrl)}" controls preload="metadata"></video>` : '<div class="notice">The video file could not be loaded.</div>'}
          <div class="row-actions">
            <label class="btn">${icons.upload} Replace Video<input type="file" accept="video/mp4,video/webm,video/quicktime" data-video hidden></label>
            <button class="btn danger" data-remove-video>Remove Video</button>
          </div>` : `
          <label class="dropzone">
            ${icons.upload}
            <strong>Choose A Video To Upload</strong>
            <span class="muted">MP4, WebM or MOV · up to ${MAX_VIDEO_MB} MB</span>
            <input type="file" accept="video/mp4,video/webm,video/quicktime" data-video hidden>
          </label>`}
        <p class="muted" data-video-status hidden></p>
      </div>

      <form class="card stack" novalidate>
        <div class="form-error" hidden></div>
        <label class="field">Welcome Message
          <textarea class="input prose" name="welcome_message" placeholder="A short welcome and orientation from the ${team()}.">${esc(program.welcome_message ?? "")}</textarea>
          <span class="hint">Shown at the top of the program, with the video.</span>
        </label>
        <label class="field">Required Reading
          <textarea class="input prose tall" name="required_reading" placeholder="e.g. How to submit your PDF certificate and completed workbook after each module.">${esc(program.required_reading ?? "")}</textarea>
          <span class="hint">If filled in, learners must tick “I have read this” before the learning journey opens.</span>
        </label>
        <div class="form-actions"><button class="btn primary" type="submit">Save Message And Reading</button></div>
      </form>
    </div>`;

  const status = area.querySelector("[data-video-status]");
  area.querySelector("[data-video]").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
      toast(`That video is ${(file.size / 1048576).toFixed(0)} MB. The limit is ${MAX_VIDEO_MB} MB; please compress it to 720p and try again.`, "err");
      e.target.value = "";
      return;
    }
    status.hidden = false;
    status.textContent = `Uploading ${file.name}… please keep this page open.`;
    const path = `${program.id}/${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
    const { error } = await sb.storage.from(VIDEO_BUCKET).upload(path, file, { contentType: file.type });
    if (error) {
      status.textContent = "";
      status.hidden = true;
      toast(`Upload failed: ${error.message}`, "err");
      return;
    }
    await sb.from("programs").update({ welcome_video_path: path }).eq("id", program.id);
    if (program.welcome_video_path) await sb.storage.from(VIDEO_BUCKET).remove([program.welcome_video_path]);
    toast("Video uploaded.");
    reload();
  });

  area.querySelector("[data-remove-video]")?.addEventListener("click", () => openModal({
    title: "Remove The Welcome Video?",
    intro: "Learners will no longer need to watch a video before starting.",
    body: "",
    submitLabel: "Remove Video",
    danger: true,
    onSubmit: async () => {
      await sb.from("programs").update({ welcome_video_path: null }).eq("id", program.id);
      await sb.storage.from(VIDEO_BUCKET).remove([program.welcome_video_path]);
      toast("Video removed.");
      reload();
    },
  }));

  const form = area.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await sb.from("programs").update({
      welcome_message: form.welcome_message.value.trim() || null,
      required_reading: form.required_reading.value.trim() || null,
    }).eq("id", program.id);
    if (error) {
      form.querySelector(".form-error").textContent = error.message;
      form.querySelector(".form-error").hidden = false;
      return;
    }
    toast("Saved.");
  });
}

// =====================================================================
// Learning journey
// =====================================================================
async function journeyTab(area, program, reload) {
  const { data: steps, error } = await sb.from("program_steps")
    .select("*, step_links(url), assessment_questions(count)")
    .eq("program_id", program.id).order("position");
  if (error) {
    area.innerHTML = `<div class="empty"><div><strong>Couldn't Load The Learning Journey</strong>${esc(error.message)}</div></div>`;
    return;
  }
  // Live sessions: scheduled vs actual from imported Teams reports
  const live = steps.filter((s) => s.step_type === "ilt_session").map((s) => s.id);
  if (live.length) {
    const { data: deliveries } = await sb.from("session_delivery").select("step_id, status, scheduled_minutes, actual_minutes, reason").in("step_id", live);
    for (const dl of deliveries ?? []) { const s = steps.find((x) => x.id === dl.step_id); if (s) s.delivery = dl; }
  }

  area.innerHTML = `
    <div class="tab-head">
      <p class="muted">The steps learners go through, in order. Drag a step to move it. Each step opens on its “available from” date (or as soon as the program is live).</p>
      <button class="btn primary" data-add>${icons.plus} Add Step</button>
    </div>
    ${steps.length ? `<ol class="steps sortable">${steps.map((s, i) => stepCard(s, i, steps.length)).join("")}</ol>`
      : '<div class="empty"><div><strong>No Steps Yet</strong>Add modules, live sessions, assessments, surveys and uploads.</div></div>'}`;

  area.querySelector("[data-add]").addEventListener("click", () => editStep(program, null, steps, reload));
  area.querySelector(".steps")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    const step = steps[i];
    if (btn.dataset.act === "edit") editStep(program, step, steps, reload);
    if (btn.dataset.act === "form") location.hash = `#/programs/${program.id}/form/${step.id}`;
    if (btn.dataset.act === "results") location.hash = `#/programs/${program.id}/results/${step.id}`;
    if (btn.dataset.act === "attendance") markAttendance(program, step, reload);
    if (btn.dataset.act === "delete") deleteStep(step, reload);
    if (btn.dataset.act === "up" || btn.dataset.act === "down") {
      const j = btn.dataset.act === "up" ? i - 1 : i + 1;
      btn.disabled = true;
      // Positions are re-numbered 1..n so swapping always works
      const order = steps.map((s) => s.id);
      [order[i], order[j]] = [order[j], order[i]];
      await Promise.all(order.map((sid, n) => sb.from("program_steps").update({ position: n + 1 }).eq("id", sid)));
      reload();
    }
  });
  const list = area.querySelector(".steps");
  if (list) makeSortable(list, steps, reload);
}

// Drag a step card up or down to reorder; the arrows still work too
function makeSortable(list, steps, reload) {
  let dragging = null;
  const before = steps.map((s) => s.id);
  list.addEventListener("dragstart", (e) => {
    dragging = e.target.closest(".step[data-id]");
    if (!dragging) return;
    dragging.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragging.dataset.id);
  });
  list.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    // Put the dragged card before the first card whose middle is below the pointer
    const next = [...list.querySelectorAll(".step[data-id]:not(.dragging)")]
      .find((el) => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (next) { if (next !== dragging.nextElementSibling) list.insertBefore(dragging, next); }
    else if (dragging !== list.lastElementChild) list.append(dragging);
  });
  list.addEventListener("drop", (e) => e.preventDefault());
  list.addEventListener("dragend", async () => {
    if (!dragging) return;
    dragging.classList.remove("dragging");
    dragging = null;
    const order = [...list.querySelectorAll(".step[data-id]")].map((el) => el.dataset.id);
    if (order.join() === before.join()) return;
    list.querySelectorAll(".step-num span").forEach((el, n) => { el.textContent = n + 1; });
    list.classList.add("saving");
    const results = await Promise.all(order.map((sid, n) => sb.from("program_steps").update({ position: n + 1 }).eq("id", sid)));
    const failed = results.find((r) => r.error);
    toast(failed ? `Couldn't save the new order: ${failed.error.message}` : "New order saved.", failed ? "err" : undefined);
    reload();
  });
}

const GRIP = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

function stepCard(s, i, total) {
  const url = linkOf(s);
  const qCount = s.assessment_questions?.[0]?.count ?? 0;
  // A survey is either built here (questions) or an external link
  const needsLink = ["module", "ilt_session", "resource"].includes(s.step_type) || (s.step_type === "survey" && !qCount);
  const meta = [
    s.step_type === "ilt_session" && s.session_start &&
      `Session ${esc(fmtDateTime(s.session_start))}${s.session_end ? ` – ${esc(new Date(s.session_end).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }))}` : ""}`,
    `Available ${s.unlock_at ? `from ${esc(fmtDateTime(s.unlock_at))}` : "when the program goes live"}`,
    s.close_at && `Closes ${esc(fmtDateTime(s.close_at))}`,
    s.due_at && `Due ${esc(fmtDateTime(s.due_at))}`,
    s.standard_minutes && `Standard ${fmtMin(s.standard_minutes)}`,
  ].filter(Boolean);
  const flags = [
    needsLink && !url && (s.step_type === "survey" ? '<span class="pill crit">Not Set Up: Build It Or Add A Link</span>' : '<span class="pill crit">Link Missing</span>'),
    s.step_type === "survey" && qCount && `<span class="pill">${qCount} Question${qCount === 1 ? "" : "s"}</span>`,
    s.step_type === "module" && url && !s.completion_text && '<span class="pill warn">Add Final Screen Words</span>',
    s.step_type === "module" && url && s.completion_text && !sameSite(url) && '<span class="pill crit">Different Website: Can\'t Track</span>',
    s.step_type === "assessment" && (qCount ? `<span class="pill">${qCount} Question${qCount === 1 ? "" : "s"}</span>` : '<span class="pill crit">No Questions</span>'),
    s.step_type === "assessment" && s.passing_score != null && `<span class="pill">Pass Mark ${Number(s.passing_score)}%</span>`,
    s.step_type === "assessment" && s.time_limit_minutes && `<span class="pill">${icons.clock} ${s.time_limit_minutes} Min</span>`,
    s.step_type === "assessment" && s.max_attempts && `<span class="pill">${s.max_attempts} Attempt${s.max_attempts === 1 ? "" : "s"}</span>`,
    s.step_type === "upload" && (s.max_files ?? 1) > 1 && `<span class="pill">Up To ${s.max_files} Files</span>`,
    s.step_type === "upload" && '<span class="pill teal">Checked By Trainer</span>',
    s.step_type === "resource" ? '<span class="pill">Extra (Not Counted)</span>' : !s.is_required && '<span class="pill">Optional</span>',
    s.delivery?.status === "needs_confirmation" && `<span class="pill warn" title="Open Attendance → View Teams Report to confirm">${icons.flag} Session Length Needs Confirmation</span>`,
    s.delivery && s.delivery.status !== "needs_confirmation" && `<span class="pill ${s.delivery.status === "matched" ? "good" : "teal"}">Delivered ${fmtMin(s.delivery.actual_minutes)}${s.delivery.status === "matched" ? "" : ` · ${esc(diffText(s.delivery.actual_minutes, s.delivery.scheduled_minutes))}${s.delivery.reason ? ` · ${esc(s.delivery.reason)}` : ""}`}</span>`,
  ].filter(Boolean);

  return `
    <li class="step" draggable="true" data-id="${s.id}">
      <div class="step-grip" title="Drag to move" aria-hidden="true">${GRIP}</div>
      <div class="step-num"><span>${i + 1}</span></div>
      <div class="step-icon">${stepIcon(s.step_type)}</div>
      <div class="step-body">
        <div class="step-type">${esc(STEP_TYPE[s.step_type].short)}</div>
        <strong>${esc(s.title)}</strong>
        <div class="step-meta">${meta.join(" · ")}</div>
        ${flags.length ? `<div class="step-flags">${flags.join("")}</div>` : ""}
      </div>
      <div class="step-actions">
        ${["assessment", "survey"].includes(s.step_type) ? `
          <button class="btn sm primary" data-act="form" data-i="${i}">Build</button>
          <button class="btn sm" data-act="results" data-i="${i}">${s.step_type === "assessment" ? "Results" : "Responses"}</button>` : ""}
        ${s.step_type === "ilt_session" ? `<button class="btn sm" data-act="attendance" data-i="${i}">Attendance</button>` : ""}
        <button class="btn sm" data-act="edit" data-i="${i}">Edit</button>
        <button class="btn sm ghost icon" data-act="up" data-i="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">${icons.up}</button>
        <button class="btn sm ghost icon" data-act="down" data-i="${i}" ${i === total - 1 ? "disabled" : ""} aria-label="Move down">${icons.down}</button>
        <button class="btn sm ghost icon danger" data-act="delete" data-i="${i}" aria-label="Delete step">${icons.trash}</button>
      </div>
    </li>`;
}

function editStep(program, step, steps, reload) {
  const s = step ?? { step_type: "module", is_required: true };
  const { form } = openModal({
    title: step ? "Edit Step" : "Add Step",
    wide: true,
    body: `
      <div class="two">
        <label class="field">Step Type
          <select class="select" name="step_type">
            ${Object.entries(STEP_TYPE).map(([k, t]) => `<option value="${k}" ${k === s.step_type ? "selected" : ""}>${t.label}</option>`).join("")}
          </select>
        </label>
        <label class="field">Title <input class="input" name="title" value="${esc(s.title ?? "")}" placeholder="e.g. Module 1: Leading with empathy"></label>
      </div>
      <label class="field">Instructions For Learners <span class="hint">(Optional)</span>
        <textarea class="input prose short" name="description">${esc(s.description ?? "")}</textarea>
      </label>
      <label class="field" data-for="module ilt_session survey resource">Link
        <input class="input" name="url" type="url" value="${esc(linkOf(s))}" placeholder="https://">
        <span class="hint" data-link-hint></span>
      </label>
      <label class="field" data-for="module">Final Screen Words
        <input class="input" name="completion_text" value="${esc(s.completion_text ?? "")}" placeholder="e.g. Congratulations">
        <span class="hint">A few words that appear only on the module's last screen. When a learner reaches that screen, the module is marked Completed. If that screen shows a score (e.g. “Score: 85%”), it's recorded too.</span>
      </label>
      <div class="two" data-for="ilt_session">
        <label class="field">Session Starts <input class="input" type="datetime-local" name="session_start" value="${toLocalInput(s.session_start)}"></label>
        <label class="field">Session Ends <input class="input" type="datetime-local" name="session_end" value="${toLocalInput(s.session_end)}"></label>
      </div>
      <div class="two">
        <label class="field">Available From
          <input class="input" type="datetime-local" name="unlock_at" value="${toLocalInput(s.unlock_at)}">
          <span class="hint" data-unlock-hint></span>
        </label>
        <label class="field" data-for="module ilt_session assessment survey upload">Due <span class="hint">(Optional)</span>
          <input class="input" type="datetime-local" name="due_at" value="${toLocalInput(s.due_at)}">
        </label>
      </div>
      <label class="field" data-for="upload">Files Allowed
        <select class="select" name="max_files">
          ${Array.from({ length: 10 }, (_, k) => k + 1).map((n) => `<option value="${n}" ${n === (s.max_files ?? 1) ? "selected" : ""}>${n === 1 ? "1 File" : `Up To ${n} Files`}</option>`).join("")}
        </select>
        <span class="hint">How many files a learner can send for this step (PDF, PNG or JPG, up to 5 MB each). A trainer approves or returns them together.</span>
      </label>
      <label class="field" data-for="module upload">Standard Duration (Minutes) <span class="hint">(Optional)</span>
        <input class="input" type="number" name="standard_minutes" min="1" max="6000" step="1" value="${s.standard_minutes ?? ""}" placeholder="e.g. 120" style="max-width:160px">
        <span class="hint">How long this learning normally takes. Modules taken in ${brand.platform} count the learner's actual active time (up to twice this). For courses taken outside the tool, trainers confirm the hours when approving the certificate, starting from this number.</span>
      </label>
      <div class="notice info" data-for="assessment survey">After saving, click <b>Build</b> on this step to add sections, questions, the timer and other settings.</div>
      <label class="check" data-for="module ilt_session assessment survey upload"><input type="checkbox" name="is_required" ${s.is_required ? "checked" : ""}> Counts Toward Completion</label>`,
    submitLabel: step ? "Save Step" : "Add Step",
    onSubmit: async (f) => {
      const type = f.step_type.value;
      const title = f.title.value.trim();
      if (!title) throw new Error("Please give the step a title.");
      const url = f.url.value.trim();
      if (url && !/^https?:\/\//i.test(url)) throw new Error("The link should start with https://");

      const sessionStart = type === "ilt_session" ? fromLocalInput(f.session_start.value) : null;
      const sessionEnd = type === "ilt_session" ? fromLocalInput(f.session_end.value) : null;
      if (sessionStart && sessionEnd && sessionEnd <= sessionStart) throw new Error("The session ends before it starts.");
      let unlockAt = fromLocalInput(f.unlock_at.value);
      // A Teams link opens on the day of the session unless a time is set
      if (!unlockAt && sessionStart) {
        const day = new Date(sessionStart);
        day.setHours(0, 0, 0, 0);
        unlockAt = day.toISOString();
      }

      const row = {
        step_type: type,
        title,
        description: f.description.value.trim() || null,
        session_start: sessionStart,
        session_end: sessionEnd,
        unlock_at: unlockAt,
        due_at: type === "resource" ? null : fromLocalInput(f.due_at.value),
        completion_text: type === "module" ? f.completion_text.value.trim() || null : null,
        is_required: type === "resource" ? false : f.is_required.checked,
        max_files: type === "upload" ? Number(f.max_files.value) || 1 : 1,
        standard_minutes: ["module", "upload"].includes(type) && Number(f.standard_minutes.value) > 0 ? Math.round(Number(f.standard_minutes.value)) : null,
      };
      if (row.standard_minutes && row.standard_minutes > 6000) throw new Error("The standard duration can be up to 6000 minutes.");

      let stepId = step?.id;
      if (step) {
        const { error } = await sb.from("program_steps").update(row).eq("id", step.id);
        if (error) throw error;
      } else {
        const position = Math.max(0, ...steps.map((x) => x.position)) + 1;
        const { data, error } = await sb.from("program_steps").insert({ ...row, program_id: program.id, position }).select("id").single();
        if (error) throw error;
        stepId = data.id;
      }

      const needsLink = ["module", "ilt_session", "survey", "resource"].includes(type);
      if (needsLink && url) {
        const { error } = await sb.from("step_links").upsert({ step_id: stepId, url });
        if (error) throw error;
      } else {
        await sb.from("step_links").delete().eq("step_id", stepId);
      }
      toast(step ? "Step saved." : "Step added.");
      reload();
      // New assessments and surveys go straight to the builder
      if (!step && (type === "assessment" || (type === "survey" && !url))) location.hash = `#/programs/${program.id}/form/${stepId}`;
    },
  });

  // Show only the fields that apply to the chosen type
  const sync = () => {
    const type = form.step_type.value;
    form.querySelectorAll("[data-for]").forEach((el) => { el.hidden = !el.dataset.for.split(" ").includes(type); });
    form.querySelector("[data-link-hint]").textContent = LINK_HINT[type] ?? "";
    form.querySelector("[data-unlock-hint]").textContent = type === "ilt_session"
      ? "Leave empty to open the Teams link on the day of the session."
      : "Learners can't open it, or see its link, before this. Leave empty to open as soon as the program is live.";
  };
  form.step_type.addEventListener("change", sync);
  sync();
}

// Live sessions are completed when Trainer records who attended
async function markAttendance(program, step, reload) {
  const [{ data: enrolled, error }, { data: progress }, { data: teams }] = await Promise.all([
    sb.from("enrollments").select("id, learner:profiles(full_name, email), enrollment_exclusions(step_id)").eq("program_id", program.id),
    sb.from("step_progress").select("enrollment_id, status").eq("step_id", step.id),
    sb.from("session_attendance").select("email, minutes, attended, required_minutes, imported_at").eq("step_id", step.id),
  ]);
  const { data: delivery } = await sb.from("session_delivery").select("status").eq("step_id", step.id).maybeSingle();
  const unconfirmed = delivery?.status === "needs_confirmation";
  // Minutes from the imported Teams report, by email
  const teamsBy = new Map((teams ?? []).filter((r) => r.email).map((r) => [r.email, r]));
  const teamsBar = `<div class="ta-bar">
      <span class="muted small">${unconfirmed ? `<span class="pill warn">${icons.flag} Session Length Needs Confirmation</span> Open the Teams report to confirm. Nobody is marked from it until then.` : teams?.length ? `Teams report imported ${esc(fmtDateTime(teams[0].imported_at))} · ${teams.length} joined` : "Have the Teams attendance report? Import it to tick everyone automatically."}</span>
      <span style="display:flex;gap:6px;flex-wrap:wrap">
        ${teams?.length ? `<button type="button" class="btn sm ${unconfirmed ? "primary" : ""}" data-teams-view>${unconfirmed ? "Confirm Session" : "View Teams Report"}</button>` : ""}
        <button type="button" class="btn sm primary" data-teams-import>${icons.upload} Import Teams Report</button>
      </span>
    </div>`;
  if (error) return toast(error.message, "err");
  const attended = new Set((progress ?? []).filter((p) => p.status === "completed").map((p) => p.enrollment_id));
  // Learners who had this session removed don't appear
  for (let i = enrolled.length - 1; i >= 0; i--) {
    if ((enrolled[i].enrollment_exclusions ?? []).some((x) => x.step_id === step.id)) enrolled.splice(i, 1);
  }
  enrolled.sort((a, b) => a.learner.full_name.localeCompare(b.learner.full_name));

  const { form } = openModal({
    title: `Attendance: ${step.title}`,
    intro: step.session_start ? `Session on ${esc(fmtDateTime(step.session_start))}. Tick everyone who attended.` : "Tick everyone who attended.",
    wide: true,
    body: enrolled.length ? `
      ${teamsBar}
      <div class="toolbar" style="margin:0">
        <label class="check"><input type="checkbox" data-all> Select All</label>
        <span class="count" data-picked></span>
      </div>
      <div class="checklist">
        ${enrolled.map((e) => `
          <label class="check-row">
            <input type="checkbox" value="${e.id}" ${attended.has(e.id) ? "checked" : ""}>
            <span><strong>${esc(e.learner.full_name)}</strong><span class="muted">${esc(e.learner.email)}</span></span>
            ${teams?.length ? (() => { const r = teamsBy.get(String(e.learner.email ?? "").toLowerCase());
              const tr = r && tierOf(r.minutes, r.required_minutes);
              return r ? `<span class="pill ${tr.cls}" style="margin-left:auto">Teams: ${tr.label} · ${fmtMin(r.minutes)} (${tr.pct}%)</span>` : '<span class="pill crit" style="margin-left:auto">Teams: Absent · Did Not Join</span>'; })() : ""}
          </label>`).join("")}
      </div>` : `${teamsBar}<div class="empty"><div><strong>No Learners Enrolled</strong>Enroll learners on the Learners tab first. A Teams report imported now is kept, and people are marked attended when they're enrolled.</div></div>`,
    submitLabel: enrolled.length ? "Save Attendance" : "",
    cancelLabel: enrolled.length ? "Cancel" : "Close",
    onSubmit: async (f) => {
      const ticked = new Set([...f.querySelectorAll(".checklist input:checked")].map((c) => c.value));
      const when = step.session_end ?? step.session_start ?? new Date().toISOString();
      const added = [...ticked].filter((id) => !attended.has(id));
      const removed = [...attended].filter((id) => !ticked.has(id));
      if (added.length) {
        const { error: err } = await sb.from("step_progress").upsert(
          added.map((enrollment_id) => ({ enrollment_id, step_id: step.id, status: "completed", started_at: when, completed_at: when })),
          { onConflict: "enrollment_id,step_id" });
        if (err) throw err;
      }
      if (removed.length) {
        const { error: err } = await sb.from("step_progress").update({ status: "not_started", completed_at: null })
          .eq("step_id", step.id).in("enrollment_id", removed);
        if (err) throw err;
      }
      toast(`Attendance saved: ${ticked.size} of ${enrolled.length} attended.`);
      reload();
    },
  });
  const closeThen = (fn) => () => { form.closest(".modal-backdrop").remove(); fn(program, step, reload); };
  form.querySelector("[data-teams-import]").addEventListener("click", closeThen(importTeamsReport));
  form.querySelector("[data-teams-view]")?.addEventListener("click", closeThen(showTeamsReport));
  if (!enrolled.length) return;
  const boxes = [...form.querySelectorAll(".checklist input")];
  const count = () => { form.querySelector("[data-picked]").textContent = `${boxes.filter((b) => b.checked).length} of ${boxes.length} attended`; };
  form.querySelector("[data-all]").addEventListener("change", (e) => { boxes.forEach((b) => { b.checked = e.target.checked; }); count(); });
  form.querySelector(".checklist").addEventListener("change", count);
  count();
}

function deleteStep(step, reload) {
  openModal({
    title: `Delete “${step.title}”?`,
    intro: "This also removes learners' progress, scores and uploads for this step.",
    body: "",
    submitLabel: "Delete Step",
    danger: true,
    onSubmit: async () => {
      const { error } = await sb.from("program_steps").delete().eq("id", step.id);
      if (error) throw error;
      toast("Step deleted.");
      reload();
    },
  });
}

// =====================================================================
// Learners (enrolments)
// =====================================================================
async function learnersTab(area, program, reload) {
  const [{ data: enrolled, error }, { data: progress }, { data: steps }] = await Promise.all([
    sb.from("enrollments")
      .select("id, learner_id, due_date_override, enrolled_at, learner:profiles(full_name, email, is_active, department, designation, market), enrollment_exclusions(step_id)")
      .eq("program_id", program.id),
    sb.from("v_enrollment_progress").select("enrollment_id, percent_complete, completed_steps, required_steps, last_activity").eq("program_id", program.id),
    sb.from("program_steps").select("*").eq("program_id", program.id).order("position"),
  ]);
  if (error) {
    area.innerHTML = `<div class="empty"><div><strong>Couldn't Load Learners</strong>${esc(error.message)}</div></div>`;
    return;
  }
  const prog = Object.fromEntries((progress ?? []).map((p) => [p.enrollment_id, p]));
  enrolled.sort((a, b) => a.learner.full_name.localeCompare(b.learner.full_name));

  area.innerHTML = `
    <div class="tab-head">
      <p class="muted">${enrolled.length} learner${enrolled.length === 1 ? "" : "s"} enrolled. To enroll someone new, create their account on the People page first.</p>
      <button class="btn primary" data-add>${icons.plus} Enroll Learners</button>
    </div>
    ${enrolled.length ? `
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>Learner</th><th>Department</th><th>Progress</th><th>Due Date</th><th>Last Activity</th><th></th></tr></thead>
          <tbody>${enrolled.map((e) => {
            const p = prog[e.id];
            const pct = Math.round(Number(p?.percent_complete ?? 0));
            const due = e.due_date_override ?? program.due_date;
            return `
              <tr class="${e.learner.is_active ? "" : "inactive"}">
                <td class="name"><strong>${esc(e.learner.full_name)}</strong><span>${esc(e.learner.email)}</span></td>
                <td class="name"><strong>${esc(e.learner.department || "–")}</strong><span>${esc([e.learner.designation, e.learner.market].filter(Boolean).join(" · "))}</span></td>
                <td><div class="meter"><i style="width:${pct}%"></i></div> ${pct}% <span class="muted">(${p?.completed_steps ?? 0}/${p?.required_steps ?? 0})</span>
                  ${e.enrollment_exclusions?.length ? `<div><span class="pill teal">Custom: ${(steps ?? []).length - e.enrollment_exclusions.length} Of ${(steps ?? []).length} Steps</span></div>` : ""}</td>
                <td>${due ? esc(fmtDate(due)) : '<span class="muted">–</span>'} ${e.due_date_override ? '<span class="pill warn">Extended</span>' : ""}</td>
                <td>${p?.last_activity ? esc(fmtDate(p.last_activity)) : ""}</td>
                <td class="actions">
                  <button class="btn sm" data-status="${e.id}">Step Status</button>
                  <button class="btn sm" data-steps="${e.id}">Customize Steps</button>
                  <a class="btn sm" href="#/preview/${e.learner_id}/${program.id}">View As Learner</a>
                  <button class="btn sm" data-extend="${e.id}">Deadline</button>
                  <button class="btn sm ghost icon danger" data-remove="${e.id}" aria-label="Remove from program">${icons.trash}</button>
                </td>
              </tr>`;
          }).join("")}</tbody>
        </table>
      </div>` : '<div class="empty"><div><strong>No Learners Yet</strong>Click <b>Enroll Learners</b> to add people to this program.</div></div>'}`;

  area.querySelector("[data-add]").addEventListener("click", () => enrollLearners(program, enrolled, reload));
  area.querySelector("tbody")?.addEventListener("click", (e) => {
    const ext = e.target.closest("[data-extend]");
    const rem = e.target.closest("[data-remove]");
    const cus = e.target.closest("[data-steps]");
    const sts = e.target.closest("[data-status]");
    if (sts) stepStatus(enrolled.find((x) => x.id === sts.dataset.status), steps ?? [], reload);
    if (cus) customizeSteps(enrolled.find((x) => x.id === cus.dataset.steps), steps ?? [], reload);
    if (ext) extendDeadline(program, enrolled.find((x) => x.id === ext.dataset.extend), reload);
    if (rem) removeEnrollment(enrolled.find((x) => x.id === rem.dataset.remove), reload);
  });
}

// Admin or a trainer marks a step Completed / Not Completed for one learner,
// with a reason (kept on the step and in the Activity Log)
const STEP_STATUS = {
  completed: ["Completed", "good"], submitted: ["Waiting For Review", "prog"], rejected: ["Returned", "crit"],
  in_progress: ["In Progress", "prog"], not_started: ["Not Started", ""],
};
const OVERRIDE_REASONS = [
  "Completed Outside The Portal (Proof On File)",
  "File Too Large To Upload (Proof Received Another Way)",
  "Completed In Person",
  "Other",
];

async function stepStatus(enrollment, steps, reload) {
  const [{ data: progress, error }, { data: pending }, { data: times }] = await Promise.all([
    sb.from("step_progress").select("*, overrider:profiles!step_progress_override_by_fkey(full_name)").eq("enrollment_id", enrollment.id),
    sb.from("uploads").select("step_id").eq("enrollment_id", enrollment.id).eq("status", "pending"),
    sb.from("step_time").select("step_id, active_seconds").eq("enrollment_id", enrollment.id),
  ]);
  if (error) return toast(error.message, "err");
  const byStep = Object.fromEntries((progress ?? []).map((p) => [p.step_id, p]));
  const activeBy = Object.fromEntries((times ?? []).map((x) => [x.step_id, x.active_seconds]));
  const hoursLine = (s) => {
    const lm = learningMinutes(s, byStep[s.id], activeBy[s.id] ?? 0);
    if (lm.source === "confirmed") return `Learning hours: ${fmtMin(lm.minutes)} (confirmed by staff)`;
    if (lm.source === "tracked") return `Learning hours: ${fmtMin(lm.minutes)} (tracked in the tool)`;
    if (lm.source === "unconfirmed") return `Learning hours: not confirmed yet (standard ${fmtMin(s.standard_minutes)})`;
    return "";
  };
  const canCredit = (s) => !["ilt_session", "resource"].includes(s.step_type);
  const waiting = new Set((pending ?? []).map((u) => u.step_id));
  const removed = new Set((enrollment.enrollment_exclusions ?? []).map((x) => x.step_id));
  const mine = steps.filter((s) => !removed.has(s.id));

  const { form } = openModal({
    title: `Step Status: ${enrollment.learner.full_name}`,
    intro: "Mark a step Completed when there's a good reason, for example it was done outside the portal or the file was too large to upload. The reason is saved and logged.",
    wide: true,
    body: mine.length ? `<div class="ss-list">${mine.map((s) => {
      const p = byStep[s.id];
      const key = p?.status === "completed" ? "completed" : waiting.has(s.id) ? "submitted" : p?.status ?? "not_started";
      const [label, cls] = STEP_STATUS[key] ?? STEP_STATUS.not_started;
      return `<div class="ss-row">
        <div>
          <strong>${s.position}. ${esc(s.title)}</strong>
          <span class="muted">${esc(STEP_TYPE[s.step_type].short)}${s.is_required ? "" : " · Optional"}</span>
          <span class="pill ${cls}">${label}</span>
          ${p?.override_reason ? `<span class="ss-why">${esc(p.overrider?.full_name ?? "Staff")} on ${esc(fmtDate(p.override_at))}: “${esc(p.override_reason)}”</span>` : ""}
          ${key === "completed" && hoursLine(s) ? `<span class="ss-why">${esc(hoursLine(s))}</span>` : ""}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
        ${key === "completed" && canCredit(s) ? `<button type="button" class="btn sm" data-hours="${s.id}">${icons.clock} Hours</button>` : ""}
        ${key === "completed"
          ? `<button type="button" class="btn sm" data-set="${s.id}" data-done="0">Mark Not Completed</button>`
          : `<button type="button" class="btn sm primary" data-set="${s.id}" data-done="1">${icons.check} Mark Completed</button>`}
        </div>
      </div>`;
    }).join("")}</div>` : '<div class="empty"><div><strong>No Steps</strong>This learner has no steps.</div></div>',
    submitLabel: "Close",
    cancelLabel: "",
  });
  form.querySelector(".ss-list")?.addEventListener("click", (ev) => {
    const h = ev.target.closest("[data-hours]");
    if (h) {
      const s = mine.find((x) => x.id === h.dataset.hours);
      const lm = learningMinutes(s, byStep[s.id], activeBy[s.id] ?? 0);
      form.closest(".modal-backdrop").remove();
      return confirmHours(enrollment, s, lm.minutes ? Math.round(lm.minutes) : s.standard_minutes ?? "", () => stepStatus(enrollment, steps, reload));
    }
    const b = ev.target.closest("[data-set]");
    if (!b) return;
    form.closest(".modal-backdrop").remove();
    setStepStatus(enrollment, steps, mine.find((s) => s.id === b.dataset.set), b.dataset.done === "1", reload);
  });
}

// Admin or a trainer confirms the learning hours credited for one learner's step
export function confirmHours(enrollment, step, minutes, after) {
  openModal({
    title: `Learning Hours: ${step.title}`,
    intro: `For <b>${esc(enrollment.learner.full_name)}</b>.${step.standard_minutes ? ` Standard duration: ${fmtMin(step.standard_minutes)}.` : ""} These hours count toward Learner Hours Trained on the Dashboard.`,
    body: `<label class="field">Hours To Credit (Minutes)
      <input class="input" type="number" name="mins" min="0" max="6000" step="1" value="${esc(minutes)}" style="max-width:160px">
      <span class="hint">Leave empty to remove confirmed hours (a module taken in the tool then uses its tracked time).</span></label>`,
    submitLabel: "Confirm Hours",
    onSubmit: async (f) => {
      const v = f.mins.value === "" ? null : Number(f.mins.value);
      if (v != null && !(v >= 0 && v <= 6000)) throw new Error("Enter between 0 and 6000 minutes.");
      const { error } = await sb.rpc("set_step_hours", { p_enrollment: enrollment.id, p_step: step.id, p_minutes: v });
      if (error) throw error;
      toast(v == null ? "Confirmed hours removed." : `${fmtMin(v)} confirmed for ${enrollment.learner.full_name}.`);
      after?.();
    },
  });
}

function setStepStatus(enrollment, steps, step, completed, reload) {
  const today = new Date().toISOString().slice(0, 10);
  const { form } = openModal({
    title: `${completed ? "Mark Completed" : "Mark Not Completed"}: ${step.title}`,
    intro: `For <b>${esc(enrollment.learner.full_name)}</b>. ${completed ? "This counts toward their completion straight away." : "They'll need to do this step again."}`,
    body: `
      <label class="field">Reason
        <select class="select" name="why">${(completed ? OVERRIDE_REASONS : ["Marked Completed By Mistake", "Proof Not Accepted", "Other"]).map((r) => `<option>${esc(r)}</option>`).join("")}</select></label>
      <label class="field">Details <input class="input" name="details" placeholder="e.g. Certificate emailed to the Trainer on 12 Nov"></label>
      ${completed ? `<label class="field">Completed On <input class="input" type="date" name="day" value="${today}" max="${today}" style="max-width:200px"></label>` : ""}
      ${completed && !["ilt_session", "resource"].includes(step.step_type) ? `<label class="field">Learning Hours To Credit (Minutes) <span class="hint">(Optional)</span>
        <input class="input" type="number" name="mins" min="0" max="6000" step="1" value="${step.standard_minutes ?? ""}" style="max-width:160px">
        <span class="hint">${step.standard_minutes ? `Starts from the standard duration (${fmtMin(step.standard_minutes)}). ` : ""}Counts toward Learner Hours Trained.</span></label>` : ""}`,
    submitLabel: completed ? "Mark Completed" : "Mark Not Completed",
    onSubmit: async (f) => {
      const details = f.details.value.trim();
      if (f.why.value === "Other" && !details) throw new Error("Please add details for “Other”.");
      const reason = f.why.value === "Other" ? details : details ? `${f.why.value}: ${details}` : f.why.value;
      const { error } = await sb.rpc("override_step_status", {
        p_enrollment: enrollment.id, p_step: step.id, p_completed: completed, p_reason: reason, p_date: completed ? f.day.value || null : null,
      });
      if (error) throw error;
      if (completed && f.mins && f.mins.value !== "") {
        const v = Number(f.mins.value);
        if (!(v >= 0 && v <= 6000)) throw new Error("Enter between 0 and 6000 minutes.");
        const { error: hErr } = await sb.rpc("set_step_hours", { p_enrollment: enrollment.id, p_step: step.id, p_minutes: v });
        if (hErr) throw hErr;
      }
      toast(`${step.title}: marked ${completed ? "Completed" : "Not Completed"} for ${enrollment.learner.full_name}.`);
      reload();
      stepStatus(enrollment, steps, reload);
    },
  });
  form.querySelector("[name=why]").focus();
}

// Choose which steps one learner must do (e.g. 1 of 3 modules). Removed steps
// are hidden from them and don't count toward their completion.
function customizeSteps(enrollment, steps, reload) {
  const removed = new Set((enrollment.enrollment_exclusions ?? []).map((x) => x.step_id));
  const { form } = openModal({
    title: `Customize Steps: ${enrollment.learner.full_name}`,
    intro: "Untick any step this learner doesn't need. They won't see it, and it won't count toward their completion. They stay in the program.",
    wide: true,
    body: steps.length ? `
      <div class="toolbar" style="margin:0">
        <label class="check"><input type="checkbox" data-all> Select All</label>
        <span class="count" data-picked></span>
      </div>
      <div class="checklist">
        ${steps.map((s) => `
          <label class="check-row">
            <input type="checkbox" value="${s.id}" ${removed.has(s.id) ? "" : "checked"}>
            <span class="step-icon mini">${stepIcon(s.step_type)}</span>
            <span><strong>${s.position}. ${esc(s.title)}</strong><span class="muted">${esc(STEP_TYPE[s.step_type].short)}${s.is_required ? "" : " · Optional"}</span></span>
          </label>`).join("")}
      </div>
      <p class="muted small" style="margin:0">Any progress already made on a removed step is kept, and comes back if you add the step again.</p>`
      : '<div class="empty"><div><strong>No Steps Yet</strong>Add steps on the Learning Journey tab first.</div></div>',
    submitLabel: steps.length ? "Save Steps" : "",
    cancelLabel: steps.length ? "Cancel" : "Close",
    onSubmit: async (f) => {
      const keep = new Set([...f.querySelectorAll(".checklist input:checked")].map((c) => c.value));
      if (!keep.size) throw new Error("Keep at least one step. To take someone out of the program, use the bin button instead.");
      const nowRemoved = steps.filter((s) => !keep.has(s.id)).map((s) => s.id);
      const add = nowRemoved.filter((id) => !removed.has(id));
      const back = [...removed].filter((id) => keep.has(id));
      if (add.length) {
        const { error } = await sb.from("enrollment_exclusions").insert(add.map((step_id) => ({ enrollment_id: enrollment.id, step_id })));
        if (error) throw error;
      }
      if (back.length) {
        const { error } = await sb.from("enrollment_exclusions").delete().eq("enrollment_id", enrollment.id).in("step_id", back);
        if (error) throw error;
      }
      toast(nowRemoved.length ? `${enrollment.learner.full_name} now has ${keep.size} of ${steps.length} steps.` : `${enrollment.learner.full_name} has every step.`);
      reload();
    },
  });
  if (!steps.length) return;
  const boxes = [...form.querySelectorAll(".checklist input")];
  const count = () => { form.querySelector("[data-picked]").textContent = `${boxes.filter((b) => b.checked).length} of ${boxes.length} steps`; };
  form.querySelector("[data-all]").addEventListener("change", (e) => { boxes.forEach((b) => { b.checked = e.target.checked; }); count(); });
  form.querySelector(".checklist").addEventListener("change", count);
  count();
}

async function enrollLearners(program, enrolled, reload) {
  const taken = new Set(enrolled.map((e) => e.learner_id));
  const { data: learners, error } = await sb.from("profiles").select("id, full_name, email, department, market, manager")
    .eq("role", "learner").eq("is_active", true).order("full_name");
  if (error) return toast(error.message, "err");
  const available = learners.filter((l) => !taken.has(l.id));

  const { form } = openModal({
    title: "Enroll Learners",
    intro: available.length ? "Tick the learners to add to this program." : "",
    wide: true,
    body: available.length ? `
      <div class="toolbar" style="margin:0">
        <input class="input search" type="search" placeholder="Search name, email, department, market, manager" data-search>
        <label class="check"><input type="checkbox" data-all> Select All Shown</label>
        <span class="count" data-picked>0 selected</span>
      </div>
      <div class="checklist">
        ${available.map((l) => `
          <label class="check-row" data-text="${esc([l.full_name, l.email, l.department, l.market, l.manager].join(" ").toLowerCase())}">
            <input type="checkbox" value="${l.id}">
            <span><strong>${esc(l.full_name)}</strong><span class="muted">${esc([l.email, l.department, l.market].filter(Boolean).join(" · "))}</span></span>
          </label>`).join("")}
      </div>` : '<div class="empty"><div><strong>Everyone Is Already Enrolled</strong>Create new learner accounts on the People page.</div></div>',
    submitLabel: available.length ? "Enroll Selected" : "",
    cancelLabel: available.length ? "Cancel" : "Close",
    onSubmit: async (f) => {
      const ids = [...f.querySelectorAll(".checklist input:checked")].map((c) => c.value);
      if (!ids.length) throw new Error("Tick at least one learner.");
      const { error: insErr } = await sb.from("enrollments").insert(ids.map((learner_id) => ({ program_id: program.id, learner_id })));
      if (insErr) throw insErr;
      toast(`${ids.length} learner${ids.length === 1 ? "" : "s"} enrolled.`);
      reload();
    },
  });
  if (!available.length) return;

  const rows = [...form.querySelectorAll(".check-row")];
  const picked = form.querySelector("[data-picked]");
  const count = () => { picked.textContent = `${form.querySelectorAll(".checklist input:checked").length} selected`; };
  form.querySelector("[data-search]").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    rows.forEach((r) => { r.hidden = q && !r.dataset.text.includes(q); });
  });
  form.querySelector("[data-all]").addEventListener("change", (e) => {
    rows.filter((r) => !r.hidden).forEach((r) => { r.querySelector("input").checked = e.target.checked; });
    count();
  });
  form.querySelector(".checklist").addEventListener("change", count);
}

function extendDeadline(program, enrollment, reload) {
  openModal({
    title: `Deadline For ${enrollment.learner.full_name}`,
    intro: program.due_date ? `The program due date is ${esc(fmtDate(program.due_date))}.` : "The program has no due date yet.",
    body: `<label class="field">Personal Due Date
      <input class="input" type="date" name="due" value="${esc(enrollment.due_date_override ?? "")}">
      <span class="hint">Leave empty to use the program due date.</span></label>`,
    submitLabel: "Save Deadline",
    onSubmit: async (f) => {
      const { error } = await sb.from("enrollments").update({ due_date_override: f.due.value || null }).eq("id", enrollment.id);
      if (error) throw error;
      toast("Deadline saved.");
      reload();
    },
  });
}

function removeEnrollment(enrollment, reload) {
  openModal({
    title: `Remove ${enrollment.learner.full_name} From This Program?`,
    intro: "Their progress, scores and uploads for this program are deleted. Their account is not affected.",
    body: "",
    submitLabel: "Remove",
    danger: true,
    onSubmit: async () => {
      const { error } = await sb.from("enrollments").delete().eq("id", enrollment.id);
      if (error) throw error;
      toast("Learner removed.");
      reload();
    },
  });
}
