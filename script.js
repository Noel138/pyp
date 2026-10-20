
"use strict";

const STORAGE_KEY = "pypData";
const OLD_STORAGE_KEY = "levelUpData";

const $ = (id) => document.getElementById(id);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const dateLabel = (value) => {
  if (!value) return "";
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
};
const minutesLabel = (n) => {
  n = Math.max(0, Math.round(Number(n) || 0));
  return n >= 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} min`;
};

const defaultChallenges = [
  { id: "move", name: "20 Minuten bewegen", xp: 20 },
  { id: "water", name: "Genug Wasser trinken", xp: 10 },
  { id: "learn", name: "15 Minuten etwas lernen", xp: 15 },
  { id: "workout", name: "Eine Bewegungseinheit absolvieren", xp: 20 },
  { id: "plan", name: "Den nächsten Tag planen", xp: 10 }
];

function initialState() {
  return {
    version: 2,
    xp: 0,
    challenges: defaultChallenges,
    challengeDone: {},
    habits: [],
    quests: [],
    workouts: [],
    runs: [],
    plans: [],
    projects: [],
    schedule: [],
    screenTime: [],
    createdAt: new Date().toISOString()
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));

    // Migration: Daten aus der bisherigen LEVELUP-Version übernehmen.
    const oldRaw = localStorage.getItem(OLD_STORAGE_KEY);
    if (oldRaw) {
      const old = JSON.parse(oldRaw);
      const migrated = initialState();
      migrated.xp = Number(old.xp) || 0;

      if (Array.isArray(old.workouts)) migrated.workouts = old.workouts;

      // Bisherige Challenges soweit möglich in das neue Tagesformat übertragen.
      if (old.completedChallenges && typeof old.completedChallenges === "object") {
        migrated.challengeDone = old.completedChallenges;
      } else if (old.challenges && typeof old.challenges === "object" && !Array.isArray(old.challenges)) {
        migrated.challengeDone = old.challenges;
      }
      return normalize(migrated);
    }
  } catch (error) {
    console.error("PYP-Daten konnten nicht geladen werden:", error);
  }
  return initialState();
}

function normalize(input) {
  const base = initialState();
  const data = { ...base, ...(input || {}) };

  for (const key of ["challenges", "habits", "quests", "workouts", "runs", "plans", "projects", "schedule", "screenTime"]) {
    if (!Array.isArray(data[key])) data[key] = base[key];
  }
  if (!data.challengeDone || typeof data.challengeDone !== "object" || Array.isArray(data.challengeDone)) {
    data.challengeDone = {};
  }
  data.xp = Math.max(0, Number(data.xp) || 0);
  data.challenges = data.challenges.length ? data.challenges : defaultChallenges;
  return data;
}

let state = loadState();
let timerInterval = null;
let timerRemaining = 90;
let timerEndAt = null;
let audioContext = null;
let calendarCursor = new Date();
let selectedCalendarDate = today();

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    console.error("Speichern fehlgeschlagen:", error);
    alert("Die Daten konnten nicht gespeichert werden. Exportiere ein Backup und prüfe den verfügbaren Browser-Speicher.");
    return false;
  }
}

function levelInfo() {
  const xp = Math.max(0, state.xp);
  const level = Math.floor(xp / 100) + 1;
  return { xp, level, inLevel: xp % 100, next: 100 - (xp % 100) };
}

function addXP(amount) {
  state.xp = Math.max(0, state.xp + amount);
}

function todayDone(id, category) {
  const key = `${category}:${id}`;
  return Array.isArray(state.challengeDone[today()]) && state.challengeDone[today()].includes(key);
}

function setTodayDone(id, category, checked) {
  const date = today();
  if (!Array.isArray(state.challengeDone[date])) state.challengeDone[date] = [];
  const key = `${category}:${id}`;
  const list = state.challengeDone[date];
  const exists = list.includes(key);
  if (checked && !exists) list.push(key);
  if (!checked && exists) list.splice(list.indexOf(key), 1);
}

function toggleDaily(item, category, checked) {
  if (todayDone(item.id, category) === checked) return;
  setTodayDone(item.id, category, checked);
  addXP(checked ? Number(item.xp || 0) : -Number(item.xp || 0));
  saveState();
  renderAll();
  if (checked) playTone();
}

function escapeNewlines(value) {
  return String(value || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function emptyMessage(text) {
  return `<div class="empty-state">${esc(text)}</div>`;
}

function renderHeader() {
  const date = new Date();
  $("today-label").textContent = date.toLocaleDateString("de-DE", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).toUpperCase();

  const info = levelInfo();
  $("header-level").textContent = info.level;
  $("hero-level").textContent = String(info.level).padStart(2, "0");
  $("hero-xp").textContent = `${info.xp} XP`;
  $("xp-bar").style.width = `${info.inLevel}%`;
  $("xp-next").textContent = `${info.next} XP bis zum nächsten Level`;
}

function streakCount() {
  let count = 0;
  const d = new Date();
  // Wenn heute noch nichts abgehakt ist, darf die Serie vom Vortag weiterlaufen.
  if (!(state.challengeDone[today()] || []).length) d.setDate(d.getDate() - 1);

  while (count < 500) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!(state.challengeDone[key] || []).length) break;
    count++;
    d.setDate(d.getDate() - 1);
  }
  return count;
}

function projectProgress(project) {
  const tasks = Array.isArray(project.tasks) ? project.tasks : [];
  if (!tasks.length) return 0;
  return Math.round(tasks.filter(t => t.done).length / tasks.length * 100);
}

function renderChallenges() {
  const items = state.challenges;
  const done = items.filter(item => todayDone(item.id, "challenge")).length;
  $("dashboard-challenges").innerHTML = items.length
    ? items.map(item => `
      <div class="list-item ${todayDone(item.id, "challenge") ? "completed" : ""}">
        <input class="check-control daily-check" type="checkbox"
          data-id="${esc(item.id)}" data-category="challenge"
          ${todayDone(item.id, "challenge") ? "checked" : ""}
          aria-label="${esc(item.name)} abhaken">
        <div class="list-item-main"><strong class="item-title">${esc(item.name)}</strong><small>Tägliche Challenge</small></div>
        <span class="xp-tag">${Number(item.xp) || 0} XP</span>
      </div>`).join("")
    : emptyMessage("Noch keine Challenges vorhanden.");

  $("dash-habits").textContent = `${done}/${items.length}`;
}

function renderDailyList(containerId, items, category) {
  const container = $(containerId);
  if (!items.length) {
    container.innerHTML = emptyMessage(category === "habit"
      ? "Noch keine Gewohnheiten. Erstelle oben deine erste."
      : "Noch keine Quests. Erstelle oben deine erste Aufgabe.");
    return;
  }

  container.innerHTML = items.map(item => `
    <div class="list-item ${todayDone(item.id, category) ? "completed" : ""}">
      <input class="check-control daily-check" type="checkbox" data-id="${esc(item.id)}"
        data-category="${category}" ${todayDone(item.id, category) ? "checked" : ""}
        aria-label="${esc(item.name)} abhaken">
      <div class="list-item-main"><strong class="item-title">${esc(item.name)}</strong>
        <small>${category === "habit" ? "Tägliche Gewohnheit" : "Eigene Quest"}</small>
      </div>
      <span class="xp-tag">${Number(item.xp) || 0} XP</span>
      <button class="icon-button delete-daily" data-id="${esc(item.id)}" data-category="${category}" aria-label="Löschen">×</button>
    </div>`).join("");
}

function renderWorkouts() {
  const sorted = [...state.workouts].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const total = state.workouts.reduce((sum, w) => sum + (Number(w.minutes) || 0), 0) +
    state.runs.reduce((sum, run) => sum + (Number(run.minutes) || 0), 0);
  $("total-minutes").textContent = `${total} Min.`;

  $("workout-list").innerHTML = sorted.length ? sorted.slice(0, 50).map(w => {
    const detail = [];
    if (w.weight !== "" && w.weight != null && Number(w.weight) > 0) detail.push(`${esc(w.weight)} kg`);
    if (w.sets) detail.push(`${esc(w.sets)} Sätze`);
    if (w.reps) detail.push(`${esc(w.reps)} Wdh.`);
    if (w.intensity) detail.push(esc(w.intensity));
    return `<div class="list-item">
      <div class="list-item-main"><strong>${esc(w.exercise || "Training")}</strong>
      <small>${dateLabel(w.date)} · ${Number(w.minutes) || 0} Min. ${detail.length ? "· " + detail.join(" · ") : ""}</small></div>
      <button class="icon-button delete-workout" data-id="${esc(w.id)}" aria-label="Training löschen">×</button>
    </div>`;
  }).join("") : emptyMessage("Noch keine Trainingseinheiten gespeichert.");

  $("dash-workouts").textContent = state.workouts.length + state.runs.length;
  $("stat-minutes").textContent = total.toLocaleString("de-DE");
}

function paceLabel(minutes, distance) {
  if (!(Number(distance) > 0) || !(Number(minutes) > 0)) return "—";
  const seconds = Math.round(Number(minutes) * 60 / Number(distance));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} min/km`;
}

