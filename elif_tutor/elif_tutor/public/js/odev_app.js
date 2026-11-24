/**
 * Elif Öğretmen — Frappe Ev Ödevi Asistanı Frontend
 * Tüm çağrılar Frappe @frappe.whitelist() uçlarına X-Frappe-CSRF-Token ile gider.
 */

const SUBJECTS = ["Matematik", "Fen Bilimleri", "Türkçe", "İngilizce", "Sosyal Bilgiler", "Din Kültürü"];
let currentSubject = "Matematik";
let activeSheet = null;
let avatar3D = null;
let camStream = null;

// --- Canlı Kronometre ---
let timerInterval = null;
let timerBaseSeconds = 0;
let timerStartedMs = 0;

// --- 4-Durumlu Ses FSM (Tek-Ses Kilidi + Bas-Konuş-Gönder) ---
let fsmState = "IDLE";
let speechEpoch = 0;
let ttsAbortCtrl = null;
let currentAudio = null;
let recognition = null;
let activeFinalTranscript = "";
let activeInterimTranscript = "";

const el = (id) => document.getElementById(id);

function showModal(title, htmlContent) {
  el("app-modal-title").textContent = title;
  el("app-modal-body").innerHTML = htmlContent;
  el("app-modal-backdrop").classList.remove("hidden");
}

function closeModal() {
  el("app-modal-backdrop").classList.add("hidden");
}

function showToast(message, type = "info", durationMs = 3600) {
  const stack = el("app-toast-stack");
  if (!stack) return;
  const item = document.createElement("div");
  item.className = `toast-item ${type}`;
  item.textContent = message;
  stack.appendChild(item);
  setTimeout(() => {
    item.style.opacity = "0";
    item.style.transition = "opacity 0.25s ease";
    setTimeout(() => item.remove(), 260);
  }, durationMs);
}

