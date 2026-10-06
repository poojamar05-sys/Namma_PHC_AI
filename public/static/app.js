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
    if (response.status >= 500) setServerUnavailable();
    else if (response.ok) setNetworkStatus(true);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
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

  function setServerUnavailable() {
    const badge = $("connection-status");
    badge.textContent = "● Server unavailable";
    badge.classList.remove("online");
    badge.classList.add("offline");
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

  function hearPass(pass) {
    if (!("speechSynthesis" in window)) {
      setMessage("booking-message", "இந்த சாதனத்தில் குரல் வசதி இல்லை · Voice playback is unavailable on this device.", true);
      return;
    }
    const arrival = pass.recommended_arrival_window || "Please ask PHC staff for your arrival time";
    const waiting = pass.estimated_wait_minutes == null
      ? ""
      : `Estimated wait is ${pass.estimated_wait_minutes} minutes.`;
    const tamil = pass.recommended_arrival_window
      ? `உங்கள் டோக்கன் ${pass.token}. ${arrival} மணியளவில் PHC-க்கு வாருங்கள். இப்போது PHC-ல் காத்திருக்க வேண்டிய அவசியமில்லை.`
      : `உங்கள் டோக்கன் ${pass.token}. வருகை நேரத்தை PHC பணியாளரிடம் உறுதிப்படுத்தவும்.`;
    const english = pass.recommended_arrival_window
      ? `Your token is ${pass.token}. Please visit ${pass.phc_name || "the PHC"} around ${arrival}. You do not need to wait at the PHC right now. ${waiting}`
      : `Your token is ${pass.token}. Please confirm your arrival time with PHC staff.`;
    window.speechSynthesis.cancel();
    [tamil, english].forEach((text, index) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = index === 0 ? "ta-IN" : "en-IN";
      utterance.rate = 0.88;
      window.speechSynthesis.speak(utterance);
    });
  }

  function renderPassTicket(pass, latest = false) {
    const ticket = element("article", `pass-ticket${latest ? " pass-ticket-featured" : " pass-ticket-older"}`);
    ticket.dataset.passId = pass.visit_pass_id;
    const confirmation = element("div", `pass-confirmation ${pass.synced ? "confirmed" : "pending"}`);
    confirmation.append(
      element("span", "pass-confirmation-icon", pass.synced ? "🟢" : "🟡"),
      element("span", "", pass.synced ? `உறுதி செய்யப்பட்டது · CONFIRMED · ${pass.token}` : "இணைப்பு நிலுவையில் · OFFLINE PASS"),
    );
    ticket.append(confirmation);

    if (latest) {
      ticket.append(element("h3", "pass-hero-heading", "🎫 உங்கள் வருகைச் சீட்டு · YOUR VISIT PASS"));
      const tokenPanel = element("div", "token-answer");
      tokenPanel.append(
        element("span", "answer-label", "உங்கள் டோக்கன் எண் · YOUR TOKEN"),
        element("strong", "pass-token", pass.token || "—"),
        element("span", "answer-detail", `${pass.name || "Patient"} · ${pass.phc_name || "Primary Health Centre"}`),
        element("span", "answer-detail", `சேவை · Service: ${pass.service || "General consultation"}`),
      );
      ticket.append(tokenPanel);

      const arrivalPanel = element("div", "arrival-answer");
      arrivalPanel.append(
        element("span", "answer-label", "🕐 நீங்கள் வர வேண்டிய நேரம் · YOUR VISIT TIME"),
        element("strong", "arrival-time-answer", pass.recommended_arrival_window || "PHC staff-ஐக் கேளுங்கள் · Ask PHC staff"),
        element(
          "span",
          "answer-detail",
          pass.estimated_wait_minutes == null
            ? "⏱ காத்திருப்பு நேரம் கிடைக்கவில்லை · Estimated wait unavailable"
            : `⏱ மதிப்பிடப்பட்ட காத்திருப்பு · Estimated wait: ${pass.estimated_wait_minutes} ${pass.estimated_wait_minutes === 1 ? "minute" : "minutes"}`,
        ),
      );
      ticket.append(arrivalPanel);

      const instruction = element("div", "wait-instruction");
      if (pass.recommended_arrival_window) {
        instruction.append(
          element("strong", "", `தயவுசெய்து ${pass.recommended_arrival_window} மணியளவில் PHC-க்கு வாருங்கள்.`),
          element("span", "", "இப்போது PHC-ல் காத்திருக்க வேண்டிய அவசியமில்லை."),
          element("span", "wait-instruction-en", `Please visit the PHC around ${pass.recommended_arrival_window}. You do not need to wait at the PHC right now.`),
        );
      } else {
        instruction.append(
          element("strong", "", "வருகை நேரத்தை PHC பணியாளரிடம் உறுதிப்படுத்தவும்."),
          element("span", "", "இணைப்பு மற்றும் வரிசை விவரம் கிடைத்ததும் நேரம் புதுப்பிக்கப்படும்."),
          element("span", "wait-instruction-en", "Please confirm your arrival time with PHC staff. This local pass is not yet in the PHC queue."),
        );
      }
      ticket.append(instruction);

      if (!pass.synced) {
        const offlineNote = element("p", "offline-pass-note");
        offlineNote.append(
          element("strong", "", "உங்கள் சீட்டு இந்தத் தொலைபேசியில் சேமிக்கப்பட்டுள்ளது."),
          element("span", "", "இணையம் திரும்பியதும் சேவையகத்துடன் தானாக ஒத்திசைக்கப்படும்."),
          element("span", "wait-instruction-en", "Your pass is saved on this phone. It will sync automatically when internet returns."),
        );
        ticket.append(offlineNote);
        if (pass.sync_error) {
          ticket.append(element("p", "pass-sync-error", `இன்னும் ஒத்திசைக்கப்படவில்லை · Not synced yet: ${pass.sync_error}`));
        }
      }
    } else {
      ticket.append(element("p", "pass-name", pass.name || "Patient"));
      ticket.append(element("p", "pass-detail", `${pass.phc_name || "Primary Health Centre"} · ${pass.service || "General consultation"}`));
      ticket.append(element("p", "pass-detail", pass.recommended_arrival_window || "Ask PHC staff for your arrival time"));
    }

    const actions = element("div", "pass-actions pass-actions-prominent");
    if (latest) {
      const hear = element("button", "button button-secondary", "🔊 கேட்டு அறிய / Hear");
      hear.type = "button";
      hear.addEventListener("click", () => hearPass(pass));
      actions.append(hear);

      const myPass = element("button", "button button-outline", "🎫 எனது சீட்டு / My Visit Pass");
      myPass.type = "button";
      myPass.addEventListener("click", () => showPass(pass));
      actions.append(myPass);

      const refresh = element("button", "button button-primary", "🔄 நிலையைப் புதுப்பிக்கவும் / Refresh Status");
      refresh.type = "button";
      refresh.addEventListener("click", async () => {
        if (navigator.onLine) await syncPending();
        await refreshQueue();
        const currentPass = passes.find((item) => item.visit_pass_id === pass.visit_pass_id) || pass;
        setMessage(
          "booking-message",
          currentPass.synced
            ? "வரிசை நிலை புதுப்பிக்கப்பட்டது · Queue status refreshed."
            : "உங்கள் சீட்டு இந்தத் தொலைபேசியில் பாதுகாப்பாக உள்ளது · Your pass remains saved on this phone.",
        );
      });
      actions.append(refresh);
    } else {
      const open = element("button", "button button-outline", "🎫 சீட்டைப் பார்க்கவும் · Open pass");
      open.type = "button";
      open.addEventListener("click", () => showPass(pass));
      actions.append(open);
    }
    ticket.append(actions);
    return ticket;
  }

  function renderPasses() {
    const container = $("saved-pass");
    const syncBadge = $("pass-sync");
    container.replaceChildren();
    if (!passes.length) {
      container.className = "empty-state";
      container.textContent = "வருகைச் சீட்டை உருவாக்கவும் · Create a Visit Pass to see your token and arrival time here.";
      syncBadge.textContent = "No pass saved";
      syncBadge.className = "badge badge-muted";
      return;
    }
    container.className = "";
    const latest = activePass();
    syncBadge.textContent = latest.synced ? "🟢 CONFIRMED" : "🟡 OFFLINE PASS";
    syncBadge.className = `badge ${latest.synced ? "" : "moderate"}`;
    passes.forEach((pass, index) => container.append(renderPassTicket(pass, index === 0)));
  }

  function locallyPredict(serverUnavailable = false) {
    const queue = readStorage(QUEUE_KEY, null);
    if (queue) renderQueue(queue, serverUnavailable ? "server" : "offline");
    else {
      $("queue-current").textContent = "—";
      $("queue-count").textContent = serverUnavailable
        ? "வரிசை கிடைக்கவில்லை · CURRENT QUEUE unavailable. Pass-ஐ இந்தத் தொலைபேசியில் சேமிக்கலாம்."
        : "இணையமின்றி வரிசை விவரம் இல்லை · CURRENT QUEUE unavailable offline.";
      $("queue-wait").textContent = "— min";
      $("arrival-window").textContent = "Ask PHC staff";
      $("queue-note").textContent = serverUnavailable
        ? "This pass will remain on this phone until the server database is configured and reachable."
        : "Connect to the PHC server for a live queue estimate.";
    }
  }

  function renderQueue(data, staleReason = "") {
    $("queue-current").textContent = data.current_token || data.current || "—";
    const count = data.waiting_patients ?? data.ahead ?? 0;
    $("queue-count").textContent = `தற்போதைய வரிசை · CURRENT QUEUE: ${count} ${count === 1 ? "patient" : "patients"}${staleReason ? " · last saved update" : ""}`;
    $("queue-wait").textContent = `${data.estimated_wait_minutes ?? data.estimated_minutes ?? 0} min`;
    $("arrival-window").textContent = data.recommended_arrival_window || "—";
    const badge = statusBadge(data.queue_status);
    $("queue-level").replaceWith(badge);
    badge.id = "queue-level";
    $("queue-note").textContent = staleReason === "server"
      ? "PHC server is unavailable: showing the last saved estimate. A local Visit Pass is not yet in the PHC queue."
      : staleReason === "offline"
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
      locallyPredict(true);
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

  function saveOfflinePass(data, syncError = null) {
    const cachedQueue = readStorage(QUEUE_KEY, {});
    const queueCount = cachedQueue.waiting_patients || 0;
    const estimate = cachedQueue.estimated_wait_minutes
      ?? (Object.keys(cachedQueue).length ? Math.ceil(queueCount * 9) : null);
    const now = new Date();
    const start = estimate === null ? null : new Date(now.getTime() + Math.max(0, estimate - 10) * 60000);
    const end = estimate === null ? null : new Date(now.getTime() + Math.max(10, estimate + 5) * 60000);
    const phcOption = PHC_SELECT.options[PHC_SELECT.selectedIndex];
    const pass = {
      ...data,
      token: `OFF-${String(passes.filter((saved) => saved.token && saved.token.startsWith("OFF-")).length + 1).padStart(3, "0")}`,
      phc_name: phcOption.textContent.split(" · ")[0],
      estimated_wait_minutes: estimate,
      queue_status: estimate === null ? "UNKNOWN" : estimate <= 20 ? "LOW" : estimate <= 60 ? "MODERATE" : "HIGH",
      recommended_arrival_window: estimate === null
        ? "Ask PHC staff"
        : `${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      created_at: now.toISOString(),
      synced: false,
      sync_error: syncError,
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
        if (!navigator.onLine || error.status >= 500 || /Failed to fetch|NetworkError/i.test(error.message)) {
          pass = saveOfflinePass(data, error.message);
          const explanation = error.status === 503 && error.message.includes("DATABASE_URL")
            ? "The server has no database configured. "
            : "The server could not save your pass. ";
          setMessage("booking-message", `${explanation}Visit Pass saved on this phone and pending sync; it is not yet in the PHC queue.`);
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
    if (pass.synced) setMessage("booking-message", "Visit Pass created and saved on this phone.");
    else if (!message.textContent) setMessage("booking-message", "No connection. Visit Pass saved on this phone and pending sync; it is not yet in the PHC queue.");
    refreshQueue();
    refreshStaff();
  });

  async function syncPending() {
    if (!navigator.onLine) return;
    const pending = passes.filter((pass) => !pass.synced);
    if (!pending.length) return;
    try {
      const response = await fetch("/api/sync", requestOptions("POST", { items: pending }));
      const body = await response.json();
      if (!response.ok) {
        if (response.status >= 500) setServerUnavailable();
        throw new Error(body.error || `Sync failed (${response.status}).`);
      }
      setNetworkStatus(true);
      const syncedIds = new Set((body.synced || []).map((pass) => pass.visit_pass_id));
      passes = passes.map((pass) => {
        const synced = (body.synced || []).find((item) => item.visit_pass_id === pass.visit_pass_id);
        return synced ? { ...pass, ...synced, synced: true, sync_error: null } : pass;
      });
      const failures = new Map((body.failures || []).map((failure) => [failure.visit_pass_id, failure.error]));
      passes = passes.map((pass) =>
        !pass.synced && failures.has(pass.visit_pass_id)
          ? { ...pass, sync_error: failures.get(pass.visit_pass_id) }
          : pass
      );
      savePasses();
      if (syncedIds.size) {
        setMessage("booking-message", `${syncedIds.size} offline Visit Pass${syncedIds.size === 1 ? "" : "es"} synced with the PHC.`);
        refreshQueue();
        refreshStaff();
      }
      if (body.failures && body.failures.length) {
        setMessage("booking-message", `Some passes are still waiting to sync: ${body.failures[0].error}`, true);
      }
    } catch (error) {
      if (!navigator.onLine) setNetworkStatus(false);
      else if (!error.status || error.status >= 500) setServerUnavailable();
      passes = passes.map((pass) => pass.synced ? pass : { ...pass, sync_error: error.message });
      savePasses();
      if (error.message) {
        setMessage("booking-message", `Visit Pass remains saved on this phone but is not synced: ${error.message}`, true);
      }
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
