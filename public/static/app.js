(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const PHC_SELECT = $("phc-select");
  const PASSES_KEY = "namma-phc-visit-passes";
  const QUEUE_KEY = "namma-phc-queue-snapshot";
  let passes = readStorage(PASSES_KEY, []);
  let lastDashboard = null;

  function readStorage(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function savePasses() {
    localStorage.setItem(PASSES_KEY, JSON.stringify(passes));
    updatePendingStatus();
    renderPasses();
  }

  function activePass() {
    return passes[0] || null;
  }

  function createId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
      const random = Math.floor(Math.random() * 16);
      return (character === "x" ? random : (random & 0x3) | 0x8).toString(16);
    });
  }

  async function fetchJson(url, options) {
    let response;
    try {
      const headers = new Headers(options?.headers || {});
      const staffCode = sessionStorage.getItem("namma-phc-staff-code");
      if (staffCode) headers.set("X-Staff-Access-Code", staffCode);
      response = await fetch(url, { ...options, headers });
    } catch (error) {
      setNetworkStatus(false);
      throw error;
    }
    setNetworkStatus(true);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }

  function requestOptions(method, body) {
    return {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  function setNetworkStatus(online) {
    const badge = $("connection-status");
    badge.textContent = online ? "● Online" : "● Offline";
    badge.classList.toggle("online", online);
    badge.classList.toggle("offline", !online);
    updatePendingStatus();
  }

  function updateNetwork() {
    setNetworkStatus(navigator.onLine);
  }

  function updatePendingStatus() {
    const pending = passes.filter((pass) => !pass.synced).length;
    $("pending-status").textContent = pending ? `${pending} pass${pending === 1 ? "" : "es"} waiting to sync` : "";
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setMessage(id, text, error = false) {
    const target = $(id);
    target.textContent = text;
    target.classList.toggle("error", error);
  }

  function statusBadge(status) {
    const badge = element("span", "badge", status || "—");
    if (status === "HIGH") badge.classList.add("high");
    if (status === "MODERATE") badge.classList.add("moderate");
    return badge;
  }

  function showPass(pass) {
    if (!pass) return;
    $("saved-pass").scrollIntoView({ behavior: "smooth", block: "center" });
    document.querySelectorAll(".pass-ticket").forEach((ticket) => {
      ticket.classList.toggle("selected-pass", ticket.dataset.passId === pass.visit_pass_id);
    });
  }

  function renderPasses() {
    const container = $("saved-pass");
    const syncBadge = $("pass-sync");
    container.replaceChildren();
    if (!passes.length) {
      container.className = "empty-state";
      container.textContent = "Create a pass while online or offline. Your saved pass will appear here.";
      syncBadge.textContent = "No pass saved";
      syncBadge.className = "badge badge-muted";
      return;
    }
    container.className = "";
    const latest = activePass();
    syncBadge.textContent = passes.some((pass) => !pass.synced) ? "Waiting to sync" : "Saved on this phone";
    syncBadge.className = `badge ${passes.some((pass) => !pass.synced) ? "moderate" : ""}`;
    passes.forEach((pass) => {
      const ticket = element("article", "pass-ticket");
      ticket.dataset.passId = pass.visit_pass_id;
      const top = element("div", "pass-top");
      const token = element("div", "pass-token", pass.token || "Visit Pass");
      top.append(token, statusBadge(pass.queue_status));
      ticket.append(top);
      ticket.append(element("p", "pass-name", pass.name || "Patient"));
      ticket.append(element("p", "pass-detail", `${pass.phc_name || "Primary Health Centre"} · ${pass.service || "General consultation"}`));
      ticket.append(element("p", "pass-detail", `Age: ${pass.age || "—"}${pass.phone ? ` · Phone: ${pass.phone}` : ""}`));
      ticket.append(element("p", "pass-arrival", `Estimated wait: ${pass.estimated_wait_minutes ?? "—"} min · Arrive: ${pass.recommended_arrival_window || "—"}`));
      ticket.append(element("p", "pass-detail", pass.synced ? "Synced with PHC" : "Stored offline · Will sync when connected"));
      const actions = element("div", "pass-actions");
      const refresh = element("button", "button button-outline", "Open saved pass");
      refresh.type = "button";
      refresh.addEventListener("click", () => showPass(pass));
      actions.append(refresh);
      if (pass.visit_pass_id === latest.visit_pass_id) {
        const current = element("span", "badge badge-muted", "Latest");
        actions.append(current);
      }
      ticket.append(actions);
      container.append(ticket);
    });
  }

  function locallyPredict() {
    const queue = readStorage(QUEUE_KEY, null);
    if (queue) renderQueue(queue, true);
    else {
      $("queue-current").textContent = "—";
      $("queue-count").textContent = "Queue information is unavailable offline. You can still create a Visit Pass.";
      $("queue-wait").textContent = "— min";
      $("arrival-window").textContent = "Ask PHC staff";
    }
  }

  function renderQueue(data, cached = false) {
    $("queue-current").textContent = data.current_token || data.current || "—";
    const count = data.waiting_patients ?? data.ahead ?? 0;
    $("queue-count").textContent = `${count} waiting patient${count === 1 ? "" : "s"}${cached ? " · last saved update" : ""}`;
    $("queue-wait").textContent = `${data.estimated_wait_minutes ?? data.estimated_minutes ?? 0} min`;
    $("arrival-window").textContent = data.recommended_arrival_window || "—";
    const badge = statusBadge(data.queue_status);
    $("queue-level").replaceWith(badge);
    badge.id = "queue-level";
    $("queue-note").textContent = cached
      ? "Offline: showing the last saved queue estimate. Create or open your Visit Pass anytime."
      : `Based on ${data.doctors_available} doctor(s), historical time/day patterns and the current queue.`;
  }

  async function refreshQueue() {
    if (!navigator.onLine) {
      locallyPredict();
      return;
    }
    try {
      const query = new URLSearchParams({ phc_id: PHC_SELECT.value });
      const data = await fetchJson(`/api/queue?${query}`);
      localStorage.setItem(QUEUE_KEY, JSON.stringify(data));
      renderQueue(data);
    } catch {
      locallyPredict();
    }
  }

  function bookingData(passId) {
    return {
      visit_pass_id: passId,
      name: $("patient-name").value.trim(),
      age: $("patient-age").value || null,
      phone: $("patient-phone").value.trim(),
      phc_id: PHC_SELECT.value,
      service: $("patient-service").value,
    };
  }

  function saveOfflinePass(data) {
    const cachedQueue = readStorage(QUEUE_KEY, {});
    const queueCount = cachedQueue.waiting_patients || 0;
    const estimate = cachedQueue.estimated_wait_minutes ?? Math.ceil(queueCount * 9);
    const now = new Date();
    const start = new Date(now.getTime() + Math.max(0, estimate - 10) * 60000);
    const end = new Date(now.getTime() + Math.max(10, estimate + 5) * 60000);
    const phcOption = PHC_SELECT.options[PHC_SELECT.selectedIndex];
    const pass = {
      ...data,
      token: `OFF-${String(passes.filter((saved) => saved.token && saved.token.startsWith("OFF-")).length + 1).padStart(3, "0")}`,
      phc_name: phcOption.textContent.split(" · ")[0],
      estimated_wait_minutes: estimate,
      queue_status: estimate <= 20 ? "LOW" : estimate <= 60 ? "MODERATE" : "HIGH",
      recommended_arrival_window: `${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      created_at: now.toISOString(),
      synced: false,
    };
    passes.unshift(pass);
    savePasses();
    return pass;
  }

  $("booking-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("booking-message");
    message.textContent = "";
    if (!$("booking-form").reportValidity()) return;
    const data = bookingData(createId());
    let pass;
    if (navigator.onLine) {
      try {
        pass = await fetchJson("/api/token", requestOptions("POST", data));
        pass.synced = true;
      } catch (error) {
        if (!navigator.onLine || /Failed to fetch|NetworkError/i.test(error.message)) {
          pass = saveOfflinePass(data);
        } else {
          setMessage("booking-message", error.message, true);
          return;
        }
      }
    } else {
      pass = saveOfflinePass(data);
    }
    if (pass.synced) {
      passes.unshift(pass);
      savePasses();
    }
    showPass(pass);
    setMessage("booking-message", pass.synced ? "Visit Pass created and saved on this phone." : "No connection. Visit Pass saved offline and queued to sync.");
    refreshQueue();
    refreshStaff();
  });

  async function syncPending() {
    if (!navigator.onLine) return;
    const pending = passes.filter((pass) => !pass.synced);
    if (!pending.length) return;
    try {
      const response = await fetch("/api/sync", requestOptions("POST", { items: pending }));
      setNetworkStatus(true);
      const body = await response.json();
      const syncedIds = new Set((body.synced || []).map((pass) => pass.visit_pass_id));
      passes = passes.map((pass) => {
        const synced = (body.synced || []).find((item) => item.visit_pass_id === pass.visit_pass_id);
        return synced ? { ...pass, ...synced, synced: true } : pass;
      });
      savePasses();
      if (syncedIds.size) {
        setMessage("booking-message", `${syncedIds.size} offline Visit Pass${syncedIds.size === 1 ? "" : "es"} synced with the PHC.`);
        refreshQueue();
        refreshStaff();
      }
      if (body.failures && body.failures.length) {
        setMessage("booking-message", `Some passes are still waiting to sync: ${body.failures[0].error}`, true);
      }
    } catch {
      setNetworkStatus(false);
    }
  }

  function makeSummary(symptoms, source = navigator.onLine ? "Local intake summary" : "Offline intake summary") {
    const lower = symptoms.toLowerCase();
    const matches = [
      ["chest pain", ["chest pain", "pain in chest", "chest tightness"]],
      ["severe breathing difficulty", ["severe breathing", "cannot breathe", "can't breathe", "difficulty breathing", "breathlessness"]],
      ["unconsciousness", ["unconscious", "not responding", "passed out"]],
      ["severe bleeding", ["severe bleeding", "heavy bleeding", "bleeding heavily"]],
    ].filter(([, phrases]) => phrases.some((phrase) => lower.includes(phrase))).map(([label]) => label);
    const knownDuration = ["today", "since yesterday", "for 2 days", "for two days", "for 3 days", "for three days", "for a week", "since morning"]
      .find((duration) => lower.includes(duration));
    return {
      summary: matches.length
        ? "A possible emergency warning sign was mentioned. Please seek urgent in-person assessment now; do not wait for an online response."
        : symptoms.split(/[.\n]/)[0].trim().slice(0, 180),
      duration: knownDuration || "Not specified",
      symptoms: symptoms.split(/[.\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 6),
      suggested_service_lane: matches.length ? "Emergency assessment now" : "General consultation",
      red_flags: matches,
      urgent: matches.length > 0,
      disclaimer: "AI assistance only. Not a medical diagnosis.",
      source,
    };
  }

  function renderSummary(summary) {
    const box = $("symptom-result");
    box.replaceChildren();
    box.classList.remove("hidden", "urgent");
    box.classList.toggle("error", Boolean(summary.error));
    if (summary.urgent) box.classList.add("urgent");
    const fields = [
      ["Summary", summary.summary],
      ["Duration", summary.duration],
      ["Symptoms", Array.isArray(summary.symptoms) ? summary.symptoms.join(", ") : summary.symptoms],
      ["Suggested service lane", summary.suggested_service_lane],
    ];
    fields.forEach(([label, value]) => {
      const line = element("p");
      line.append(element("span", "summary-label", `${label}: `), document.createTextNode(value || "Not specified"));
      box.append(line);
    });
    if (summary.red_flags && summary.red_flags.length) {
      const alert = element("p", "summary-label", `Safety alert: ${summary.red_flags.join(", ")}. Seek urgent in-person care now.`);
      box.append(alert);
    }
    if (summary.error) box.append(element("p", "summary-label", summary.error));
    box.append(element("p", "pass-detail", `Source: ${summary.source || "intake summary"} · ${summary.disclaimer || "AI assistance only. Not a medical diagnosis."}`));
  }

  $("summarize-button").addEventListener("click", async () => {
    const symptoms = $("symptom-input").value.trim();
    if (!symptoms) {
      renderSummary({ summary: "Describe the symptoms first.", duration: "Not specified", symptoms: [], suggested_service_lane: "General consultation", red_flags: [], urgent: false });
      return;
    }
    $("summarize-button").disabled = true;
    $("summarize-button").textContent = "Preparing summary…";
    const pass = activePass();
    try {
      if (!navigator.onLine) {
        renderSummary(makeSummary(symptoms));
      } else {
        const summary = await fetchJson("/api/ai/summarize", requestOptions("POST", {
          symptoms,
          visit_pass_id: pass?.visit_pass_id,
        }));
        renderSummary(summary);
        refreshStaff();
      }
    } catch (error) {
      if (!navigator.onLine || /Failed to fetch|NetworkError/i.test(error.message)) {
        renderSummary(makeSummary(symptoms, "Connection unavailable · local intake summary"));
      } else {
        renderSummary({
          ...makeSummary(symptoms, "AI unavailable · local intake summary"),
          error: error.message,
        });
      }
    } finally {
      $("summarize-button").disabled = false;
      $("summarize-button").textContent = "Prepare intake summary";
    }
  });

  function renderStaff(data) {
    lastDashboard = data;
    $("staff-current").textContent = data.current_token || "—";
    $("staff-waiting").textContent = data.waiting_patients ?? "—";
    $("staff-estimate").textContent = `${data.estimated_wait_minutes ?? "—"} min`;
    const list = $("staff-patients");
    list.replaceChildren();
    if (!data.patients || !data.patients.length) {
      list.className = "empty-state";
      list.textContent = "No patient Visit Passes recorded for this PHC today.";
    } else {
      list.className = "list-stack";
      data.patients.forEach((patient) => {
        const row = element("article", "patient-row");
        const details = element("div");
        details.append(element("strong", "", `${patient.token} · ${patient.name}`));
        details.append(element("p", "", `${patient.service} · ${patient.status} · ~${patient.estimated_wait_minutes} min`));
        row.append(details);
        if (patient.visit_pass_id) {
          const view = element("button", "button button-outline", "View pass");
          view.type = "button";
          view.addEventListener("click", () => {
            const saved = passes.find((pass) => pass.visit_pass_id === patient.visit_pass_id);
            if (saved) {
              document.querySelector('[data-panel="patient-panel"]').click();
              showPass(saved);
            } else {
              fetchJson(`/api/visit-pass/${encodeURIComponent(patient.visit_pass_id)}`)
                .then((pass) => {
                  passes.unshift(pass);
                  savePasses();
                  document.querySelector('[data-panel="patient-panel"]').click();
                  showPass(pass);
                })
                .catch((error) => setMessage("staff-message", error.message, true));
            }
          });
          row.append(view);
        }
        list.append(row);
      });
    }
    const intake = $("staff-intake");
    intake.replaceChildren();
    if (!data.latest_intake) {
      intake.className = "empty-state";
      intake.textContent = "No intake summary has been submitted yet.";
    } else {
      intake.className = "intake-row";
      intake.append(element("strong", "", `${data.latest_intake.token} · ${data.latest_intake.name}`));
      intake.append(element("p", "", `Patient said: ${data.latest_intake.symptoms}`));
      const summary = data.latest_intake.summary || {};
      intake.append(element("p", "", `Summary: ${summary.summary || "Not available"}`));
      intake.append(element("p", "", `Duration: ${summary.duration || "Not specified"} · Lane: ${summary.suggested_service_lane || "General consultation"}`));
    }
  }

  async function refreshStaff() {
    if (!navigator.onLine) {
      if (lastDashboard) renderStaff(lastDashboard);
      return;
    }
    try {
      const query = new URLSearchParams({ phc_id: PHC_SELECT.value });
      renderStaff(await fetchJson(`/api/dashboard?${query}`));
    } catch (error) {
      setMessage("staff-message", error.message, true);
    }
  }

  function renderAdmin(data) {
    $("admin-patients").textContent = data.today_patients;
    $("admin-wait").textContent = `${data.average_waiting_minutes} min`;
    $("admin-consult").textContent = `${data.average_consultation_minutes} min`;
    $("admin-priority").textContent = data.priority_cases.length;
    const busy = $("busy-hours");
    busy.replaceChildren();
    busy.className = data.busiest_hours.length ? "list-stack" : "empty-state";
    data.busiest_hours.forEach((item) => {
      const row = element("div", "busy-hour");
      row.append(element("strong", "", item.hour), element("span", "", `~${item.average_waiting} waiting`));
      busy.append(row);
    });
    const trend = $("queue-trend");
    trend.replaceChildren();
    const maxWait = Math.max(1, ...data.queue_trend.map((item) => item.average_wait_minutes));
    data.queue_trend.forEach((item) => {
      const day = element("div", "trend-item");
      day.append(element("span", "trend-value", `${item.average_wait_minutes}m`));
      const bar = element("div", "trend-bar");
      bar.style.height = `${Math.max(4, item.average_wait_minutes / maxWait * 110)}px`;
      bar.title = `${item.date}: ${item.average_wait_minutes} minute average wait`;
      day.append(bar, element("span", "", item.date.slice(5)));
      trend.append(day);
    });
    const priority = $("priority-list");
    priority.replaceChildren();
    priority.className = data.priority_cases.length ? "list-stack" : "empty-state";
    if (!data.priority_cases.length) priority.textContent = "No priority cases recorded.";
    data.priority_cases.forEach((item) => {
      const row = element("article", "priority-row");
      row.append(element("strong", "", `${item.token} · ${item.name}`));
      row.append(element("p", "", item.symptoms));
      priority.append(row);
    });
  }

  async function refreshAdmin() {
    if (!navigator.onLine) return;
    try {
      const query = new URLSearchParams({ phc_id: PHC_SELECT.value });
      renderAdmin(await fetchJson(`/api/dashboard?${query}`));
    } catch (error) {
      setMessage("admin-message", error.message, true);
    }
  }

  $("call-next").addEventListener("click", async () => {
    $("call-next").disabled = true;
    try {
      const result = await fetchJson("/api/staff/call-next", requestOptions("POST", { phc_id: PHC_SELECT.value }));
      setMessage("staff-message", `Now calling ${result.token} · ${result.name}.`);
      await refreshStaff();
      await refreshQueue();
    } catch (error) {
      setMessage("staff-message", error.message, true);
    } finally {
      $("call-next").disabled = false;
    }
  });

  function saveStaffAccessCode(inputId, messageId) {
    const code = $(inputId).value.trim();
    if (code) {
      sessionStorage.setItem("namma-phc-staff-code", code);
      setMessage(messageId, "Access code saved for this browser session.");
    } else {
      sessionStorage.removeItem("namma-phc-staff-code");
      setMessage(messageId, "Access code cleared.");
    }
    refreshStaff();
    refreshAdmin();
  }

  $("staff-access-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveStaffAccessCode("staff-access-code", "staff-message");
  });
  $("admin-access-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveStaffAccessCode("admin-access-code", "admin-message");
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
      document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === tab.dataset.panel));
      if (tab.dataset.panel === "staff-panel") refreshStaff();
      if (tab.dataset.panel === "admin-panel") refreshAdmin();
    });
  });

  $("refresh-queue").addEventListener("click", refreshQueue);
  $("staff-refresh").addEventListener("click", refreshStaff);
  $("admin-refresh").addEventListener("click", refreshAdmin);
  PHC_SELECT.addEventListener("change", () => {
    refreshQueue();
    if ($("staff-panel").classList.contains("active")) refreshStaff();
    if ($("admin-panel").classList.contains("active")) refreshAdmin();
  });

  window.addEventListener("online", () => {
    updateNetwork();
    syncPending();
    refreshQueue();
    refreshStaff();
  });
  window.addEventListener("offline", () => {
    updateNetwork();
    locallyPredict();
  });
  updateNetwork();
  renderPasses();
  refreshQueue();
  refreshStaff();
  refreshAdmin();
  syncPending();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/service-worker.js").catch((error) => {
        console.error("Service worker registration failed:", error);
      });
    });
  }
})();