function renderRunning() {
  const distance = state.runs.reduce((sum, run) => sum + (Number(run.distance) || 0), 0);
  const minutes = state.runs.reduce((sum, run) => sum + (Number(run.minutes) || 0), 0);
  $("run-total-distance").textContent = `${distance.toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`;
  $("run-average-pace").textContent = paceLabel(minutes, distance);

  const sorted = [...state.runs].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  $("run-list").innerHTML = sorted.length ? sorted.slice(0, 50).map(run => `
    <div class="list-item">
      <div class="list-item-main"><strong>${Number(run.distance).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km · ${paceLabel(run.minutes, run.distance)}</strong>
      <small>${dateLabel(run.date)} · ${Number(run.minutes) || 0} Min.${run.route ? ` · ${esc(run.route)}` : ""}</small></div>
      <button class="icon-button delete-run" data-id="${esc(run.id)}" aria-label="Lauf löschen">×</button>
    </div>`).join("") : emptyMessage("Noch keine Läufe protokolliert.");
}

function renderPlans() {
  $("plan-list").innerHTML = state.plans.length ? state.plans.map(plan => `
    <div class="list-item">
      <div class="list-item-main"><strong>${esc(plan.name)}</strong>
      <small>${(plan.exercises || []).map(esc).join(" · ") || "Keine Übungen eingetragen"}</small></div>
      <button class="button button-quiet start-plan" data-id="${esc(plan.id)}" type="button">Starten</button>
      <button class="icon-button delete-plan" data-id="${esc(plan.id)}" aria-label="Plan löschen">×</button>
    </div>`).join("") : emptyMessage("Erstelle einen Trainingsplan, um ihn hier zu sehen.");
}

