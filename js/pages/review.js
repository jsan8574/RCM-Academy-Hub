// Review Queue: Trainer checks uploaded certificates and workbooks.
// Only approved uploads count toward a learner's completion.
// Files a learner sent together (same step, same moment) are reviewed together.
import { sb } from "../supabase.js";
import { esc, toast, openModal, icons, fmtDateTime } from "../ui.js";

const UPLOAD_BUCKET = "learner-uploads";
const STATUS = {
  pending:  { label: "Waiting For Review", pill: "prog" },
  approved: { label: "Approved", pill: "good" },
  rejected: { label: "Returned", pill: "crit" },
};
const filters = { status: "pending", program: "", q: "" };

export async function renderReview(main) {
  main.innerHTML = `
    <header class="topbar">
      <div><h1>Review Queue</h1><p>Check uploaded certificates and workbooks. Only approved files count toward completion.</p></div>
      <div class="top-actions"><button class="btn primary" data-approve-selected disabled>Approve Selected</button></div>
    </header>
    <div class="toolbar">
      <input class="input search" type="search" placeholder="Search learner or file" data-f="q" value="${esc(filters.q)}">
      <select class="select" data-f="status">
        <option value="pending">Waiting For Review</option>
        <option value="approved">Approved</option>
        <option value="rejected">Returned</option>
        <option value="">All Uploads</option>
      </select>
      <select class="select" data-f="program"><option value="">All Programs</option></select>
      <span class="count"></span>
    </div>
    <div id="review-list"><div class="empty"><div>Loading…</div></div></div>`;

  const { data: uploads, error } = await sb.from("uploads")
    .select(`id, enrollment_id, step_id, file_path, file_name, size_bytes, status, review_comment, reviewed_at, uploaded_at,
      step:program_steps(title, standard_minutes),
      reviewer:profiles!uploads_reviewed_by_fkey(full_name),
      enrollment:enrollments(program_id, program:programs(title), learner:profiles(full_name, email))`)
    .order("uploaded_at", { ascending: true });
  const list = main.querySelector("#review-list");
  if (error) {
    list.innerHTML = `<div class="empty"><div><strong>Couldn't Load Uploads</strong>${esc(error.message)}</div></div>`;
    return;
  }

  // One row per submission: the files a learner sent together
  const groups = [...uploads.reduce((m, u) => {
    const key = `${u.enrollment_id}|${u.step_id}|${u.uploaded_at}|${u.status}`;
    if (!m.has(key)) m.set(key, { ...u, key, ids: [], files: [] });
    const g = m.get(key);
    g.ids.push(u.id);
    g.files.push(u);
    return m;
  }, new Map()).values()];

  const programs = [...new Map(uploads.map((u) => [u.enrollment.program_id, u.enrollment.program.title])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const programSelect = main.querySelector('[data-f="program"]');
  programSelect.insertAdjacentHTML("beforeend", programs.map(([id, t]) => `<option value="${id}">${esc(t)}</option>`).join(""));
  main.querySelector('[data-f="status"]').value = filters.status;
  programSelect.value = programs.some(([id]) => id === filters.program) ? filters.program : "";

  const approveSelected = main.querySelector("[data-approve-selected]");
  const selected = () => [...list.querySelectorAll("tbody input[type=checkbox]:checked")]
    .flatMap((c) => groups.find((g) => g.key === c.value)?.ids ?? []);
  const syncSelected = () => {
    const n = selected().length;
    approveSelected.disabled = !n;
    approveSelected.textContent = n ? `Approve Selected (${n})` : "Approve Selected";
  };

  const draw = () => {
    const q = filters.q.trim().toLowerCase();
    const shown = groups.filter((u) =>
      (!filters.status || u.status === filters.status) &&
      (!filters.program || u.enrollment.program_id === filters.program) &&
      (!q || `${u.enrollment.learner.full_name} ${u.enrollment.learner.email} ${u.files.map((x) => x.file_name).join(" ")}`.toLowerCase().includes(q)));
    main.querySelector(".count").textContent = `${shown.length} of ${groups.length}`;
    if (!shown.length) {
      list.innerHTML = filters.status === "pending"
        ? '<div class="empty"><div><strong>All Caught Up</strong>No uploads are waiting for review.</div></div>'
        : '<div class="empty"><div><strong>No Uploads Match</strong>Try a different filter.</div></div>';
      syncSelected();
      return;
    }
    list.innerHTML = `
      <div class="table-wrap">
        <table class="data">
          <thead><tr>
            <th><input type="checkbox" data-all aria-label="Select all waiting uploads"></th>
            <th>Learner</th><th>Program / Step</th><th>File</th><th>Uploaded</th><th>Status</th><th></th>
          </tr></thead>
          <tbody>${shown.map((u) => `
            <tr>
              <td>${u.status === "pending" ? `<input type="checkbox" value="${esc(u.key)}" aria-label="Select">` : ""}</td>
              <td class="name"><strong>${esc(u.enrollment.learner.full_name)}</strong><span>${esc(u.enrollment.learner.email)}</span></td>
              <td class="name"><strong>${esc(u.enrollment.program.title)}</strong><span>${esc(u.step?.title ?? "")}</span></td>
              <td>${u.files.map((x) => `<div style="text-align:left"><button class="link-btn dark" style="text-align:left" data-view="${esc(x.file_path)}">${esc(x.file_name)}</button>
                <span class="muted small">${x.size_bytes ? `${(x.size_bytes / 1048576).toFixed(1)} MB` : ""}</span></div>`).join("")}</td>
              <td>${esc(fmtDateTime(u.uploaded_at))}</td>
              <td><span class="pill ${STATUS[u.status].pill}">${STATUS[u.status].label}</span>
                ${u.reviewer ? `<div class="muted small">by ${esc(u.reviewer.full_name)}</div>` : ""}
                ${u.review_comment ? `<div class="muted small">“${esc(u.review_comment)}”</div>` : ""}</td>
              <td class="actions">
                ${u.status !== "approved" ? `<button class="btn sm primary" data-approve="${esc(u.key)}">${u.files.length > 1 ? "Approve All" : "Approve"}</button>` : ""}
                ${u.status !== "rejected" ? `<button class="btn sm danger" data-return="${esc(u.key)}">${u.files.length > 1 ? "Return All" : "Return"}</button>` : ""}
              </td>
            </tr>`).join("")}</tbody>
        </table>
      </div>`;
    syncSelected();
  };

  const setStatus = async (ids, status, comment = null) => {
    const { error: err } = await sb.from("uploads").update({ status, review_comment: comment }).in("id", ids);
    if (err) throw err;
    for (const u of uploads.filter((x) => ids.includes(x.id))) { u.status = status; u.review_comment = comment; }
  };

  main.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("input", () => { filters[el.dataset.f] = el.value; draw(); }));
  // Approving a certificate also credits the step's standard learning hours (the trainer can change them)
  const creditHours = async (g, minutes) => {
    if (minutes == null || minutes === "") return;
    const { error: err } = await sb.rpc("set_step_hours", { p_enrollment: g.enrollment_id, p_step: g.step_id, p_minutes: Number(minutes) });
    if (err) throw err;
  };
  const fmtM = (m) => { const n = Math.round(Number(m) || 0); return n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}m` : ""}` : `${n}m`; };

  approveSelected.addEventListener("click", async () => {
    const ids = selected();
    approveSelected.disabled = true;
    try {
      await setStatus(ids, "approved");
      const chosen = groups.filter((g) => g.ids.some((id) => ids.includes(id)) && g.step?.standard_minutes);
      for (const g of chosen) await creditHours(g, g.step.standard_minutes);
      toast(`${ids.length} file${ids.length === 1 ? "" : "s"} approved.${chosen.length ? ` Standard learning hours credited for ${chosen.length}.` : ""}`);
      renderReview(main);
    } catch (err) { toast(err.message, "err"); syncSelected(); }
  });

  list.addEventListener("change", (e) => {
    if (e.target.matches("[data-all]")) list.querySelectorAll("tbody input[type=checkbox]").forEach((c) => { c.checked = e.target.checked; });
    syncSelected();
  });
  list.addEventListener("click", async (e) => {
    const view = e.target.closest("[data-view]");
    const approve = e.target.closest("[data-approve]");
    const ret = e.target.closest("[data-return]");
    if (view) {
      const { data } = await sb.storage.from(UPLOAD_BUCKET).createSignedUrl(view.dataset.view, 300);
      if (!data?.signedUrl) return toast("That file is no longer available.", "err");
      window.open(data.signedUrl, "_blank", "noopener");
    }
    if (approve) {
      const g = groups.find((x) => x.key === approve.dataset.approve);
      if (g.step?.standard_minutes) {
        openModal({
          title: `Approve: ${g.step.title}`,
          intro: `For <b>${esc(g.enrollment.learner.full_name)}</b>. Confirm the learning hours to credit for this course. The standard duration is ${fmtM(g.step.standard_minutes)}.`,
          body: `<label class="field">Hours To Credit (Minutes)
            <input class="input" type="number" name="mins" min="0" max="6000" step="1" value="${g.step.standard_minutes}" style="max-width:160px">
            <span class="hint">Change it if the certificate shows a different length. Counts toward Learner Hours Trained.</span></label>`,
          submitLabel: "Approve And Credit Hours",
          onSubmit: async (f) => {
            const v = f.mins.value === "" ? null : Number(f.mins.value);
            if (v != null && !(v >= 0 && v <= 6000)) throw new Error("Enter between 0 and 6000 minutes.");
            await setStatus(g.ids, "approved");
            await creditHours(g, v);
            toast(`Approved${v != null ? ` with ${fmtM(v)} of learning credited` : ""}.`);
            renderReview(main);
          },
        });
        return;
      }
      approve.disabled = true;
      try {
        await setStatus(g.ids, "approved");
        toast("Approved. It now counts toward the learner's completion.");
        renderReview(main);
      } catch (err) { toast(err.message, "err"); approve.disabled = false; }
    }
    if (ret) {
      const u = groups.find((g) => g.key === ret.dataset.return);
      const many = u.files.length > 1;
      openModal({
        title: `Return To ${u.enrollment.learner.full_name}?`,
        intro: many ? `All ${u.files.length} files go back. They'll see your comment and can upload corrected files.` : "They'll see your comment and can upload a corrected file.",
        body: `<label class="field">What Needs Fixing
          <textarea class="input prose short" name="comment" placeholder="e.g. This is the Module 2 certificate. Please upload Module 1's."></textarea></label>`,
        submitLabel: "Return Upload",
        danger: true,
        onSubmit: async (f) => {
          const comment = f.comment.value.trim();
          if (!comment) throw new Error("Please tell the learner what needs fixing.");
          await setStatus(u.ids, "rejected", comment);
          toast("Returned to the learner.");
          renderReview(main);
        },
      });
    }
  });

  draw();
}
