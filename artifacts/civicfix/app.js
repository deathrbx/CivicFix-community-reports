const config = window.CIVICFIX_CONFIG ?? {};
const configured =
  typeof config.supabaseUrl === "string" &&
  config.supabaseUrl.startsWith("https://") &&
  !config.supabaseUrl.includes("YOUR_") &&
  typeof config.supabaseAnonKey === "string" &&
  config.supabaseAnonKey.length > 20 &&
  !config.supabaseAnonKey.includes("YOUR_");

const CATEGORY_LABELS = {
  waste: "Waste",
  roads: "Roads",
  streetlights: "Streetlights",
  water: "Water",
  safety: "Public Safety",
  facilities: "Public Facilities",
  environment: "Environment",
  other: "Other",
};

const STATUS_LABELS = {
  reported: "Reported",
  in_progress: "In progress",
  resolved: "Resolved",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let supabase = null;
let currentUser = null;
let currentPage = "dashboard";
let authMode = "login";
let nextPageAfterAuth = "dashboard";
let communityReports = [];
let myReports = [];
let reportStats = { total: 0, open: 0, progress: 0, resolved: 0, contributors: 0 };
let editingReportId = null;
let deletingReportId = null;
let sendingMessage = false;
let chatHistory = [];
let lastNewReportId = null;
let successTimer = null;
let pendingChatAfterAuth = false;

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = String(value);
}

function toast(message, type = "success") {
  const region = $("#toastRegion");
  if (!region) return;
  const item = textElement("div", `toast toast--${type}${type === "error" ? " is-error" : ""}`, message);
  item.setAttribute("role", type === "error" ? "alert" : "status");
  region.append(item);
  window.setTimeout(() => {
    item.classList.add("toast--leaving");
    window.setTimeout(() => item.remove(), 220);
  }, 3600);
}

function messageForAuthError(error) {
  const code = error?.code ?? "";
  const message = String(error?.message ?? "").toLowerCase();
  if (message.includes("invalid login credentials")) return "The email or password is incorrect.";
  if (message.includes("already registered") || message.includes("already exists")) {
    return "An account with this email already exists. Try logging in.";
  }
  if (message.includes("invalid email")) return "Please enter a valid email address.";
  if (message.includes("password") && (message.includes("weak") || message.includes("short"))) {
    return "Your password must be at least 6 characters.";
  }
  if (code === "over_email_send_rate_limit") return "Too many email attempts. Please wait a little and try again.";
  return "We couldn't complete that request. Please check your details and try again.";
}

function openDialog(selector) {
  const dialog = $(selector);
  if (!dialog) return;
  if (typeof dialog.showModal === "function") {
    dialog.hidden = false;
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.hidden = false;
    dialog.classList.add("is-open");
  }
}

function closeDialog(selector) {
  const dialog = $(selector);
  if (!dialog) return;
  if (typeof dialog.close === "function") {
    if (dialog.open) dialog.close();
    dialog.hidden = false;
  } else {
    dialog.hidden = true;
  }
  dialog.classList.remove("is-open");
}

function setAuthMessage(message, type = "error") {
  const element = $("#authMessage");
  if (!element) return;
  element.textContent = message;
  element.className = `form-message form-message--${type}`;
  element.hidden = !message;
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  const submit = $("#authSubmit");
  const toggle = $("#authModeToggle");
  const title = $("#authHeading");
  const copy = $("#authCopy");
  const switchCopy = $("[data-auth-switch-copy]");
  if (submit) {
    const label = signup ? "Create account" : "Sign in";
    submit.innerHTML = `${label} <svg class="icon"><use href="#i-arrow"/></svg>`;
    submit.dataset.defaultText = submit.textContent;
  }
  if (toggle) toggle.textContent = signup ? "Sign in" : "Create an account";
  if (switchCopy) switchCopy.textContent = signup ? "Already have an account?" : "New to CivicFix?";
  if (title) title.textContent = signup ? "Join your community" : "Welcome back";
  if (copy) copy.textContent = signup
    ? "Create an account to report issues and follow what your community shares."
    : "Sign in to follow reports and add your voice to the community.";
  setAuthMessage("");
}

function showLanding() {
  const landing = $("#landingView");
  const app = $("#appView");
  if (landing) landing.hidden = false;
  if (app) app.hidden = true;
}