function renderProjects() {
  const target = $("project-list");
  target.innerHTML = state.projects.length ? state.projects.map(project => {
    const percent = projectProgress(project);
    return `<article class="project-card">
      <div class="section-heading"><div><h3>${esc(project.name)}</h3></div><span class="xp-tag">${percent}%</span></div>
      <p>${esc(project.description || "Dein persönliches Projekt.")}</p>
      <div class="project-progress-label"><span>Fortschritt</span><span>${(project.tasks || []).filter(t => t.done).length}/${(project.tasks || []).length}</span></div>
      <div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div>
      <div class="task-list">${(project.tasks || []).map(task => `
        <div class="task-row">
          <input type="checkbox" class="project-task-check" data-project="${esc(project.id)}" data-task="${esc(task.id)}"
            ${task.done ? "checked" : ""} id="task-${esc(project.id)}-${esc(task.id)}">
          <label for="task-${esc(project.id)}-${esc(task.id)}">${esc(task.name)}</label>
        </div>`).join("")}</div>
      <div class="project-actions"><button class="icon-button delete-project" data-id="${esc(project.id)}">Projekt löschen</button></div>
    </article>`;
  }).join("") : emptyMessage("Du hast noch keine Projekte. Erstelle dein erstes Projekt.");

  const dashboard = $("dashboard-projects");
  const few = state.projects.slice(0, 2);
  dashboard.innerHTML = few.length ? few.map(p => `
    <div class="project-card"><h3>${esc(p.name)}</h3>
    <div class="project-progress-label"><span>Fortschritt</span><strong>${projectProgress(p)}%</strong></div>
    <div class="progress-track"><div class="progress-fill" style="width:${projectProgress(p)}%"></div></div></div>`).join("")
    : emptyMessage("Deine Projekte werden hier angezeigt.");
}

