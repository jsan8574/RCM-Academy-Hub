// Secure Test Mode for assessments:
//   full screen (where the device allows it), no selecting / copying / pasting / printing,
//   the screen blurs whenever the learner leaves the test, goes black on Print Screen,
//   a faint name + email watermark, and every event is logged for trainers.
//   After MAX_EXITS times leaving, the test is submitted automatically.
// No website can fully stop screenshots or phone photos; this makes them hard and traceable.
import { sb } from "./supabase.js";
import { toast } from "./ui.js";

export const MAX_EXITS = 3;

const docEl = document.documentElement;
export const canFullScreen = () =>
  !!(docEl.requestFullscreen || docEl.webkitRequestFullscreen) && !!(document.fullscreenEnabled ?? document.webkitFullscreenEnabled);
const inFullScreen = () => !!(document.fullscreenElement ?? document.webkitFullscreenElement);

// Some browsers and in-app views refuse full screen; then the test carries on without it
let fsRefused = false;
const refuse = () => { fsRefused = true; };

// Must run straight from a click (browsers only allow full screen after one)
export function enterFullScreen() {
  if (!canFullScreen() || inFullScreen()) return;
  try { (docEl.requestFullscreen ?? docEl.webkitRequestFullscreen).call(docEl)?.catch?.(refuse); } catch { refuse(); }
  setTimeout(() => { if (!inFullScreen()) refuse(); }, 1500);
}

const xml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

// The rules shown before a secure test starts
export function secureRulesHtml() {
  return `<ul class="secure-rules">
    ${canFullScreen() ? "<li>The test opens in <b>full screen</b>. Stay in full screen until you submit.</li>" : ""}
    <li><b>Don't leave the test.</b> Switching tabs or apps blurs the questions and is recorded.</li>
    <li>After you leave <b>${MAX_EXITS} times</b>, your answers are <b>submitted automatically</b>.</li>
    <li>Copying, pasting, printing and screenshots are blocked and recorded.</li>
    <li>Your name is shown faintly on the screen.</li>
  </ul>`;
}

/**
 * Starts the protections. Returns a function that switches them all off.
 * attemptId null = Preview (nothing is logged or submitted).
 */