function showApplication() {
  const landing = $("#landingView");
  const app = $("#appView");
  if (landing) landing.hidden = true;
  if (app) app.hidden = false;
  setText("#userEmail", currentUser?.email || "Resident");
  showPage(currentPage);
}

function showPage(page) {
  const available = ["dashboard", "community", "mine", "report"];
  currentPage = available.includes(page) ? page : "dashboard";
  for (const button of $$("[data-page]")) {
    const active = button.dataset.page === currentPage;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const name of available) {
    const panel = $(`#${name}Page`);
    if (panel) panel.hidden = currentPage !== name;
  }
  $(".app-sidebar")?.classList.remove("is-open");
  $("#mobileNavToggle")?.setAttribute("aria-expanded", "false");

  if (!currentUser) {
    showLanding();
    openAuthFor(page);
    return;
  }

  const breadcrumb = $("[data-current-page]");
  if (breadcrumb) {
    breadcrumb.textContent = {
      dashboard: "Overview",
      community: "Community feed",
      mine: "My reports",
      report: "New report",
    }[currentPage];
  }

  if (currentPage === "report") {
    $("#reportTitle")?.focus({ preventScroll: true });
  } else if (currentPage === "community" && communityReports.length === 0) {
    void loadReports();
  }
}

function openAuthFor(page = "dashboard") {
  nextPageAfterAuth = page;
  setAuthMode(authMode);
  if (!configured) {
    setAuthMessage("Connect CivicFix to Supabase first. Follow the “Connect Supabase” steps in README.md.");
  }
  openDialog("#authDialog");
  window.setTimeout(() => $("#authEmail")?.focus(), 80);
}

function applySession(session) {
  const previousUserId = currentUser?.id ?? null;
  currentUser = session?.user ?? null;
  if (!currentUser) {
    if (previousUserId) {
      communityReports = [];
      myReports = [];
      reportStats = { total: 0, open: 0, progress: 0, resolved: 0, contributors: 0 };
    }
    showLanding();
    return;
  }

  showApplication();
  closeDialog("#authDialog");
  if (previousUserId !== currentUser.id) {
    communityReports = [];
    myReports = [];
    void loadReports();
  }
  if (nextPageAfterAuth !== "dashboard") {
    const destination = nextPageAfterAuth;
    nextPageAfterAuth = "dashboard";
    showPage(destination);
  }
  if (pendingChatAfterAuth) {
    pendingChatAfterAuth = false;
    openChat();
  }
}

function relativeTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Recently";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  if (seconds < 172800) return "Yesterday";
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function statusPill(status) {
  const label = STATUS_LABELS[status] ?? "Reported";
  const pill = textElement("span", `status-pill status-pill--${status}`, label);
  return pill;
}

function createReportCard(report, owned = false) {
  const card = document.createElement("article");
  card.className = "report-card";
  card.dataset.reportId = report.id;
  if (report.id === lastNewReportId) {
    card.classList.add("report-card--new");
    lastNewReportId = null;
  }

  const header = document.createElement("div");
  header.className = "report-card__header";
  const category = textElement("span", "category-label", CATEGORY_LABELS[report.category] ?? "Other");
  const created = textElement("time", "report-card__time", relativeTime(report.created_at));
  created.dateTime = report.created_at;
  header.append(category, created);

  const title = textElement("h3", "report-card__title", report.title);
  const description = textElement("p", "report-card__description", report.description);
  const location = textElement("span", "report-card__location", report.location || "Location not specified");
  const footer = document.createElement("div");
  footer.className = "report-card__footer";

  const details = document.createElement("div");
  details.className = "report-card__badges";
  details.append(
    textElement("span", `priority-pill priority-pill--${report.priority}`, `${report.priority} priority`),
    statusPill(report.status),
  );
  footer.append(details);

  if (owned) {
    const controls = document.createElement("div");
    controls.className = "report-card__actions";
    const edit = textElement("button", "icon-button", "Edit");
    edit.type = "button";
    edit.dataset.action = "edit-report";
    edit.dataset.reportId = report.id;
    edit.setAttribute("aria-label", `Edit report: ${report.title}`);
    const remove = textElement("button", "icon-button icon-button--danger", "Delete");
    remove.type = "button";
    remove.dataset.action = "delete-report";
    remove.dataset.reportId = report.id;
    remove.setAttribute("aria-label", `Delete report: ${report.title}`);
    controls.append(edit, remove);
    footer.append(controls);
  }

  card.append(header, title, description, location, footer);
  return card;
}