function calendarEventsFor(date) {
  const planned = state.schedule.filter(item => item.date === date).map(item => {
    const project = state.projects.find(entry => entry.id === item.projectId);
    return { ...item, source: "schedule", projectName: project?.name || "", details: "" };
  });
  const workouts = state.workouts.filter(item => item.date === date).map(item => ({
    id: item.id, date, time: "", kind: "training", title: item.exercise || "Training",
    source: "workout", details: `${Number(item.minutes) || 0} Min.`
  }));
  const runs = state.runs.filter(item => item.date === date).map(item => ({
    id: item.id, date, time: "", kind: "running", title: `Laufen · ${Number(item.distance).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km`,
    source: "run", details: `${Number(item.minutes) || 0} Min. · ${paceLabel(item.minutes, item.distance)}`
  }));
  return [...planned, ...workouts, ...runs].sort((a, b) => (a.time || "23:59").localeCompare(b.time || "23:59"));
}

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  $("calendar-month").textContent = calendarCursor.toLocaleDateString("de-DE", { month: "long", year: "numeric" });

  const projectSelect = $("schedule-project");
  const selectedProject = projectSelect.value;
  projectSelect.innerHTML = `<option value="">Kein Projekt</option>` + state.projects.map(project =>
    `<option value="${esc(project.id)}">${esc(project.name)}</option>`
  ).join("");
  if (state.projects.some(project => project.id === selectedProject)) projectSelect.value = selectedProject;

  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const cells = [];
  for (let index = 0; index < cellCount; index++) {
    const date = new Date(year, month, index - firstWeekday + 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const events = calendarEventsFor(key);
    const classes = ["calendar-day"];
    if (date.getMonth() !== month) classes.push("outside-month");
    if (key === selectedCalendarDate) classes.push("selected");
    if (key === today()) classes.push("is-today");
    const dots = events.slice(0, 3).map(item => `<i class="calendar-dot calendar-dot-${esc(item.kind)}"></i>`).join("");
    const extra = events.length > 3 ? `<small>+${events.length - 3}</small>` : "";
    cells.push(`<button class="${classes.join(" ")}" type="button" data-date="${key}" aria-label="${dateLabel(key)}${events.length ? `, ${events.length} Einträge` : ""}">
      <span class="calendar-day-number">${date.getDate()}</span><span class="calendar-day-events">${dots}${extra}</span></button>`);
  }
  $("calendar-grid").innerHTML = cells.join("");

  const selectedDate = new Date(`${selectedCalendarDate}T12:00:00`);
  $("agenda-date").textContent = selectedDate.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
  const labels = { project: "Projektzeit", training: "Training", focus: "Fokuszeit", running: "Laufen" };
  const events = calendarEventsFor(selectedCalendarDate);
  $("calendar-agenda").innerHTML = events.length ? events.map(item => `
    <div class="list-item calendar-agenda-item">
      <i class="calendar-dot calendar-dot-${esc(item.kind)}"></i>
      <div class="list-item-main"><strong>${item.time ? `${esc(item.time)} · ` : ""}${esc(item.title)}</strong>
        <small>${labels[item.kind] || "Termin"}${item.projectName ? ` · ${esc(item.projectName)}` : ""}${item.details ? ` · ${esc(item.details)}` : ""}</small></div>
      ${item.source === "schedule" ? `<button class="icon-button delete-schedule" data-id="${esc(item.id)}" aria-label="Termin löschen">×</button>` : ""}
    </div>`).join("") : emptyMessage("Für diesen Tag ist noch nichts geplant.");
}

function screenMap() {
  return new Map(state.screenTime.map(row => [row.date, Number(row.minutes) || 0]));
}

function lastSevenDays() {
  const list = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    list.push({ date, label: d.toLocaleDateString("de-DE", { weekday: "short" }) });
  }
  return list;
}

function chartHTML(rows, suffix, emptyText = "Noch keine Daten für diesen Zeitraum.") {
  const valid = rows.filter(r => r.value !== null && r.value !== undefined && Number.isFinite(Number(r.value)));
  if (!valid.length) return emptyMessage(emptyText);
  const max = Math.max(1, ...valid.map(r => Number(r.value)));
  return rows.map(r => {
    if (r.value === null || r.value === undefined || !Number.isFinite(Number(r.value))) {
      return `<div class="chart-row"><span class="chart-label">${esc(r.label)}</span><div class="chart-track"></div><span class="chart-value">—</span></div>`;
    }
    const value = Math.max(0, Number(r.value));
    const width = value === 0 ? 0 : Math.max(2, value / max * 100);
    return `<div class="chart-row"><span class="chart-label">${esc(r.label)}</span>
      <div class="chart-track"><div class="chart-bar" style="width:${width}%"></div></div>
      <span class="chart-value">${esc(value)} ${suffix}</span></div>`;
  }).join("");
}