export function startSecureTest({ attemptId, name, email, resumed = false, onAutoSubmit }) {
  const needFs = () => canFullScreen() && !fsRefused;
  let away = false;
  let awaySince = 0;
  let exits = 0;
  let finished = false;
  let lastNag = 0;

  document.body.classList.add("secure-test-on");

  const mark = document.createElement("div");
  mark.className = "secure-watermark";
  mark.setAttribute("aria-hidden", "true");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='440' height='230'><text x='20' y='130' transform='rotate(-22 220 115)' font-family='Arial, sans-serif' font-size='15' fill='rgba(20,45,80,0.11)'>${xml(`${name}${email ? ` · ${email}` : ""}`)}</text></svg>`;
  mark.style.backgroundImage = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;

  const cover = document.createElement("div");
  cover.className = "secure-cover";
  cover.hidden = true;
  cover.innerHTML = `<div class="secure-cover-card">
      <h2>Your Test Is Paused</h2>
      <p data-msg></p>
      <button type="button" class="btn primary" data-back>Continue Test</button>
    </div>`;
  const shade = document.createElement("div");   // black screen while a screenshot may be happening
  shade.className = "secure-black";
  shade.hidden = true;
  document.body.append(mark, cover, shade);
  const msg = cover.querySelector("[data-msg]");

  const log = async (kind, seconds = null) => {
    if (!attemptId) return null;
    const { data, error } = await sb.rpc("log_assessment_event", { p_attempt: attemptId, p_kind: kind, p_seconds: seconds });
    return error ? null : data;
  };

  const showCover = () => {
    const left = Math.max(0, MAX_EXITS - exits);
    msg.textContent = left
      ? `You left the test (${exits} of ${MAX_EXITS}). This has been recorded. After ${MAX_EXITS} times, your answers are submitted automatically.`
      : "You left the test too many times, so your answers are being submitted.";
    cover.querySelector("[data-back]").textContent = needFs() && !inFullScreen() ? "Return To Full Screen" : "Continue Test";
    cover.hidden = false;
  };

  const autoSubmit = async () => {
    if (finished) return;
    finished = true;
    await log("auto_submitted");
    if (attemptId) onAutoSubmit?.();
    else toast(`Preview: a learner's test would now be submitted automatically (${MAX_EXITS} exits).`);
  };

  const goAway = async (kind) => {
    if (finished) return;
    if (away) return showCover();
    away = true;
    awaySince = Date.now();
    exits += 1;                     // shown straight away; the database count wins below
    showCover();
    const n = await log(kind);
    if (typeof n === "number") exits = n;
    showCover();
    if (exits >= MAX_EXITS) autoSubmit();
  };

  const comeBack = () => {
    if (!away || finished) return;
    if (document.visibilityState !== "visible" || !document.hasFocus() || (needFs() && !inFullScreen())) return;
    away = false;
    cover.hidden = true;
    log("returned", Math.round((Date.now() - awaySince) / 1000));
  };

  cover.querySelector("[data-back]").addEventListener("click", () => {
    if (needFs() && !inFullScreen()) {
      enterFullScreen();
      setTimeout(comeBack, 1700);   // after the browser has said yes (or no)
    } else comeBack();
  });

  // Leaving: another tab, another app, or out of full screen
  const onVisibility = () => { if (document.visibilityState === "hidden") goAway("left_page"); };
  const onBlur = () => goAway("left_page");
  const onFocus = () => { if (!needFs() || inFullScreen()) comeBack(); };
  const onFs = () => {
    if (needFs() && !inFullScreen()) goAway("fullscreen_exit");
    else comeBack();
  };

  // Screenshots: black out on Print Screen, and while screenshot shortcuts are held
  let blackTimer = null;
  const black = (ms = 2500) => {
    shade.hidden = false;
    clearTimeout(blackTimer);
    blackTimer = setTimeout(() => { shade.hidden = true; }, ms);
  };
  const nag = (kind, text) => {
    if (Date.now() - lastNag < 4000) return;
    lastNag = Date.now();
    toast(text, "err");
    log(kind);
  };
  const onKey = (e) => {
    const k = (e.key ?? "").toLowerCase();
    if (k === "printscreen") {
      e.preventDefault();
      black();
      try { navigator.clipboard?.writeText?.(" ").catch?.(() => {}); } catch { /* not allowed */ }
      if (e.type === "keyup") goAway("print_screen");
      return;
    }
    if (e.type !== "keydown") return;
    if (e.metaKey && e.shiftKey) { black(1500); return; }   // Mac Cmd+Shift+3/4/5, Windows Win+Shift+S
    if ((e.ctrlKey || e.metaKey) && ["c", "x", "v", "a", "p", "s", "u"].includes(k)) {
      e.preventDefault();
      nag(k === "v" ? "paste_attempt" : "copy_attempt", k === "v" ? "Pasting is turned off during this test." : "Copying and printing are turned off during this test.");
    }
  };
  const isTyping = (t) => t?.closest?.("input, textarea, select");
  const onCopy = (e) => { e.preventDefault(); nag("copy_attempt", "Copying is turned off during this test."); };
  const onPaste = (e) => { e.preventDefault(); nag("paste_attempt", "Pasting is turned off during this test."); };
  const onContext = (e) => e.preventDefault();
  const onSelect = (e) => { if (!isTyping(e.target)) e.preventDefault(); };
  const onPrint = () => black(4000);

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocus);
  document.addEventListener("fullscreenchange", onFs);
  document.addEventListener("webkitfullscreenchange", onFs);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("keyup", onKey, true);
  document.addEventListener("copy", onCopy, true);
  document.addEventListener("cut", onCopy, true);
  document.addEventListener("paste", onPaste, true);
  document.addEventListener("contextmenu", onContext, true);
  document.addEventListener("selectstart", onSelect, true);
  document.addEventListener("dragstart", onContext, true);
  window.addEventListener("beforeprint", onPrint);

  // Opening the test, or reopening it after a reload (the exit count carries over)
  log(resumed ? "resumed" : "started").then((n) => {
    if (typeof n === "number") exits = n;
    if (exits >= MAX_EXITS) autoSubmit();
  });
  // Started outside full screen (the browser said no): ask once more
  setTimeout(() => {
    if (needFs() && !inFullScreen() && !finished && !away) {
      away = true;
      awaySince = Date.now();
      msg.textContent = "This test must be taken in full screen.";
      cover.querySelector("[data-back]").textContent = "Go To Full Screen";
      cover.hidden = false;
    }
  }, 1800);

  return function stopSecureTest() {
    finished = true;
    clearTimeout(blackTimer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("fullscreenchange", onFs);
    document.removeEventListener("webkitfullscreenchange", onFs);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("keyup", onKey, true);
    document.removeEventListener("copy", onCopy, true);
    document.removeEventListener("cut", onCopy, true);
    document.removeEventListener("paste", onPaste, true);
    document.removeEventListener("contextmenu", onContext, true);
    document.removeEventListener("selectstart", onSelect, true);
    document.removeEventListener("dragstart", onContext, true);
    window.removeEventListener("beforeprint", onPrint);
    mark.remove();
    cover.remove();
    shade.remove();
    document.body.classList.remove("secure-test-on");
    if (inFullScreen()) try { (document.exitFullscreen ?? document.webkitExitFullscreen).call(document)?.catch?.(() => {}); } catch { /* ignore */ }
  };
}