function setListState(container, message, { error = false, retry = false } = {}) {
  if (!container) return;
  container.replaceChildren();
  const state = document.createElement("div");
  state.className = error ? "empty-state empty-state--error" : "empty-state";
  const heading = textElement("h3", "", error ? "Reports unavailable" : message);
  state.append(heading);
  if (error) state.append(textElement("p", "", message));
  state.setAttribute(error ? "role" : "aria-live", error ? "alert" : "polite");
  container.append(state);
  if (retry) {
    const button = textElement("button", "button button--secondary", "Try again");
    button.type = "button";
    button.dataset.action = "retry-load";
    state.append(button);
  }
}

function renderList(containerSelector, reports, { owned = false } = {}) {
  const container = $(containerSelector);
  if (!container) return;
  const visibleReports = containerSelector === "#communityReports"
    ? reports.filter((report) => {
        const filter = $("#communityFilter")?.value ?? "all";
        if (filter === "open") return report.status === "reported";
        if (filter === "progress") return report.status === "in_progress";
        if (filter === "resolved") return report.status === "resolved";
        return true;
      })
    : reports;
  if (visibleReports.length === 0) {
    const message =
      containerSelector === "#myReports"
        ? "You haven't reported anything yet."
        : reports.length > 0
          ? "No reports match this filter."
          : "No community reports yet. Be the first person to report an issue in your community.";
    setListState(container, message);
    if (containerSelector === "#myReports") {
      const button = textElement("button", "button button--primary", "Report an issue");
      button.type = "button";
      button.dataset.action = "go-report";
      $(".empty-state", container)?.append(button);
    }
    return;
  }
  container.replaceChildren(...visibleReports.map((report) => createReportCard(report, owned)));
}

function updateStats() {
  const values = {
    total: reportStats.total,
    open: reportStats.open,
    progress: reportStats.progress,
    resolved: reportStats.resolved,
  };
  for (const [name, value] of Object.entries(values)) {
    const node = $(`[data-stat="${name}"]`);
    if (node) node.textContent = String(value);
  }
  for (const [name, value] of Object.entries({
    contributors: reportStats.contributors,
    resolved: reportStats.resolved,
  })) {
    const node = $(`[data-impact="${name}"]`);
    if (node) node.textContent = String(value);
  }
}