function renderScreenTime() {
  const map = screenMap();
  const days = lastSevenDays();
  const rows = days.map(d => ({ ...d, value: map.has(d.date) ? map.get(d.date) : null }));
  const valid = rows.filter(r => r.value !== null);
  const avg = valid.length ? Math.round(valid.reduce((sum, r) => sum + r.value, 0) / valid.length) : null;

  $("screen-chart").innerHTML = chartHTML(rows.map(r => ({ label: `${r.label} ${r.date.slice(8)}`, value: r.value })), "min");
  $("stats-screen-chart").innerHTML = chartHTML(rows.map(r => ({ label: `${r.label} ${r.date.slice(8)}`, value: r.value })), "min");
  $("screen-average").textContent = avg === null ? "Ø —" : `Ø ${minutesLabel(avg)}`;

  const sorted = [...state.screenTime].sort((a, b) => b.date.localeCompare(a.date));
  $("screen-history").innerHTML = sorted.length ? sorted.slice(0, 30).map(row => `
    <div class="list-item"><div class="list-item-main"><strong>${dateLabel(row.date)}</strong>
    <small>${minutesLabel(row.minutes)} Bildschirmzeit</small></div>
    <button class="icon-button delete-screen" data-date="${esc(row.date)}" aria-label="Eintrag löschen">×</button></div>`).join("")
    : emptyMessage("Noch keine Bildschirmzeit erfasst.");

  const last = [...state.screenTime].sort((a, b) => b.date.localeCompare(a.date))[0];
  $("dash-screen-time").textContent = last ? minutesLabel(last.minutes) : "Noch keine Daten";

  const mini = $("dash-screen-bars");
  const max = Math.max(1, ...rows.map(r => r.value || 0));
  mini.innerHTML = rows.map(r => `
    <div class="mini-bar-wrap" title="${esc(r.date)}: ${r.value === null ? "keine Daten" : minutesLabel(r.value)}">
      <div class="mini-bar" style="height:${r.value === null ? 3 : Math.max(3, (r.value / max) * 55)}px;opacity:${r.value === null ? .2 : 1}"></div>
      <small>${esc(r.label)}</small>
    </div>`).join("");
}

function renderStats() {
  const info = levelInfo();
  $("stat-xp").textContent = info.xp.toLocaleString("de-DE");
  $("stat-habits").textContent = String(
    state.habits.filter(x => todayDone(x.id, "habit")).length +
    state.quests.filter(x => todayDone(x.id, "quest")).length +
    state.challenges.filter(x => todayDone(x.id, "challenge")).length
  );
  const projects = state.projects;
  const avg = projects.length ? Math.round(projects.reduce((sum, p) => sum + projectProgress(p), 0) / projects.length) : 0;
  $("stat-projects").textContent = `${avg}%`;

  const rows = lastSevenDays().map(d => ({
    label: `${d.label} ${d.date.slice(8)}`,
    value: state.workouts.filter(w => w.date === d.date).reduce((sum, w) => sum + (Number(w.minutes) || 0), 0) +
      state.runs.filter(run => run.date === d.date).reduce((sum, run) => sum + (Number(run.minutes) || 0), 0)
  }));
  $("workout-chart").innerHTML = chartHTML(rows, "min", "Noch keine Trainingsdaten für diese Woche.");
}

function renderAll() {
  renderHeader();
  renderChallenges();
  renderDailyList("habit-list", state.habits, "habit");
  renderDailyList("quest-list", state.quests, "quest");
  renderWorkouts();
  renderRunning();
  renderPlans();
  renderProjects();
  renderCalendar();
  renderScreenTime();
  renderStats();
  $("dash-streak").textContent = `${streakCount()} Tage`;
  const totalChallenges = state.challenges.filter(item => todayDone(item.id, "challenge")).length;
  const totalHabits = state.habits.filter(item => todayDone(item.id, "habit")).length;
  const totalQuests = state.quests.filter(item => todayDone(item.id, "quest")).length;
  const totalItems = state.challenges.length + state.habits.length + state.quests.length;
  $("dash-habits").textContent = `${totalChallenges + totalHabits + totalQuests}/${totalItems}`;
}

function showPage(page) {
  const valid = ["dashboard", "calendar", "habits", "training", "projects", "screen-time", "stats", "settings"];
  if (!valid.includes(page)) page = "dashboard";

  document.querySelectorAll(".page").forEach(el => el.classList.toggle("active", el.id === `page-${page}`));
  document.querySelectorAll("[data-page]").forEach(el => {
    const active = el.dataset.page === page;
    el.classList.toggle("active", active);
    if (el.classList.contains("nav-link")) {
      if (active) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    }
  });

  const titles = {
    dashboard: "Dashboard", calendar: "Kalender", habits: "Habits & Quests", training: "Training",
    projects: "Projekte", "screen-time": "Bildschirmzeit", stats: "Statistiken", settings: "Einstellungen"
  };
  $("page-title").textContent = titles[page];
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
}

document.querySelectorAll("[data-page]").forEach(link => {
  link.addEventListener("click", event => {
    event.preventDefault();
    showPage(link.dataset.page);
  });
});
window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));