el("app-modal-close").onclick = closeModal;
el("app-modal-ok").onclick = closeModal;
el("app-modal-backdrop").onclick = (e) => {
  if (e.target === el("app-modal-backdrop")) closeModal();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function formatDurationTR(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m === 0 ? `${rem} sn` : `${m} dk ${rem} sn`;
}

async function frappeCall(method, params = null, isFormData = false, signal = undefined) {
  const headers = { "X-Frappe-CSRF-Token": window.FRAPPE_CSRF_TOKEN || "" };
  let body;
  if (isFormData) {
    body = params;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(params || {});
  }
  const res = await fetch(`/api/method/${method}`, {
    method: "POST",
    headers,
    body,
    credentials: "same-origin",
    signal,
  });
  if (res.status === 401 || res.status === 403) {
    window.location.href = "/login";
    throw new Error("Oturum süresi doldu");
  }
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const msg = data._server_messages || data.exception || data.message || `Sunucu hatası (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data.message;
}

function syncSheetTimer(sheet) {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  activeSheet = sheet || null;
  if (!sheet) {
    el("pill-timer").textContent = "⏱ Ödev Süresi: 00:00";
    el("pill-grade").textContent = "🏅 Zaman Notu: —";
    return;
  }
  timerBaseSeconds = Number(sheet.duration_seconds || 0);
  timerStartedMs = Date.now();
  el("pill-grade").textContent = `🏅 Zaman Notu: ${sheet.time_grade || "Devam Ediyor"}`;
  el("pill-tokens").textContent = `⚡ Token: ${sheet.tokens_used || 0}`;

  if (sheet.status === "completed") {
    el("pill-timer").textContent = `⏱ Tamamlandı: ${formatDuration(timerBaseSeconds)}`;
    return;
  }
  const tick = () => {
    const live = timerBaseSeconds + Math.floor((Date.now() - timerStartedMs) / 1000);
    el("pill-timer").textContent = `⏱ Ödev Süresi: ${formatDuration(live)}`;
  };
  tick();
  timerInterval = setInterval(tick, 1000);
}

function updateVoiceUI(state, statusText = "", highlightTurn = false) {
  fsmState = state;
  const btn = el("btn-voice-action");
  const cancelBtn = el("btn-voice-cancel");
  const txBox = el("voice-transcript-box");

  const labels = {
    IDLE: highlightTurn ? "👉 Sıra sende! 'Sesli Cevap Ver' butonuna bas." : "⚪ Hazır",
    THINKING: "🔵 Elif Öğretmen düşünüyor...",
    SPEAKING: "🔊 Elif Öğretmen anlatıyor...",
    LISTENING: "🎙️ Seni dinliyorum... Bitince 'Cevabı Gönder'e bas!",
  };
  el("voice-status").textContent = statusText || labels[state] || state;
  btn.classList.remove("btn-emerald", "btn-primary", "btn-danger", "btn-soft", "btn-pulse");

  if (state === "IDLE") {
    btn.disabled = false;
    btn.classList.add("btn-emerald");
    if (highlightTurn) btn.classList.add("btn-pulse");
    btn.textContent = "🎙️ Sesli Cevap Ver";
    cancelBtn.classList.add("hidden");
    txBox.classList.add("hidden");
    txBox.textContent = "";
  } else if (state === "THINKING") {
    btn.disabled = true;
    btn.classList.add("btn-soft");
    btn.textContent = "⏳ Elif Öğretmen Hazırlanıyor...";
    cancelBtn.classList.add("hidden");
    txBox.classList.add("hidden");
  } else if (state === "SPEAKING") {
    btn.disabled = false;
    btn.classList.add("btn-soft");
    btn.textContent = "⏹ Anlatımı Durdur";
    cancelBtn.classList.add("hidden");
    txBox.classList.add("hidden");
  } else if (state === "LISTENING") {
    btn.disabled = false;
    btn.classList.add("btn-primary");
    btn.textContent = "✅ Cevabı Gönder";
    cancelBtn.classList.remove("hidden");
    txBox.classList.remove("hidden");
    txBox.textContent = "🎙️ Konuşmaya başlayabilirsin...";
  }
}

function hardStopAllAudioAndMic() {
  speechEpoch += 1;
  if (ttsAbortCtrl) { try { ttsAbortCtrl.abort(); } catch (_) {} ttsAbortCtrl = null; }
  if (currentAudio) { try { currentAudio.pause(); currentAudio.src = ""; } catch (_) {} currentAudio = null; }
  if ("speechSynthesis" in window) { try { window.speechSynthesis.cancel(); } catch (_) {} }
  if (recognition) { try { recognition.onend = null; recognition.onerror = null; recognition.abort(); } catch (_) {} recognition = null; }
  activeFinalTranscript = "";
  activeInterimTranscript = "";
  if (avatar3D) avatar3D.isSpeaking = false;
}

function renderSubjectChips() {
  el("subject-chips").innerHTML = SUBJECTS.map(
    (s) => `<button class="subj-chip ${s === currentSubject ? "active" : ""}" onclick="selectSubject('${s}')">${s}</button>`
  ).join("");
}

function selectSubject(subj) {
  currentSubject = subj;
  renderSubjectChips();
}

function renderActiveSheet(sheet) {
  if (!sheet) return;
  syncSheetTimer(sheet);
  if (sheet.whiteboard && Object.keys(sheet.whiteboard).length) {
    renderWhiteboard(sheet.whiteboard);
  }
  const feed = el("chat-feed");
  feed.innerHTML = (sheet.messages || [])
    .map(
      (m) => `
      <div class="msg ${String(m.role || "").includes("Öğretmen") ? "teacher" : "student"}">
        <strong>${escapeHtml(m.role)}:</strong> ${escapeHtml(m.text)}
      </div>`
    )
    .join("");
  feed.scrollTop = feed.scrollHeight;

  const qs = sheet.questions || [];
  const solvedCount = qs.filter((q) => q.status === "solved").length;
  el("hw-count").textContent = `${solvedCount}/${qs.length} oldu`;
  const badges = { solved: "✅ Oldu", in_progress: "🔵 Devam", needs_retry: "❌ Tekrar", pending: "⚪ Bekliyor" };
  el("hw-list").innerHTML = qs
    .map(
      (q) => {
        const safeStatus = Object.prototype.hasOwnProperty.call(badges, q.status) ? q.status : "pending";
        return `
      <div class="bank-item ${q.question_no === sheet.active_question_no ? "sheet-item active" : ""}" onclick="openSheet('${escapeHtml(sheet.sheet_id)}', ${Number(q.question_no) || 1})">
        <div>
          <span class="hw-status hw-${safeStatus}">${badges[safeStatus]}</span>
          <strong>Soru ${Number(q.question_no) || 1}</strong>
          <span class="muted">(${formatDurationTR(q.duration_seconds)})</span>
        </div>
        <div class="muted">${escapeHtml((q.question_text || "").slice(0, 68))}...</div>
      </div>`;
      }
    )
    .join("") || '<div class="muted">Ödev sayfası yüklendiğinde sorular burada görünür.</div>';
}

async function loadSheetsList() {
  const res = await frappeCall("elif_tutor.api.list_sheets", {});
  const sheets = res.sheets || [];
  el("sheets-count").textContent = `${sheets.length} sayfa`;
  el("sheets-list").innerHTML = sheets
    .map((sh) => {
      const done = sh.status === "completed";
      const activeCls = activeSheet && sh.sheet_id === activeSheet.sheet_id ? "active" : "";
      return `
      <div class="bank-item sheet-item ${activeCls}" onclick="openSheet('${escapeHtml(sh.sheet_id)}')">
        <div>
          <span class="hw-status ${done ? "hw-solved" : "hw-in_progress"}">${done ? "✅ Bitti" : "🔵 Devam"}</span>
          <strong>${escapeHtml(sh.title)}</strong>
        </div>
        <div class="muted">${sh.solved_questions}/${sh.total_questions} soru • ⏱ ${formatDurationTR(sh.duration_seconds)}</div>
        <div class="muted" style="color:var(--emerald);font-weight:700;">🏅 ${escapeHtml(sh.time_grade || "Devam Ediyor")}</div>
      </div>`;
    })
    .join("") || '<div class="muted">Henüz ödev sayfası yüklenmedi. Fotoğraf veya PDF yükleyerek başla!</div>';
}

async function openSheet(sheetId, questionNo = null) {
  hardStopAllAudioAndMic();
  const myEpoch = speechEpoch;
  updateVoiceUI("THINKING", "📄 Ödev sayfası açılıyor...");
  try {
    const payload = { sheet_id: sheetId };
    if (questionNo !== null) payload.question_no = questionNo;
    const data = await frappeCall("elif_tutor.api.open_sheet", payload);
    if (myEpoch !== speechEpoch) return;
    renderActiveSheet(data.sheet);
    await loadSheetsList();
    await speakTeacherAndWaitButton(data.spoken_text, data.emotion || "happy");
  } catch (e) {
    updateVoiceUI("IDLE", "Ödev sayfası açılamadı.");
  }
}

async function speakTeacherAndWaitButton(text, emotion = "happy") {
  if (!text) { updateVoiceUI("IDLE", "", true); return; }
  hardStopAllAudioAndMic();
  const myEpoch = speechEpoch;

  updateVoiceUI("SPEAKING");
  const emoLabels = { happy: "😊 Mutlu", thinking: "🤔 Düşünüyor", celebrate: "🎉 Harikasın!", encouraging: "💙 Destekliyor" };
  el("avatar-emotion-pill").textContent = emoLabels[emotion] || "😊 Anlatıyor";
  if (avatar3D) avatar3D.setEmotion(emotion);

  let played = false;
  try {
    ttsAbortCtrl = new AbortController();
    const ttsRes = await frappeCall("elif_tutor.api.tts_audio", { text }, false, ttsAbortCtrl.signal);
    if (myEpoch !== speechEpoch) return;
    if (ttsRes && ttsRes.audio_b64) {
      const bin = atob(ttsRes.audio_b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: ttsRes.mime || "audio/wav" });
      const url = URL.createObjectURL(blob);
      await new Promise((resolve) => {
        const audio = new Audio(url);
        currentAudio = audio;
        if (avatar3D) avatar3D.attachAudioElement(audio, text);
        const cleanup = () => {
          URL.revokeObjectURL(url);
          if (currentAudio === audio) currentAudio = null;
          if (avatar3D) avatar3D.isSpeaking = false;
          resolve();
        };
        audio.onended = cleanup;
        audio.onerror = cleanup;
        audio.play().catch(cleanup);
      });
      played = true;
    }
  } catch (e) {
    if (e.name === "AbortError" || myEpoch !== speechEpoch) return;
  }

  if (!played && myEpoch === speechEpoch && "speechSynthesis" in window) {
    await new Promise((resolve) => {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "tr-TR";
      if (avatar3D) {
        avatar3D.setSpeechText(text);
        avatar3D.isSpeaking = true;
      }
      u.onend = () => { if (avatar3D) avatar3D.isSpeaking = false; resolve(); };
      u.onerror = () => { if (avatar3D) avatar3D.isSpeaking = false; resolve(); };
      window.speechSynthesis.speak(u);
    });
  }

  if (myEpoch !== speechEpoch) return;
  el("avatar-emotion-pill").textContent = "😊 Cevabını Bekliyor";
  updateVoiceUI("IDLE", "👉 Sıra sende! Cevabını söylemek için 'Sesli Cevap Ver' butonuna bas.", true);
}

function startManualListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showToast("Tarayıcın sesli algılamayı desteklemiyor (Chrome önerilir). Cevabını yazılı kutudan gönderebilirsin.", "warn", 4500);
    return;
  }
  hardStopAllAudioAndMic();
  const myEpoch = speechEpoch;
  activeFinalTranscript = "";
  activeInterimTranscript = "";
  updateVoiceUI("LISTENING");
  el("avatar-emotion-pill").textContent = "👂 Seni Dinliyor";

  const launch = () => {
    if (myEpoch !== speechEpoch || fsmState !== "LISTENING") return;
    const rec = new SR();
    recognition = rec;
    rec.lang = "tr-TR";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      if (myEpoch !== speechEpoch || fsmState !== "LISTENING") return;
      activeInterimTranscript = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) activeFinalTranscript += ev.results[i][0].transcript + " ";
        else activeInterimTranscript += ev.results[i][0].transcript;
      }
      const p = (activeFinalTranscript + " " + activeInterimTranscript).trim();
      el("voice-transcript-box").textContent = p ? `🎙️ "${p}"` : "🎙️ Konuşmaya başlayabilirsin...";
    };
    rec.onerror = (e) => {
      if (myEpoch !== speechEpoch || fsmState !== "LISTENING") return;
      if (e.error === "no-speech") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        hardStopAllAudioAndMic();
        updateVoiceUI("IDLE", "Mikrofon izni verilmedi.", false);
      }
    };
    rec.onend = () => { if (myEpoch === speechEpoch && fsmState === "LISTENING") setTimeout(launch, 200); };
    try { rec.start(); } catch (_) {}
  };
  launch();
}

function submitManualListening() {
  const ans = (activeFinalTranscript + " " + activeInterimTranscript).trim();
  hardStopAllAudioAndMic();
  if (!ans) { updateVoiceUI("IDLE", "Ses algılanmadı, tekrar basabilirsin.", true); return; }
  sendStudentMessage(ans);
}

function cancelManualListening() {
  hardStopAllAudioAndMic();
  updateVoiceUI("IDLE", "Kayıt iptal edildi.", true);
}

async function sendStudentMessage(text) {
  if (!activeSheet) {
    showToast("Önce bir ödev sayfası yükle veya soldan geçmiş bir ödev seç!", "warn");
    return;
  }
  if (!text.trim()) return;
  hardStopAllAudioAndMic();
  const myEpoch = speechEpoch;
  updateVoiceUI("THINKING");
  el("avatar-emotion-pill").textContent = "🤔 Cevabını İnceliyor";
  if (avatar3D) avatar3D.setEmotion("thinking");

  try {
    const data = await frappeCall("elif_tutor.api.chat_turn", { sheet_id: activeSheet.sheet_id, text });
    if (myEpoch !== speechEpoch) return;
    renderActiveSheet(data.sheet);
    await loadSheetsList();
    await speakTeacherAndWaitButton(data.spoken_text, data.emotion || "happy");
  } catch (e) {
    updateVoiceUI("IDLE", "Cevap gönderilemedi, tekrar dene.", true);
  }
}

async function sendSnapshotBlob(blob, note = "", filename = "odev.jpg") {
  hardStopAllAudioAndMic();
  const myEpoch = speechEpoch;
  updateVoiceUI("THINKING", "👀 Ödev sayfası okunuyor ve Frappe'ye kaydediliyor...");
  el("avatar-emotion-pill").textContent = "👀 Ödev Sayfasını Okuyor";
  if (avatar3D) avatar3D.setEmotion("thinking");

  const fd = new FormData();
  fd.append("file", blob, filename);
  fd.append("subject", currentSubject);
  fd.append("note", note);

  try {
    const data = await frappeCall("elif_tutor.api.upload_homework_page", fd, true);
    if (myEpoch !== speechEpoch) return;
    if (data.sheet) renderActiveSheet(data.sheet);
    else if (data.whiteboard) renderWhiteboard(data.whiteboard);
    await loadSheetsList();
    await speakTeacherAndWaitButton(data.spoken_text, data.emotion || "happy");
  } catch (e) {
    showModal("Ödev Sayfası Yüklenemedi", `<p>${escapeHtml(e.message || "Bağlantı hatası oluştu, lütfen tekrar dene.")}</p>`);
    updateVoiceUI("IDLE", "Tekrar deneyebilirsin.");
  }
}

async function toggleCamera() {
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
    el("cam-video").classList.add("hidden");
    el("btn-snap-cam").disabled = true;
    el("btn-toggle-cam").textContent = "📷 Defter Kamerasını Aç";
    return;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
    el("cam-video").srcObject = camStream;
    el("cam-video").classList.remove("hidden");
    el("btn-snap-cam").disabled = false;
    el("btn-toggle-cam").textContent = "⏹ Kamerayı Kapat";
  } catch (e) {
    showModal("Kamera İzni Gerekli", `<p>Kamera açılamadı: <strong>${escapeHtml(e.message)}</strong></p><p class="muted">Tarayıcının adres çubuğundan kamera iznini açabilir veya doğrudan 'Ödev Sayfası Yükle' butonunu kullanabilirsin.</p>`);
  }
}

el("btn-voice-action").onclick = () => {
  if (fsmState === "IDLE") startManualListening();
  else if (fsmState === "LISTENING") submitManualListening();
  else if (fsmState === "SPEAKING") {
    hardStopAllAudioAndMic();
    updateVoiceUI("IDLE", "Anlatım durduruldu. Hazır olduğunda 'Sesli Cevap Ver'e bas.", true);
  }
};
el("btn-voice-cancel").onclick = cancelManualListening;
el("btn-toggle-cam").onclick = toggleCamera;
el("btn-snap-cam").onclick = () => {
  const v = el("cam-video"), c = el("cam-snap-canvas");
  c.width = Math.min(1024, v.videoWidth || 1024);
  c.height = Math.round(c.width * ((v.videoHeight || 720) / (v.videoWidth || 1280)));
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  const note = el("chat-input").value;
  el("chat-input").value = "";
  c.toBlob((blob) => sendSnapshotBlob(blob, note, "odev_kamera.jpg"), "image/jpeg", 0.82);
};
el("btn-upload-img").onclick = () => el("input-img-file").click();
el("input-img-file").onchange = (e) => {
  const f = e.target.files[0];
  const note = el("chat-input").value;
  el("chat-input").value = "";
  if (f) sendSnapshotBlob(f, note, f.name || "odev.jpg");
  e.target.value = "";
};
el("btn-parent-report").onclick = async () => {
  try {
    const res = await frappeCall("elif_tutor.api.list_sheets", {});
    const sheets = res.sheets || [];
    const completed = sheets.filter((s) => s.status === "completed").length;
    const totalSec = sheets.reduce((acc, s) => acc + Number(s.duration_seconds || 0), 0);
    const scored = sheets.filter((s) => Number(s.time_score || 0) > 0);
    const avgScore = scored.length
      ? Math.round(scored.reduce((a, s) => a + Number(s.time_score || 0), 0) / scored.length)
      : 0;

    const rowsHtml = sheets.length
      ? sheets
          .map(
            (s) => `
          <div class="report-row">
            <div>
              <div>
                <span class="hw-status ${s.status === "completed" ? "hw-solved" : "hw-in_progress"}">
                  ${s.status === "completed" ? "✅ Bitti" : "🔵 Devam"}
                </span>
                <strong>${escapeHtml(s.title)}</strong>
              </div>
              <div class="muted">
                ${escapeHtml((s.started_at || "").slice(0, 16))} • ${s.solved_questions}/${s.total_questions} soru • ⏱ ${formatDurationTR(s.duration_seconds)}
              </div>
              <div style="font-size:0.76rem;font-weight:700;color:var(--emerald);margin-top:2px;">
                🏅 ${escapeHtml(s.time_grade || "Devam Ediyor")}
              </div>
            </div>
            <button class="btn btn-outline" onclick="closeModal(); openSheet('${escapeHtml(s.sheet_id)}')">Aç</button>
          </div>`
          )
          .join("")
      : '<p class="muted">Henüz kaydedilmiş bir ödev sayfası yok.</p>';

    const memories = res.memories || [];
    const memBadges = {
      mastered: { cls: "hw-solved", txt: "🌟 Pekiştirdi" },
      needs_review: { cls: "hw-needs_retry", txt: "⚠️ Tekrar Gerekli" },
      learning: { cls: "hw-in_progress", txt: "📘 Öğreniyor" },
    };
    const memHtml = memories.length
      ? `<div style="margin-top:8px;font-weight:800;color:var(--brand-blue);">🧠 Uzun Dönem Öğrenme Hafızası (Dersler Arası)</div>` +
        memories
          .map((m) => {
            const b = memBadges[m.mastery_status] || memBadges.learning;
            return `
            <div class="report-row" style="flex-direction:column;align-items:flex-start;gap:4px;">
              <div>
                <span class="hw-status ${b.cls}">${b.txt}</span>
                <strong>${escapeHtml(m.subject)} — ${escapeHtml(m.topic)}</strong>
                <span class="muted">(${m.solved_count} doğru • ${m.mistake_count} takılma)</span>
              </div>
              ${m.struggle_notes ? `<div class="muted" style="color:var(--amber);">Takıldığı: ${escapeHtml(m.struggle_notes.replace(/\n/g, " | "))}</div>` : ""}
              ${m.strength_notes ? `<div class="muted" style="color:var(--emerald);">Güçlü: ${escapeHtml(m.strength_notes.replace(/\n/g, " | "))}</div>` : ""}
            </div>`;
          })
          .join("")
      : "";

    showModal(
      "📊 Ödev Geçmişi & Zaman Notları",
      `<div class="report-kpi-row">
        <div class="report-kpi"><strong>${completed}/${sheets.length}</strong><span class="muted">Tamamlanan Ödev</span></div>
        <div class="report-kpi"><strong>${formatDurationTR(totalSec)}</strong><span class="muted">Toplam Süre</span></div>
        <div class="report-kpi"><strong>${avgScore ? avgScore + "/100" : "—"}</strong><span class="muted">Ortalama Zaman Puanı</span></div>
      </div>
      ${rowsHtml}
      ${memHtml}`
    );
  } catch (e) {
    showToast("Ödev geçmişi yüklenemedi.", "error");
  }
};
el("btn-logout").onclick = async () => {
  await fetch("/api/method/logout", { method: "POST", headers: { "X-Frappe-CSRF-Token": window.FRAPPE_CSRF_TOKEN || "" } });
  window.location.href = "/login";
};
el("btn-toggle-pen").onclick = () => {
  const c = el("student-draw-canvas");
  const on = c.classList.toggle("drawing");
  el("btn-toggle-pen").textContent = on ? "✏️ Kalemi Kapat" : "✏️ Kalemi Aç";
};
el("btn-clear-pen").onclick = () => window.clearStudentCanvas && window.clearStudentCanvas();
el("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const txt = el("chat-input").value;
  el("chat-input").value = "";
  await sendStudentMessage(txt);
};

async function initOdevApp() {
  avatar3D = new TeacherAvatar3D("avatar-3d-container");
  initStudentPen();
  renderSubjectChips();
  await loadSheetsList();
  updateVoiceUI("IDLE");
}

initOdevApp();