async function getExactCount(query) {
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

async function loadReports() {
  if (!supabase || !currentUser) return;
  for (const selector of ["#recentReports", "#communityReports", "#myReports"]) {
    const container = $(selector);
    if (container) setListState(container, "Loading community reports…");
  }
  try {
    const fields = "id,user_id,title,description,category,location,priority,status,created_at,updated_at";
    const [
      communityResult,
      myResult,
      total,
      open,
      progress,
      resolved,
      impactResult,
    ] = await Promise.all([
      supabase.from("reports").select(fields).order("created_at", { ascending: false }).limit(100),
      supabase.from("reports").select(fields).eq("user_id", currentUser.id).order("created_at", { ascending: false }).limit(100),
      getExactCount(supabase.from("reports").select("id", { count: "exact", head: true })),
      getExactCount(supabase.from("reports").select("id", { count: "exact", head: true }).eq("status", "reported")),
      getExactCount(supabase.from("reports").select("id", { count: "exact", head: true }).eq("status", "in_progress")),
      getExactCount(supabase.from("reports").select("id", { count: "exact", head: true }).eq("status", "resolved")),
      supabase.rpc("civicfix_impact"),
    ]);

    if (communityResult.error) throw communityResult.error;
    if (myResult.error) throw myResult.error;
    if (impactResult.error) throw impactResult.error;

    communityReports = communityResult.data ?? [];
    myReports = myResult.data ?? [];
    reportStats = {
      total,
      open,
      progress,
      resolved,
      contributors: Number(impactResult.data ?? 0),
    };
    updateStats();
    renderList("#recentReports", communityReports.slice(0, 4));
    renderList("#communityReports", communityReports);
    renderList("#myReports", myReports, { owned: true });
  } catch (error) {
    console.error("CivicFix could not load reports:", error);
    const friendly = "We couldn't load community reports. Please try again.";
    for (const selector of ["#recentReports", "#communityReports", "#myReports"]) {
      setListState($(selector), friendly, { error: true, retry: true });
    }
    toast(friendly, "error");
  }
}

function setSubmitting(form, submitting, buttonSelector) {
  const button = $(buttonSelector, form);
  if (!button) return;
  if (!button.dataset.defaultHtml) button.dataset.defaultHtml = button.innerHTML || "Submit";
  button.disabled = submitting;
  button.setAttribute("aria-busy", String(submitting));
  button.innerHTML = submitting ? "Saving…" : button.dataset.defaultHtml;
}

function readForm(form, prefix = "") {
  const value = (name) => $(`#${prefix}${name}`, form)?.value?.trim() ?? "";
  return {
    title: value(prefix ? "Title" : "reportTitle"),
    category: value(prefix ? "Category" : "reportCategory"),
    description: value(prefix ? "Description" : "reportDescription"),
    location: value(prefix ? "Location" : "reportLocation"),
    priority: value(prefix ? "Priority" : "reportPriority") || "medium",
  };
}

function validateReport(input) {
  if (input.title.length < 5 || input.title.length > 120) {
    return "Use a title between 5 and 120 characters.";
  }
  if (!Object.hasOwn(CATEGORY_LABELS, input.category)) return "Choose an issue category.";
  if (input.description.length < 10 || input.description.length > 2000) {
    return "Use a description between 10 and 2,000 characters.";
  }
  if (input.location.length > 180) return "Keep the location under 180 characters.";
  if (!["low", "medium", "high"].includes(input.priority)) return "Choose a valid priority.";
  return null;
}

function showSuccessMoment(report) {
  setText("#successTitle", "Your report is in.");
  setText("#successMessage", "Thanks for adding a useful detail to the community picture.");
  setText("#successContribution", "");
  const overlay = $("#successOverlay");
  if (!overlay) {
    toast("Issue reported successfully");
    return;
  }
  if (successTimer) window.clearTimeout(successTimer);
  overlay.hidden = false;
  overlay.classList.add("is-visible");
  overlay.setAttribute("aria-hidden", "false");
  if (report?.id) lastNewReportId = report.id;
  successTimer = window.setTimeout(() => {
    overlay.classList.remove("is-visible");
    overlay.setAttribute("aria-hidden", "true");
    window.setTimeout(() => {
      overlay.hidden = true;
      if (report?.id) {
        showPage("community");
        document.querySelector(`[data-report-id="${CSS.escape(report.id)}"]`)?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }
    }, 260);
    toast("Issue reported successfully");
  }, 1750);
}

function dismissSuccess() {
  if (successTimer) window.clearTimeout(successTimer);
  successTimer = null;
  const overlay = $("#successOverlay");
  if (!overlay || overlay.hidden) return;
  overlay.classList.remove("is-visible");
  overlay.setAttribute("aria-hidden", "true");
  window.setTimeout(() => { overlay.hidden = true; }, 260);
  showPage("community");
}

async function submitReport(event) {
  event.preventDefault();
  if (!currentUser || !supabase) {
    openAuthFor("report");
    return;
  }
  const form = event.currentTarget;
  const input = readForm(form);
  const validationMessage = validateReport(input);
  if (validationMessage) {
    toast(validationMessage, "error");
    return;
  }
  setSubmitting(form, true, "#submitReport");
  try {
    const { data, error } = await supabase
      .from("reports")
      .insert({
        title: input.title,
        category: input.category,
        description: input.description,
        location: input.location || null,
        priority: input.priority,
      })
      .select("*")
      .single();
    if (error) throw error;
    form.reset();
    const priority = $("#reportPriority");
    if (priority) priority.value = "medium";
    await loadReports();
    showSuccessMoment(data);
  } catch (error) {
    console.error("CivicFix could not create report:", error);
    toast(error?.message?.includes("row-level security")
      ? "Your session could not be verified. Please sign in again."
      : "We couldn't save your report. Please check your connection and try again.", "error");
  } finally {
    setSubmitting(form, false, "#submitReport");
  }
}

function findOwnedReport(id) {
  return myReports.find((report) => report.id === id && report.user_id === currentUser?.id);
}

function openEditDialog(id) {
  const report = findOwnedReport(id);
  if (!report) {
    toast("That report is no longer available. Refresh and try again.", "error");
    return;
  }
  editingReportId = id;
  for (const [field, value] of [
    ["editTitle", report.title],
    ["editCategory", report.category],
    ["editDescription", report.description],
    ["editLocation", report.location ?? ""],
    ["editPriority", report.priority],
  ]) {
    const input = $(`#${field}`);
    if (input) input.value = value;
  }
  openDialog("#editDialog");
  $("#editTitle")?.focus();
}

async function submitEdit(event) {
  event.preventDefault();
  const report = findOwnedReport(editingReportId);
  if (!report || !supabase) return;
  const form = event.currentTarget;
  const input = readForm(form, "edit");
  const validationMessage = validateReport(input);
  if (validationMessage) {
    toast(validationMessage, "error");
    return;
  }
  setSubmitting(form, true, "#saveEdit");
  try {
    const { data, error } = await supabase
      .from("reports")
      .update({
        title: input.title,
        category: input.category,
        description: input.description,
        location: input.location || null,
        priority: input.priority,
      })
      .eq("id", report.id)
      .select("*")
      .single();
    if (error) throw error;
    myReports = myReports.map((item) => item.id === data.id ? data : item);
    communityReports = communityReports.map((item) => item.id === data.id ? data : item);
    renderList("#communityReports", communityReports);
    renderList("#recentReports", communityReports.slice(0, 4));
    renderList("#myReports", myReports, { owned: true });
    closeDialog("#editDialog");
    toast("Report updated");
    void loadReports();
  } catch (error) {
    console.error("CivicFix could not update report:", error);
    toast("We couldn't update this report. Please try again.", "error");
  } finally {
    setSubmitting(form, false, "#saveEdit");
  }
}

function openDeleteDialog(id) {
  if (!findOwnedReport(id)) {
    toast("That report is no longer available. Refresh and try again.", "error");
    return;
  }
  deletingReportId = id;
  openDialog("#deleteDialog");
  $("#confirmDelete")?.focus();
}

async function confirmDelete() {
  const report = findOwnedReport(deletingReportId);
  if (!report || !supabase) return;
  const button = $("#confirmDelete");
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Deleting…";
  }
  try {
    const { data, error } = await supabase
      .from("reports")
      .delete()
      .eq("id", report.id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Report could not be deleted.");
    myReports = myReports.filter((item) => item.id !== report.id);
    communityReports = communityReports.filter((item) => item.id !== report.id);
    reportStats.total = Math.max(0, reportStats.total - 1);
    if (report.status === "reported") reportStats.open = Math.max(0, reportStats.open - 1);
    if (report.status === "in_progress") reportStats.progress = Math.max(0, reportStats.progress - 1);
    if (report.status === "resolved") reportStats.resolved = Math.max(0, reportStats.resolved - 1);
    updateStats();
    renderList("#recentReports", communityReports.slice(0, 4));
    renderList("#communityReports", communityReports);
    renderList("#myReports", myReports, { owned: true });
    closeDialog("#deleteDialog");
    toast("Report deleted");
    void loadReports();
  } catch (error) {
    console.error("CivicFix could not delete report:", error);
    toast("We couldn't delete this report. Please try again.", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = button.dataset.defaultText || "Delete report";
    }
  }
}

function appendChatMessage(role, text) {
  const messages = $("#chatMessages");
  if (!messages) return;
  const article = document.createElement("div");
  article.className = `chat-message chat-message--${role}`;
  article.setAttribute("role", role === "assistant" ? "status" : "group");
  const bubble = textElement("p", "chat-message__bubble", text);
  article.append(bubble);
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;
}

function setChatBusy(busy) {
  const send = $("#chatForm button[type='submit']");
  const input = $("#chatInput");
  if (send) {
    send.disabled = busy;
    send.setAttribute("aria-busy", String(busy));
  }
  if (input) input.disabled = busy;
}

function openChat() {
  $("#civicAiPanel")?.classList.add("is-open");
  $("#civicAiPanel")?.setAttribute("aria-hidden", "false");
  $("#civicAiToggle")?.setAttribute("aria-expanded", "true");
  $("#chatInput")?.focus();
}

function requestOpenChat() {
  if (!currentUser) {
    pendingChatAfterAuth = true;
    openAuthFor(currentPage);
    return;
  }
  openChat();
}

function closeChat() {
  $("#civicAiPanel")?.classList.remove("is-open");
  $("#civicAiPanel")?.setAttribute("aria-hidden", "true");
  $("#civicAiToggle")?.setAttribute("aria-expanded", "false");
  $("#civicAiToggle")?.focus();
}

async function sendAIMessage(message) {
  const cleanMessage = message.trim();
  if (!cleanMessage || sendingMessage) return;
  if (!currentUser) {
    openAuthFor(currentPage);
    appendChatMessage("assistant", "Please sign in to use CivicAI.");
    return;
  }
  if (!supabase) {
    appendChatMessage("assistant", "CivicAI isn't available until CivicFix is connected to Supabase.");
    return;
  }

  sendingMessage = true;
  appendChatMessage("user", cleanMessage);
  chatHistory.push({ role: "user", content: cleanMessage });
  if (chatHistory.length > 10) chatHistory = chatHistory.slice(-10);
  const input = $("#chatInput");
  if (input) input.value = "";
  setChatBusy(true);
  const pending = textElement("div", "chat-message chat-message--assistant chat-message--pending", "CivicAI is thinking…");
  pending.setAttribute("aria-live", "polite");
  $("#chatMessages")?.append(pending);
  if ($("#chatMessages")) $("#chatMessages").scrollTop = $("#chatMessages").scrollHeight;

  try {
    const history = chatHistory.slice(0, -1);
    const { data, error } = await supabase.functions.invoke("civic-ai", {
      body: { message: cleanMessage, history },
    });
    pending.remove();
    if (error) {
      let messageText = "";
      try {
        const response = error.context;
        if (response instanceof Response) {
          const body = await response.clone().json();
          messageText = body?.error ?? "";
        }
      } catch {
        // Use the regular connection message if the function returned no JSON.
      }
      throw new Error(messageText || "I'm having trouble connecting right now. Please try again.");
    }
    if (typeof data?.answer !== "string" || !data.answer.trim()) {
      throw new Error("CivicAI couldn't prepare a response. Please try again.");
    }
    const answer = data.answer.trim();
    chatHistory.push({ role: "assistant", content: answer });
    if (chatHistory.length > 10) chatHistory = chatHistory.slice(-10);
    appendChatMessage("assistant", answer);
  } catch (error) {
    pending.remove();
    appendChatMessage("assistant", error?.message || "I'm having trouble connecting right now. Please try again.");
  } finally {
    sendingMessage = false;
    setChatBusy(false);
    $("#chatInput")?.focus();
  }
}

function clearChat() {
  chatHistory = [];
  const messages = $("#chatMessages");
  if (!messages) return;
  messages.replaceChildren();
  appendChatMessage(
    "assistant",
    "Hi! I'm CivicAI. I can help you report community issues and find practical ways to improve your neighborhood.",
  );
}

function bindEvents() {
  for (const button of $$("[data-page]")) {
    button.addEventListener("click", () => {
      const page = button.dataset.page;
      if (!currentUser) openAuthFor(page);
      else showPage(page);
    });
  }
  $("#communityFilter")?.addEventListener("change", () => {
    renderList("#communityReports", communityReports);
  });

  for (const button of $$("[data-action='open-auth']")) {
    button.addEventListener("click", () => openAuthFor("dashboard"));
  }
  $("#authModeToggle")?.addEventListener("click", () => {
    setAuthMode(authMode === "login" ? "signup" : "login");
  });

  $("#authForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!configured || !supabase) {
      setAuthMessage("Supabase isn't connected yet. Follow the “Connect Supabase” steps in README.md.");
      return;
    }
    const email = $("#authEmail")?.value.trim() ?? "";
    const password = $("#authPassword")?.value ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setAuthMessage("Please enter a valid email address.");
      return;
    }
    if (password.length < 6) {
      setAuthMessage("Your password must be at least 6 characters.");
      return;
    }
    const form = event.currentTarget;
    setSubmitting(form, true, "#authSubmit");
    setAuthMessage("");
    try {
      const result = authMode === "signup"
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (authMode === "signup" && !result.data.session) {
        setAuthMessage("Account created. Check your email to confirm it, then sign in.", "success");
        return;
      }
      toast(authMode === "signup" ? "Account created successfully." : "Welcome back.");
      applySession(result.data);
    } catch (error) {
      setAuthMessage(messageForAuthError(error));
    } finally {
      setSubmitting(form, false, "#authSubmit");
    }
  });

  $("#logoutButton")?.addEventListener("click", async () => {
    if (!supabase) return;
    const button = $("#logoutButton");
    if (button) button.disabled = true;
    const { error } = await supabase.auth.signOut();
    if (button) button.disabled = false;
    if (error) {
      toast("We couldn't sign you out. Please try again.", "error");
      return;
    }
    toast("Signed out");
    currentUser = null;
    communityReports = [];
    myReports = [];
    showLanding();
  });

  $("#reportForm")?.addEventListener("submit", submitReport);
  $("#editForm")?.addEventListener("submit", submitEdit);
  $("#confirmDelete")?.addEventListener("click", () => void confirmDelete());

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!target) return;
    const action = target.dataset.action;
    if (action === "edit-report") openEditDialog(target.dataset.reportId);
    if (action === "delete-report") openDeleteDialog(target.dataset.reportId);
    if (action === "start-report") {
      if (!currentUser) openAuthFor("report");
      else showPage("report");
    }
    if (action === "explore-community") {
      if (!currentUser) openAuthFor("community");
      else showPage("community");
    }
    if (action === "go-report") {
      if (!currentUser) openAuthFor("report");
      else showPage("report");
    }
    if (action === "retry-load") void loadReports();
    if (action === "open-civic-ai") requestOpenChat();
    if (action === "close-dialog") {
      const dialog = target.closest("dialog");
      if (dialog?.id) closeDialog(`#${dialog.id}`);
    }
    if (action === "close-success") dismissSuccess();
    if (action === "go-dashboard") {
      event.preventDefault();
      if (currentUser) showPage("dashboard");
      else showLanding();
    }
  });

  $("#mobileNavToggle")?.addEventListener("click", () => {
    const sidebar = $(".app-sidebar");
    const open = !sidebar?.classList.contains("is-open");
    sidebar?.classList.toggle("is-open", open);
    $("#mobileNavToggle")?.setAttribute("aria-expanded", String(open));
  });

  $("#civicAiToggle")?.addEventListener("click", () => {
    if ($("#civicAiPanel")?.classList.contains("is-open")) closeChat();
    else requestOpenChat();
  });
  $("#civicAiClose")?.addEventListener("click", closeChat);
  $("#clearChat")?.addEventListener("click", clearChat);
  for (const chip of $$("[data-prompt]")) {
    chip.addEventListener("click", () => void sendAIMessage(chip.dataset.prompt ?? ""));
  }
  $("#chatForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendAIMessage($("#chatInput")?.value ?? "");
  });
  $("#chatInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("#chatForm")?.requestSubmit();
    }
  });

  for (const selector of ["#authDialog", "#editDialog", "#deleteDialog"]) {
    $(selector)?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeDialog(selector);
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("#civicAiPanel")?.classList.contains("is-open")) closeChat();
  });
}

async function initializeApp() {
  bindEvents();
  if (!configured) {
    showLanding();
    document.body.classList.add("supabase-unconfigured");
    const notice = $("#configNotice");
    if (notice) notice.hidden = false;
    return;
  }

  let createClient;
  try {
    ({ createClient } = await import("https://esm.sh/@supabase/supabase-js@2"));
  } catch (error) {
    console.error("CivicFix could not load the Supabase client:", error);
    showLanding();
    toast("We couldn't load the Supabase client. Check your connection and refresh.", "error");
    return;
  }

  supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    showLanding();
    toast("We couldn't check your sign-in session. Please refresh and try again.", "error");
    return;
  }
  applySession(data);
  supabase.auth.onAuthStateChange((_event, session) => {
    queueMicrotask(() => applySession(session));
  });
}

void initializeApp();