$("calendar-prev").addEventListener("click", () => {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
  renderCalendar();
});
$("calendar-next").addEventListener("click", () => {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
  renderCalendar();
});
$("calendar-today").addEventListener("click", () => {
  calendarCursor = new Date();
  calendarCursor.setDate(1);
  selectedCalendarDate = today();
  $("schedule-date").value = selectedCalendarDate;
  renderCalendar();
});
$("calendar-grid").addEventListener("click", event => {
  const day = event.target.closest(".calendar-day");
  if (!day) return;
  selectedCalendarDate = day.dataset.date;
  calendarCursor = new Date(`${selectedCalendarDate}T12:00:00`);
  calendarCursor.setDate(1);
  $("schedule-date").value = selectedCalendarDate;
  renderCalendar();
});

$("schedule-form").addEventListener("submit", event => {
  event.preventDefault();
  const title = $("schedule-title").value.trim();
  const date = $("schedule-date").value;
  if (!title || !date) return;
  state.schedule.push({
    id: uid(), title, date, time: $("schedule-time").value,
    kind: $("schedule-kind").value, projectId: $("schedule-project").value
  });
  selectedCalendarDate = date;
  calendarCursor = new Date(`${date}T12:00:00`);
  calendarCursor.setDate(1);
  $("schedule-form").reset();
  $("schedule-date").value = selectedCalendarDate;
  saveState(); renderAll();
});

$("habit-form").addEventListener("submit", event => {
  event.preventDefault();
  const name = $("habit-name").value.trim();
  if (!name) return;
  state.habits.push({ id: uid(), name, xp: Number($("habit-xp").value) || 10 });
  $("habit-form").reset();
  $("habit-xp").value = "10";
  saveState(); renderAll();
});

$("quest-form").addEventListener("submit", event => {
  event.preventDefault();
  const name = $("quest-name").value.trim();
  if (!name) return;
  state.quests.push({ id: uid(), name, xp: Number($("quest-xp").value) || 20 });
  $("quest-form").reset();
  $("quest-xp").value = "20";
  saveState(); renderAll();
});

document.addEventListener("change", event => {
  const target = event.target;

  if (target.matches(".daily-check")) {
    const category = target.dataset.category;
    const id = target.dataset.id;
    const list = category === "habit" ? state.habits : category === "quest" ? state.quests : state.challenges;
    const item = list.find(x => x.id === id);
    if (item) toggleDaily(item, category, target.checked);
  }

  if (target.matches(".project-task-check")) {
    const project = state.projects.find(p => p.id === target.dataset.project);
    const task = project && project.tasks.find(t => t.id === target.dataset.task);
    if (task && task.done !== target.checked) {
      task.done = target.checked;
      saveState(); renderAll();
    }
  }
});

document.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;

  if (button.matches(".delete-schedule")) {
    state.schedule = state.schedule.filter(item => item.id !== button.dataset.id);
    saveState(); renderAll();
  }

  if (button.matches(".delete-run")) {
    const run = state.runs.find(item => item.id === button.dataset.id);
    if (run && confirm("Diesen Lauf löschen?")) {
      state.runs = state.runs.filter(item => item.id !== run.id);
      saveState(); renderAll();
    }
  }

  if (button.matches(".delete-daily")) {
    const category = button.dataset.category;
    const list = category === "habit" ? state.habits : state.quests;
    const item = list.find(x => x.id === button.dataset.id);
    if (item && confirm(`"${item.name}" wirklich löschen?`)) {
      // Bereits vergebene XP bleiben bestehen, da das Löschen keine abgeschlossene Aufgabe rückgängig macht.
      const key = `${category}:${item.id}`;
      for (const day of Object.keys(state.challengeDone)) {
        state.challengeDone[day] = state.challengeDone[day].filter(x => x !== key);
      }
      const index = list.findIndex(x => x.id === item.id);
      if (index >= 0) list.splice(index, 1);
      saveState(); renderAll();
    }
  }

  if (button.matches(".delete-workout")) {
    const workout = state.workouts.find(w => w.id === button.dataset.id);
    if (workout && confirm("Dieses Training löschen?")) {
      state.workouts = state.workouts.filter(w => w.id !== workout.id);
      saveState(); renderAll();
    }
  }

  if (button.matches(".delete-plan")) {
    const plan = state.plans.find(p => p.id === button.dataset.id);
    if (plan && confirm(`Trainingsplan "${plan.name}" löschen?`)) {
      state.plans = state.plans.filter(p => p.id !== plan.id);
      saveState(); renderAll();
    }
  }

  if (button.matches(".start-plan")) {
    const plan = state.plans.find(p => p.id === button.dataset.id);
    if (plan) {
      $("exercise").value = plan.exercises[0] || plan.name;
      $("page-title").textContent = "Training";
      $("workout-form").scrollIntoView({ behavior: "smooth", block: "center" });
      $("exercise").focus();
    }
  }

  if (button.matches(".delete-project")) {
    const project = state.projects.find(p => p.id === button.dataset.id);
    if (project && confirm(`Projekt "${project.name}" löschen?`)) {
      state.projects = state.projects.filter(p => p.id !== project.id);
      saveState(); renderAll();
    }
  }

  if (button.matches(".delete-screen")) {
    if (confirm(`Bildschirmzeit für ${dateLabel(button.dataset.date)} löschen?`)) {
      state.screenTime = state.screenTime.filter(r => r.date !== button.dataset.date);
      saveState(); renderAll();
    }
  }
});

$("workout-form").addEventListener("submit", event => {
  event.preventDefault();
  const exercise = $("exercise").value.trim();
  const minutes = Number($("minutes").value);
  if (!exercise || !Number.isFinite(minutes) || minutes < 1) return;

  state.workouts.push({
    id: uid(), exercise, minutes, intensity: $("intensity").value,
    weight: $("weight").value === "" ? "" : Number($("weight").value),
    sets: Number($("sets").value) || 0,
    reps: Number($("reps").value) || 0,
    date: today()
  });
  // XP für Workouts ist bewusst nicht automatisch vergeben, um doppelte Belohnungen zu vermeiden.
  $("exercise").value = "";
  $("weight").value = "";
  $("sets").value = "3";
  $("reps").value = "10";
  saveState(); renderAll();
});

$("run-form").addEventListener("submit", event => {
  event.preventDefault();
  const distance = Number($("run-distance").value);
  const minutes = Number($("run-minutes").value);
  const date = $("run-date").value;
  if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(minutes) || minutes < 1 || !date) return;

  state.runs.push({
    id: uid(), distance, minutes, date, route: $("run-route").value.trim()
  });
  $("run-form").reset();
  $("run-date").value = today();
  saveState(); renderAll();
});

$("plan-form").addEventListener("submit", event => {
  event.preventDefault();
  const name = $("plan-name").value.trim();
  if (!name) return;
  const exercises = escapeNewlines($("plan-exercises").value);
  state.plans.push({ id: uid(), name, exercises });
  $("plan-form").reset();
  saveState(); renderAll();
});

$("project-form").addEventListener("submit", event => {
  event.preventDefault();
  const name = $("project-name").value.trim();
  const tasks = escapeNewlines($("project-tasks").value);
  if (!name || !tasks.length) return;
  state.projects.push({
    id: uid(),
    name,
    description: $("project-description").value.trim(),
    tasks: tasks.map(task => ({ id: uid(), name: task, done: false })),
    createdAt: today()
  });
  $("project-form").reset();
  saveState(); renderAll();
});

$("screen-date").value = today();
$("schedule-date").value = selectedCalendarDate;
$("run-date").value = today();
$("screen-form").addEventListener("submit", event => {
  event.preventDefault();
  const date = $("screen-date").value;
  const minutes = Number($("screen-minutes").value);
  if (!date || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
    alert("Bitte gib ein gültiges Datum und 0 bis 1440 Minuten ein.");
    return;
  }
  const existing = state.screenTime.find(r => r.date === date);
  if (existing) existing.minutes = minutes;
  else state.screenTime.push({ date, minutes, source: "manual" });
  $("screen-minutes").value = "";
  saveState(); renderAll();
});

function parseCSVLine(line) {
  const out = [];
  let field = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') { field += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) { out.push(field.trim()); field = ""; }
    else field += ch;
  }
  out.push(field.trim());
  return out;
}

function parseDuration(value) {
  const s = String(value ?? "").trim().replace(",", ".");
  if (/^\d+:\d{1,2}$/.test(s)) {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function validISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T12:00:00");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

$("csv-import").addEventListener("click", async () => {
  const file = $("screen-csv").files[0];
  const status = $("csv-status");
  if (!file) { status.textContent = "Bitte wähle zuerst eine CSV-Datei aus."; return; }

  try {
    const text = (await file.text()).replace(/^\uFEFF/, "");
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 1) throw new Error("Die Datei ist leer.");

    const first = parseCSVLine(lines[0]).map(s => s.toLowerCase());
    const dateNames = ["date", "datum", "day"];
    const timeNames = ["minutes", "minuten", "duration", "dauer", "screen time", "bildschirmzeit", "total minutes"];
    let dateIndex = first.findIndex(x => dateNames.includes(x));
    let timeIndex = first.findIndex(x => timeNames.includes(x));
    let startIndex = 0;

    if (dateIndex >= 0 && timeIndex >= 0) startIndex = 1;
    else { dateIndex = 0; timeIndex = 1; }

    let imported = 0, skipped = 0;
    const byDate = new Map(state.screenTime.map(r => [r.date, r]));

    for (const line of lines.slice(startIndex)) {
      const cells = parseCSVLine(line);
      const date = (cells[dateIndex] || "").trim();
      const minutes = parseDuration(cells[timeIndex]);
      if (!validISODate(date) || minutes === null || minutes > 1440) { skipped++; continue; }
      byDate.set(date, { date, minutes, source: "csv" });
      imported++;
    }

    state.screenTime = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    saveState(); renderAll();
    status.textContent = `${imported} Einträge importiert, ${skipped} Zeilen übersprungen. Prüfe bitte, ob Datum und Minuten richtig zugeordnet wurden.`;
  } catch (error) {
    status.textContent = `Import fehlgeschlagen: ${error.message}`;
  }
});

$("backup-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `PYP-backup-${today()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  $("backup-status").textContent = "Backup wurde zum Speichern bereitgestellt.";
});

$("backup-import").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const imported = normalize(JSON.parse(await file.text()));
    if (!confirm("Das Backup ersetzt deine aktuell gespeicherten PYP-Daten. Vorher am besten ein Backup exportieren. Fortfahren?")) {
      event.target.value = "";
      return;
    }
    state = imported;
    saveState(); renderAll();
    $("backup-status").textContent = "Backup importiert.";
  } catch (error) {
    $("backup-status").textContent = `Import fehlgeschlagen: ${error.message}`;
  }
  event.target.value = "";
});

function playTone() {
  // Sound erst nach einer bewussten Nutzeraktion; bei nicht unterstützten Browsern still bleiben.
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioContext) audioContext = new AudioCtx();
    if (audioContext.state === "suspended") audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.035, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.15);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.15);
  } catch (error) {
    console.info("Sound ist in diesem Browser nicht verfügbar.");
  }
}

function formatTimer(seconds) {
  const mins = Math.floor(Math.max(0, seconds) / 60);
  const secs = Math.max(0, seconds) % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function updateTimerDisplay() {
  $("timer-display").textContent = formatTimer(timerRemaining);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  timerEndAt = null;
}

$("timer-start").addEventListener("click", () => {
  if (timerInterval) {
    stopTimer();
    $("timer-start").textContent = "Weiter";
    $("timer-status").textContent = "Timer pausiert.";
    return;
  }

  if (timerRemaining <= 0) {
    const entered = Number($("timer-seconds").value);
    timerRemaining = Math.max(1, Math.min(3600, Number.isFinite(entered) ? entered : 90));
  }

  timerEndAt = Date.now() + timerRemaining * 1000;
  $("timer-start").textContent = "Pause";
  $("timer-status").textContent = "Pause läuft …";

  timerInterval = setInterval(() => {
    timerRemaining = Math.max(0, Math.ceil((timerEndAt - Date.now()) / 1000));
    updateTimerDisplay();
    if (timerRemaining <= 0) {
      stopTimer();
      $("timer-start").textContent = "Erneut starten";
      $("timer-status").textContent = "Pause vorbei. Bereit für den nächsten Satz.";
      playTone();
    }
  }, 250);
});

$("timer-reset").addEventListener("click", () => {
  stopTimer();
  const entered = Number($("timer-seconds").value);
  timerRemaining = Math.max(1, Math.min(3600, Number.isFinite(entered) && entered > 0 ? entered : 90));
  updateTimerDisplay();
  $("timer-start").textContent = "Start";
  $("timer-status").textContent = "Bereit für deinen nächsten Satz.";
});

$("timer-seconds").addEventListener("change", () => {
  if (timerInterval) return;
  const entered = Number($("timer-seconds").value);
  timerRemaining = Math.max(1, Math.min(3600, Number.isFinite(entered) && entered > 0 ? entered : 90));
  updateTimerDisplay();
});

window.addEventListener("beforeunload", () => stopTimer());

renderAll();
updateTimerDisplay();
showPage(location.hash.slice(1) || "dashboard");

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(error => {
      console.error("PYP konnte nicht für Offline-Nutzung eingerichtet werden:", error);
    });
  });
}
