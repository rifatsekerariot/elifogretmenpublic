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
let mediaRecorder = null;
let audioChunks = [];
let audioMediaStream = null;
let speechNetworkError = false;

const TEACHERS = {
  elif: {
    id: "elif",
    name: "Elif Öğretmen",
    gender: "female",
    role: "Sevecen & Güler Yüzlü Rehber",
    geminiVoice: "Aoede",
    icon: "sparkles",
    genderLabel: "Kız / Kadın Sesi",
    avatarImg: "/assets/elif_tutor/images/teachers/elif.svg?v=2",
    greeting: "Merhaba! Ben Elif Öğretmen. Ev ödevini birlikte neşeyle çözelim!"
  },
  ahmet: {
    id: "ahmet",
    name: "Ahmet Öğretmen",
    gender: "male",
    role: "Sakin & Açıklayıcı Matematik Rehberi",
    geminiVoice: "Fenrir",
    icon: "glasses",
    genderLabel: "Erkek Sesi",
    avatarImg: "/assets/elif_tutor/images/teachers/ahmet.svg?v=2",
    greeting: "Selam! Ben Ahmet Öğretmen. Sorularına adım adım ve sakin şekilde rehberlik edeceğim."
  },
  zeynep: {
    id: "zeynep",
    name: "Zeynep Öğretmen",
    gender: "female",
    role: "Enerjik & Motive Edici Sınav Koçu",
    geminiVoice: "Kore",
    icon: "zap",
    genderLabel: "Kız / Kadın Sesi",
    avatarImg: "/assets/elif_tutor/images/teachers/zeynep.svg?v=2",
    greeting: "Harika bir gün! Ben Zeynep Öğretmen. Bugün bu ödevleri ışık hızında bitireceğiz!"
  },
  can: {
    id: "can",
    name: "Can Öğretmen",
    gender: "male",
    role: "Eğlenceli & Pratik Çözüm Uzmanı",
    geminiVoice: "Puck",
    icon: "compass",
    genderLabel: "Erkek Sesi",
    avatarImg: "/assets/elif_tutor/images/teachers/can.svg?v=2",
    greeting: "Merhaba arkadaşım! Ben Can Öğretmen. En pratik yoldan çözmeye hazır mısın?"
  }
};

let currentTeacherId = localStorage.getItem("elif_active_teacher") || "elif";
let activeTeacher = TEACHERS[currentTeacherId] || TEACHERS.elif;

function refreshIcons(root = document) {
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    try {
      window.lucide.createIcons({ root: root || document });
    } catch (_) { }
  }
}

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
  try { data = await res.json(); } catch (_) { }
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
    el("pill-timer").innerHTML = '<i data-lucide="clock" class="icon-sm"></i> <span>Ödev Süresi: 00:00</span>';
    el("pill-grade").innerHTML = '<i data-lucide="award" class="icon-sm"></i> <span>Zaman Notu: —</span>';
    refreshIcons(el("pill-timer").parentElement);
    return;
  }
  timerBaseSeconds = Number(sheet.duration_seconds || 0);
  timerStartedMs = Date.now();
  el("pill-grade").innerHTML = `<i data-lucide="award" class="icon-sm"></i> <span>Zaman Notu: ${escapeHtml(sheet.time_grade || "Devam Ediyor")}</span>`;
  el("pill-tokens").innerHTML = `<i data-lucide="zap" class="icon-sm"></i> <span>Token: ${sheet.tokens_used || 0}</span>`;

  if (sheet.status === "completed") {
    el("pill-timer").innerHTML = `<i data-lucide="check-circle-2" class="icon-sm"></i> <span>Tamamlandı: ${formatDuration(timerBaseSeconds)}</span>`;
    refreshIcons(el("pill-timer").parentElement);
    return;
  }
  const tick = () => {
    const live = timerBaseSeconds + Math.floor((Date.now() - timerStartedMs) / 1000);
    el("pill-timer").innerHTML = `<i data-lucide="clock" class="icon-sm"></i> <span>Ödev Süresi: ${formatDuration(live)}</span>`;
    refreshIcons(el("pill-timer"));
  };
  tick();
  timerInterval = setInterval(tick, 1000);
  refreshIcons(el("pill-timer").parentElement);
}

function updateVoiceUI(state, statusText = "", highlightTurn = false) {
  fsmState = state;
  const btn = el("btn-voice-action");
  const cancelBtn = el("btn-voice-cancel");
  const txBox = el("voice-transcript-box");

  const labels = {
    IDLE: highlightTurn ? "Sıra sende! 'Sesli Cevap Ver' butonuna bas." : "Hazır",
    THINKING: "Elif Öğretmen düşünüyor...",
    SPEAKING: "Elif Öğretmen anlatıyor...",
    LISTENING: "Seni dinliyorum... Bitince 'Cevabı Gönder'e bas!",
  };
  el("voice-status").textContent = statusText || labels[state] || state;
  btn.classList.remove("btn-emerald", "btn-primary", "btn-danger", "btn-soft", "btn-pulse");

  if (state === "IDLE") {
    btn.disabled = false;
    btn.classList.add("btn-emerald");
    if (highlightTurn) btn.classList.add("btn-pulse");
    btn.innerHTML = '<i data-lucide="mic" class="icon-sm"></i> <span>Sesli Cevap Ver</span>';
    cancelBtn.classList.add("hidden");
    txBox.classList.add("hidden");
    txBox.textContent = "";
  } else if (state === "THINKING") {
    btn.disabled = true;
    btn.classList.add("btn-soft");
    btn.innerHTML = '<i data-lucide="loader-2" class="icon-sm spin"></i> <span>Elif Öğretmen Hazırlanıyor...</span>';
    cancelBtn.classList.add("hidden");
    txBox.classList.add("hidden");
  } else if (state === "SPEAKING") {
    btn.disabled = false;
    btn.classList.add("btn-soft");
    btn.innerHTML = '<i data-lucide="square" class="icon-sm"></i> <span>Anlatımı Durdur</span>';
    cancelBtn.classList.add("hidden");
    txBox.classList.add("hidden");
  } else if (state === "LISTENING") {
    btn.disabled = false;
    btn.classList.add("btn-primary");
    btn.innerHTML = '<i data-lucide="send" class="icon-sm"></i> <span>Cevabı Gönder</span>';
    cancelBtn.classList.remove("hidden");
    txBox.classList.remove("hidden");
    txBox.innerHTML = '<i data-lucide="mic" class="icon-sm"></i> <span>Konuşmaya başlayabilirsin...</span>';
  }

  const inlineMic = el("btn-chat-mic-inline");
  if (inlineMic) {
    if (state === "LISTENING") {
      inlineMic.classList.add("recording");
      inlineMic.innerHTML = '<i data-lucide="radio" class="icon-sm"></i> <span>Durdur</span>';
    } else {
      inlineMic.classList.remove("recording");
      inlineMic.innerHTML = '<i data-lucide="mic" class="icon-sm"></i> <span>Sesle Söyle</span>';
    }
    refreshIcons(inlineMic);
  }

  const overlay = el("teacher-portrait-overlay");
  if (overlay) {
    overlay.classList.toggle("speaking", state === "SPEAKING");
  }

  refreshIcons(btn.parentElement);
  refreshIcons(txBox);
}

function hardStopAllAudioAndMic() {
  speechEpoch += 1;
  if (ttsAbortCtrl) { try { ttsAbortCtrl.abort(); } catch (_) { } ttsAbortCtrl = null; }
  if (currentAudio) { try { currentAudio.pause(); currentAudio.src = ""; } catch (_) { } currentAudio = null; }
  if ("speechSynthesis" in window) { try { window.speechSynthesis.cancel(); } catch (_) { } }
  if (recognition) { try { recognition.onend = null; recognition.onerror = null; recognition.abort(); } catch (_) { } recognition = null; }
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch (_) { }
  }
  mediaRecorder = null;
  if (audioMediaStream) {
    try { audioMediaStream.getTracks().forEach((t) => t.stop()); } catch (_) { }
    audioMediaStream = null;
  }
  audioChunks = [];
  speechNetworkError = false;
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

  // Orijinal Kağıt Referans Görselini Güncelle
  const docImg = el("original-doc-img");
  const docEmpty = el("original-doc-empty");
  if (docImg && docEmpty) {
    if (sheet.image_data) {
      docImg.src = sheet.image_data;
      docImg.classList.remove("hidden");
      docEmpty.classList.add("hidden");
    } else {
      docImg.src = "";
      docImg.classList.add("hidden");
      docEmpty.classList.remove("hidden");
    }
  }

  const feed = el("chat-feed");
  feed.innerHTML = (sheet.messages || [])
    .map((m) => {
      const isTeacher = String(m.role || "").includes("Öğretmen");
      return `
      <div class="msg ${isTeacher ? "teacher" : "student"}">
        <div class="msg-header">
          <i data-lucide="${isTeacher ? "sparkles" : "user"}" class="icon-xs"></i>
          <span>${escapeHtml(m.role)}</span>
          ${m.time ? `<span class="muted" style="margin-left:auto;font-size:0.68rem;">${escapeHtml(m.time)}</span>` : ""}
        </div>
        <div class="msg-content">${escapeHtml(m.text)}</div>
      </div>`;
    })
    .join("");
  refreshIcons(feed);
  feed.scrollTop = feed.scrollHeight;

  const qs = sheet.questions || [];
  const solvedCount = qs.filter((q) => q.status === "solved").length;
  el("hw-count").textContent = `${solvedCount}/${qs.length} oldu`;
  const badges = {
    solved: '<span class="hw-status hw-solved"><i data-lucide="check" class="icon-xs"></i> Oldu</span>',
    in_progress: '<span class="hw-status hw-in_progress"><i data-lucide="clock" class="icon-xs"></i> Devam</span>',
    needs_retry: '<span class="hw-status hw-needs_retry"><i data-lucide="rotate-ccw" class="icon-xs"></i> Tekrar</span>',
    pending: '<span class="hw-status hw-pending"><i data-lucide="circle-dot" class="icon-xs"></i> Bekliyor</span>'
  };
  el("hw-list").innerHTML = qs
    .map(
      (q) => {
        const safeStatus = Object.prototype.hasOwnProperty.call(badges, q.status) ? q.status : "pending";
        return `
      <div class="bank-item ${q.question_no === sheet.active_question_no ? "sheet-item active" : ""}" onclick="openSheet('${escapeHtml(sheet.sheet_id)}', ${Number(q.question_no) || 1})">
        <div>
          ${badges[safeStatus]}
          <strong>Soru ${Number(q.question_no) || 1}</strong>
          <span class="muted">(${formatDurationTR(q.duration_seconds)})</span>
        </div>
        <div class="muted">${escapeHtml((q.question_text || "").slice(0, 68))}...</div>
      </div>`;
      }
    )
    .join("") || '<div class="muted">Ödev sayfası yüklendiğinde sorular burada görünür.</div>';
  refreshIcons(el("hw-list"));
}

async function deleteHomeworkSheet(sheetId) {
  if (!sheetId) return;
  try {
    await frappeCall("elif_tutor.api.delete_sheet", { sheet_id: sheetId });
    showToast("Ödev sayfası silindi.", "info");
    if (activeSheet && activeSheet.sheet_id === sheetId) {
      await startNewHomework();
    } else {
      await loadSheetsList();
    }
  } catch (e) {
    showToast("Ödev silinemedi: " + (e.message || "Bilinmeyen hata"), "error");
  }
}
window.deleteHomeworkSheet = deleteHomeworkSheet;

async function loadSheetsList() {
  const res = await frappeCall("elif_tutor.api.list_sheets", {});
  const sheets = res.sheets || [];
  el("sheets-count").textContent = `${sheets.length} sayfa`;
  el("sheets-list").innerHTML = sheets
    .map((sh) => {
      const done = sh.status === "completed";
      const activeCls = activeSheet && sh.sheet_id === activeSheet.sheet_id ? "active" : "";
      const statusBadge = done
        ? '<span class="hw-status hw-solved"><i data-lucide="check-check" class="icon-xs"></i> Bitti</span>'
        : '<span class="hw-status hw-in_progress"><i data-lucide="clock" class="icon-xs"></i> Devam</span>';
      return `
      <div class="bank-item sheet-item ${activeCls}" onclick="openSheet('${escapeHtml(sh.sheet_id)}')">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <div>
            ${statusBadge}
            <strong>${escapeHtml(sh.title)}</strong>
          </div>
          <button type="button" class="sheet-del-btn" title="Bu ödevi sil" onclick="event.stopPropagation(); deleteHomeworkSheet('${escapeHtml(sh.sheet_id)}')">
            <i data-lucide="trash-2" class="icon-xs"></i>
          </button>
        </div>
        <div class="muted">${sh.solved_questions}/${sh.total_questions} soru • <i data-lucide="clock" class="icon-xs"></i> ${formatDurationTR(sh.duration_seconds)}</div>
        <div class="muted" style="color:var(--emerald);font-weight:700;"><i data-lucide="award" class="icon-xs"></i> ${escapeHtml(sh.time_grade || "Devam Ediyor")}</div>
      </div>`;
    })
    .join("") || '<div class="muted">Henüz ödev sayfası yüklenmedi. Fotoğraf veya PDF yükleyerek başla!</div>';
  refreshIcons(el("sheets-list"));
}

async function openSheet(sheetId, questionNo = null) {
  hardStopAllAudioAndMic();
  const myEpoch = speechEpoch;
  updateVoiceUI("THINKING", "Ödev sayfası açılıyor...");
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
  const emoLabels = {
    happy: '<i data-lucide="smile" class="icon-xs"></i> <span>Mutlu</span>',
    thinking: '<i data-lucide="help-circle" class="icon-xs"></i> <span>Düşünüyor</span>',
    celebrate: '<i data-lucide="sparkles" class="icon-xs"></i> <span>Harikasın!</span>',
    encouraging: '<i data-lucide="thumbs-up" class="icon-xs"></i> <span>Destekliyor</span>'
  };
  el("avatar-emotion-pill").innerHTML = emoLabels[emotion] || '<i data-lucide="volume-2" class="icon-xs"></i> <span>Anlatıyor</span>';
  refreshIcons(el("avatar-emotion-pill"));
  if (avatar3D) avatar3D.setEmotion(emotion);

  let played = false;
  try {
    ttsAbortCtrl = new AbortController();
    const ttsRes = await frappeCall("elif_tutor.api.tts_audio", { text, voice: activeTeacher.geminiVoice }, false, ttsAbortCtrl.signal);
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
        let audioStarted = false;
        const cleanup = () => {
          URL.revokeObjectURL(url);
          if (currentAudio === audio) currentAudio = null;
          if (avatar3D) avatar3D.isSpeaking = false;
          resolve();
        };
        audio.onended = () => {
          played = true;
          cleanup();
        };
        audio.onerror = (err) => {
          console.warn("Audio element error:", err);
          played = false;
          cleanup();
        };
        const playPromise = audio.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              audioStarted = true;
              played = true;
            })
            .catch((err) => {
              console.warn("audio.play() rejected:", err);
              played = false;
              cleanup();
            });
        }
      });
    }
  } catch (e) {
    if (e.name === "AbortError" || myEpoch !== speechEpoch) return;
  }

  if (!played && myEpoch === speechEpoch && "speechSynthesis" in window) {
    await new Promise((resolve) => {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "tr-TR";

      const voices = window.speechSynthesis.getVoices() || [];
      const trVoices = voices.filter((v) => (v.lang || "").toLowerCase().startsWith("tr"));

      if (activeTeacher.gender === "female") {
        const femaleVoice = trVoices.find((v) => /google|female|emel|filiz|seda|ayşe|kadın|zeynep|elif/i.test(v.name));
        if (femaleVoice) {
          u.voice = femaleVoice;
          u.pitch = 1.25;
        } else {
          u.pitch = 1.45;
        }
        u.rate = 1.02;
      } else {
        const maleVoice = trVoices.find((v) => /male|tolga|erkek|cem/i.test(v.name));
        if (maleVoice) u.voice = maleVoice;
        u.pitch = 0.90;
        u.rate = 1.0;
      }

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
  el("avatar-emotion-pill").innerHTML = '<i data-lucide="message-square" class="icon-xs"></i> <span>Cevabını Bekliyor</span>';
  refreshIcons(el("avatar-emotion-pill"));
  updateVoiceUI("IDLE", "Sıra sende! Cevabını söylemek için 'Sesli Cevap Ver' butonuna bas.", true);
}

async function startManualListening() {
  hardStopAllAudioAndMic();
  const myEpoch = speechEpoch;
  activeFinalTranscript = "";
  activeInterimTranscript = "";
  speechNetworkError = false;
  audioChunks = [];

  updateVoiceUI("LISTENING");
  el("avatar-emotion-pill").innerHTML = '<i data-lucide="ear" class="icon-xs"></i> <span>Seni Dinliyor</span>';
  refreshIcons(el("avatar-emotion-pill"));

  // 1. Güvenilir Yerel Ses Kaydı (MediaRecorder)
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (myEpoch !== speechEpoch || fsmState !== "LISTENING") {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      audioMediaStream = stream;
      let options = {};
      if (typeof MediaRecorder !== "undefined") {
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
          options = { mimeType: "audio/webm;codecs=opus" };
        } else if (MediaRecorder.isTypeSupported("audio/webm")) {
          options = { mimeType: "audio/webm" };
        } else if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) {
          options = { mimeType: "audio/ogg;codecs=opus" };
        } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
          options = { mimeType: "audio/mp4" };
        }
        try {
          mediaRecorder = new MediaRecorder(stream, options);
          mediaRecorder.ondataavailable = (ev) => {
            if (ev.data && ev.data.size > 0) audioChunks.push(ev.data);
          };
          mediaRecorder.start(250);
        } catch (e) {
          console.warn("MediaRecorder start:", e);
        }
      }
    } catch (err) {
      console.warn("getUserMedia error:", err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        hardStopAllAudioAndMic();
        updateVoiceUI("IDLE", "Mikrofon izni verilmedi.", false);
        showToast("Tarayıcında mikrofon izni verilmedi. Lütfen adres çubuğundaki kilit simgesine tıklayıp mikrofona izin ver.", "warn", 6500);
        return;
      }
    }
  }

  // 2. Canlı Metin Dökümü (Web Speech API)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const launch = () => {
      if (myEpoch !== speechEpoch || fsmState !== "LISTENING" || speechNetworkError) return;
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
        el("voice-transcript-box").innerHTML = p
          ? `<i data-lucide="mic" class="icon-sm"></i> <span>"${escapeHtml(p)}"</span>`
          : '<i data-lucide="mic" class="icon-sm"></i> <span>Konuşmaya başlayabilirsin...</span>';
        refreshIcons(el("voice-transcript-box"));

        const input = el("chat-input");
        if (input && p) {
          input.value = p;
          input.style.height = "auto";
          const newH = Math.min(Math.max(input.scrollHeight, 58), 150);
          input.style.height = newH + "px";
        }
      };
      rec.onerror = (e) => {
        if (myEpoch !== speechEpoch || fsmState !== "LISTENING") return;
        console.warn("Speech recognition error:", e.error);
        if (e.error === "no-speech") return;
        if (e.error === "network") {
          speechNetworkError = true;
          el("voice-transcript-box").innerHTML = '<i data-lucide="mic" class="icon-sm"></i> <span>Konuşmanı dinliyorum (bitirince Gemini ile yazıya aktarılacak)...</span>';
          refreshIcons(el("voice-transcript-box"));
          return;
        }
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          hardStopAllAudioAndMic();
          updateVoiceUI("IDLE", "Mikrofon izni verilmedi.", false);
          showToast("Tarayıcında mikrofon izni verilmedi. Lütfen adres çubuğundaki kilit simgesine tıklayıp mikrofona izin ver.", "warn", 6500);
        }
      };
      rec.onend = () => {
        if (myEpoch === speechEpoch && fsmState === "LISTENING" && !speechNetworkError) {
          setTimeout(launch, 200);
        }
      };
      try { rec.start(); } catch (_) { }
    };
    launch();
  }
}

async function finishListeningAndProcess(autoSend = false) {
  const myEpoch = speechEpoch;
  const currentText = ((activeFinalTranscript + " " + activeInterimTranscript).trim() || (el("chat-input") ? el("chat-input").value.trim() : ""));

  // Eğer Web Speech API başarıyla metin topladıysa ve cloud network hatası almadıysa doğrudan kullan
  if (currentText && !speechNetworkError) {
    hardStopAllAudioAndMic();
    if (autoSend) {
      sendStudentMessage(currentText);
    } else {
      updateVoiceUI("IDLE", "Sesin metne dönüştürüldü.", false);
      const input = el("chat-input");
      if (input) input.focus();
    }
    return;
  }

  // Yerel MediaRecorder kaydını tamamla ve Gemini STT'ye gönder
  updateVoiceUI("THINKING", "Sesin yazıya dökülüyor (Gemini STT)...");
  el("avatar-emotion-pill").innerHTML = '<i data-lucide="sparkles" class="icon-xs"></i> <span>Sesini Çözümlüyor</span>';
  refreshIcons(el("avatar-emotion-pill"));

  const mr = mediaRecorder;
  const stream = audioMediaStream;
  if (recognition) {
    try { recognition.onend = null; recognition.onerror = null; recognition.abort(); } catch (_) { }
    recognition = null;
  }

  const getRecordedBlob = () => new Promise((resolve) => {
    if (!mr || mr.state === "inactive") {
      const mime = mr?.mimeType || "audio/webm";
      resolve(audioChunks.length ? new Blob(audioChunks, { type: mime }) : null);
      return;
    }
    mr.onstop = () => {
      const mime = mr.mimeType || "audio/webm";
      resolve(audioChunks.length ? new Blob(audioChunks, { type: mime }) : null);
    };
    try { mr.stop(); } catch (_) { resolve(null); }
  });

  const blob = await getRecordedBlob();
  if (stream) {
    try { stream.getTracks().forEach((t) => t.stop()); } catch (_) { }
    audioMediaStream = null;
  }
  mediaRecorder = null;

  if (!blob || blob.size < 600) {
    updateVoiceUI("IDLE", "Ses algılanamadı, lütfen mikrofona konuşup tekrar dene.", true);
    return;
  }

  try {
    const fd = new FormData();
    fd.append("file", blob, "kayit.webm");
    const data = await frappeCall("elif_tutor.api.stt_audio", fd, true);
    if (myEpoch !== speechEpoch) return;

    const transcribed = (data && (data.text || (data.message && data.message.text))) || "";
    if (transcribed && transcribed.trim()) {
      const clean = transcribed.trim();
      const input = el("chat-input");
      if (input) {
        input.value = clean;
        input.style.height = "auto";
        const newH = Math.min(Math.max(input.scrollHeight, 58), 150);
        input.style.height = newH + "px";
        input.focus();
      }
      showToast("Sesin başarıyla yazıya aktarıldı!", "info", 2500);
      if (autoSend) {
        sendStudentMessage(clean);
      } else {
        updateVoiceUI("IDLE", "Cevabın hazır. Göndermek için Gönder butonuna basabilirsin.", false);
      }
    } else {
      updateVoiceUI("IDLE", "Konuştuğun tam anlaşılamadı. Tekrar deneyebilir veya klavyeden yazabilirsin.", true);
    }
  } catch (err) {
    console.error("STT error:", err);
    updateVoiceUI("IDLE", "Ses çözümlenirken bir sorun oluştu, lütfen tekrar dene.", true);
  }
}

function submitManualListening() {
  finishListeningAndProcess(true);
}

function cancelManualListening() {
  hardStopAllAudioAndMic();
  updateVoiceUI("IDLE", "Kayıt iptal edildi.", true);
}

let attachedFile = null;
let attachedFileUrl = null;

function setAttachedFile(file) {
  if (!file) return;
  const allowedExts = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".avif", ".jfif", ".heic"];
  const fileName = (file.name || "").toLowerCase();
  const isAllowed = allowedExts.some(ext => fileName.endsWith(ext)) || (file.type && (file.type.startsWith("image/") || file.type === "application/pdf"));
  if (!isAllowed) {
    showToast("Lütfen desteklenen bir dosya formatı seçin (PDF, PNG, JPG, JPEG, WEBP, AVIF, JFIF).", "warn", 4500);
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    showToast("Dosya boyutu 25 MB'tan küçük olmalıdır.", "warn");
    return;
  }

  if (attachedFileUrl) {
    URL.revokeObjectURL(attachedFileUrl);
    attachedFileUrl = null;
  }

  attachedFile = file;
  const previewWrap = el("chat-attachment-preview");
  const thumb = el("attachment-thumb");
  const iconWrap = el("attachment-icon-wrap");
  const nameEl = el("attachment-name");
  const sizeEl = el("attachment-size");

  if (nameEl) nameEl.textContent = file.name || "Dosya";
  if (sizeEl) {
    const kb = Math.round(file.size / 1024);
    sizeEl.textContent = kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
  }

  const isImg = (file.type && file.type.startsWith("image/")) || /\.(png|jpe?g|webp|avif|jfif)$/i.test(fileName);
  if (isImg) {
    try {
      attachedFileUrl = URL.createObjectURL(file);
      if (thumb) {
        thumb.src = attachedFileUrl;
        thumb.classList.remove("hidden");
      }
      if (iconWrap) iconWrap.classList.add("hidden");
    } catch (_) { }
  } else {
    if (thumb) {
      thumb.src = "";
      thumb.classList.add("hidden");
    }
    if (iconWrap) {
      iconWrap.innerHTML = '<i data-lucide="file-text" class="icon-xs"></i>';
      iconWrap.classList.remove("hidden");
      refreshIcons(iconWrap);
    }
  }

  if (previewWrap) {
    previewWrap.classList.remove("hidden");
    refreshIcons(previewWrap);
  }
}

function clearAttachedFile() {
  if (attachedFileUrl) {
    URL.revokeObjectURL(attachedFileUrl);
    attachedFileUrl = null;
  }
  attachedFile = null;
  const previewWrap = el("chat-attachment-preview");
  if (previewWrap) previewWrap.classList.add("hidden");
  const fileInput = el("input-chat-file");
  if (fileInput) fileInput.value = "";
}

async function startNewHomework() {
  hardStopAllAudioAndMic();
  activeSheet = null;
  syncSheetTimer(null);

  const docImg = el("original-doc-img");
  const docEmpty = el("original-doc-empty");
  if (docImg && docEmpty) {
    docImg.src = "";
    docImg.classList.add("hidden");
    docEmpty.classList.remove("hidden");
  }

  renderWhiteboard({
    title: "Ev Ödevi Akıllı Tahtası",
    latex: "",
    svg: "",
    steps: [
      "Yeni bir soru veya ödev başlatmaya hazırsın!",
      "Aşağıdan sorunu doğrudan yazabilir, dosya/fotoğraf ekleyebilir veya sesinle sorabilirsin."
    ]
  });

  el("hw-count").textContent = "0/0 oldu";
  el("hw-list").innerHTML = '<div class="muted">Yeni bir ödev yüklediğinde veya soru sorduğunda sorular burada görünür.</div>';

  clearAttachedFile();

  const input = el("chat-input");
  if (input) {
    input.value = "";
    input.style.height = "auto";
  }

  const feed = el("chat-feed");
  if (feed) {
    feed.innerHTML = `
      <div class="msg teacher">
        <div class="msg-header">
          <i data-lucide="sparkles" class="icon-xs"></i>
          <span>${escapeHtml(activeTeacher.name)}</span>
          <span class="muted" style="margin-left:auto;font-size:0.68rem;">Şimdi</span>
        </div>
        <div class="msg-content">
          Harika! Yeni bir ödeve veya soruya başlamak için hazırım. Ne üzerinde çalışmak istersin? İster sorunu doğrudan yaz, ister dosya ekle, adım adım birlikte çözelim!
        </div>
      </div>
    `;
    refreshIcons(feed);
  }

  await loadSheetsList();
  updateVoiceUI("IDLE", "Yeni ödev oturumu hazır. Sorunu yazabilir veya sesle sorabilirsin.", true);
  await speakTeacherAndWaitButton(
    `Yeni bir ödeve başlamak için hazırım! İster sorunu yaz, ister kağıt fotoğrafı yükle, birlikte çözelim!`,
    "happy"
  );
}
window.startNewHomework = startNewHomework;

async function sendStudentMessage(text) {
  const cleanTxt = (text || "").trim();

  // 1. Ekli dosya varsa (fotoğraf veya PDF), doğrudan ödev sayfası olarak yükle
  if (attachedFile) {
    const fileToSend = attachedFile;
    clearAttachedFile();
    await sendSnapshotBlob(fileToSend, cleanTxt, fileToSend.name || "odev_ek.png");
    return;
  }

  if (!cleanTxt) return;

  hardStopAllAudioAndMic();
  const myEpoch = speechEpoch;

  // 2. Aktif ödev yoksa ve öğrenci doğrudan bir soru yazdıysa: Freeform Soru Modu (Otonom Ödev Oluşturma)
  if (!activeSheet) {
    const feed = el("chat-feed");
    if (feed) {
      const studentBubble = document.createElement("div");
      studentBubble.className = "msg student";
      studentBubble.innerHTML = `
        <div class="msg-header">
          <i data-lucide="user" class="icon-xs"></i>
          <span>Sen</span>
          <span class="muted" style="margin-left:auto;font-size:0.68rem;">Şimdi</span>
        </div>
        <div class="msg-content">${escapeHtml(cleanTxt)}</div>
      `;
      feed.appendChild(studentBubble);
      refreshIcons(studentBubble);
      feed.scrollTop = feed.scrollHeight;
    }

    updateVoiceUI("THINKING", "Sorun inceleniyor ve tahtaya hazırlanıyor...");
    el("avatar-emotion-pill").innerHTML = '<i data-lucide="brain" class="icon-xs"></i> <span>Sorunu İnceliyor</span>';
    refreshIcons(el("avatar-emotion-pill"));
    if (avatar3D) avatar3D.setEmotion("thinking");

    try {
      const data = await frappeCall("elif_tutor.api.start_freeform_homework", {
        question_text: cleanTxt,
        subject: currentSubject,
        teacher_name: activeTeacher.name,
        teacher_gender: activeTeacher.gender,
        student_name: (window.FRAPPE_USER || "").trim()
      });
      if (myEpoch !== speechEpoch) return;
      if (data.sheet) renderActiveSheet(data.sheet);
      else if (data.whiteboard) renderWhiteboard(data.whiteboard);
      await loadSheetsList();
      await speakTeacherAndWaitButton(data.spoken_text, data.emotion || "happy");
    } catch (e) {
      updateVoiceUI("IDLE", "Soru başlatılamadı, tekrar dene.", true);
      showToast("Hata: " + (e.message || "Soru işlenirken sorun oluştu"), "error");
    }
    return;
  }

  // 3. Aktif ödev varsa: Normal Sokratik sohbet turu
  const feed = el("chat-feed");
  if (feed) {
    const studentBubble = document.createElement("div");
    studentBubble.className = "msg student";
    studentBubble.innerHTML = `
      <div class="msg-header">
        <i data-lucide="user" class="icon-xs"></i>
        <span>Sen</span>
        <span class="muted" style="margin-left:auto;font-size:0.68rem;">Şimdi</span>
      </div>
      <div class="msg-content">${escapeHtml(cleanTxt)}</div>
    `;
    feed.appendChild(studentBubble);
    refreshIcons(studentBubble);
    feed.scrollTop = feed.scrollHeight;
  }

  updateVoiceUI("THINKING");
  el("avatar-emotion-pill").innerHTML = '<i data-lucide="brain" class="icon-xs"></i> <span>Cevabını İnceliyor</span>';
  refreshIcons(el("avatar-emotion-pill"));
  if (avatar3D) avatar3D.setEmotion("thinking");

  try {
    const data = await frappeCall("elif_tutor.api.chat_turn", {
      sheet_id: activeSheet.sheet_id,
      text: cleanTxt,
      teacher_name: activeTeacher.name,
      teacher_gender: activeTeacher.gender,
      student_name: (window.FRAPPE_USER || "").trim(),
    });
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
  updateVoiceUI("THINKING", "Ödev sayfası okunuyor ve kaydediliyor...");
  el("avatar-emotion-pill").innerHTML = '<i data-lucide="scan" class="icon-xs"></i> <span>Ödev Sayfasını Okuyor</span>';
  refreshIcons(el("avatar-emotion-pill"));
  if (avatar3D) avatar3D.setEmotion("thinking");

  const fd = new FormData();
  fd.append("file", blob, filename);
  fd.append("subject", currentSubject);
  fd.append("note", note);
  fd.append("student_name", (window.FRAPPE_USER || "").trim());

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
    el("btn-toggle-cam").innerHTML = '<i data-lucide="camera" class="icon-sm"></i> <span>Defter Kamerasını Aç</span>';
    refreshIcons(el("btn-toggle-cam"));
    return;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
    el("cam-video").srcObject = camStream;
    el("cam-video").classList.remove("hidden");
    el("btn-snap-cam").disabled = false;
    el("btn-toggle-cam").innerHTML = '<i data-lucide="video-off" class="icon-sm"></i> <span>Kamerayı Kapat</span>';
    refreshIcons(el("btn-toggle-cam"));
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
                  <i data-lucide="${s.status === "completed" ? "check-check" : "clock"}" class="icon-xs"></i>
                  <span>${s.status === "completed" ? "Bitti" : "Devam"}</span>
                </span>
                <strong>${escapeHtml(s.title)}</strong>
              </div>
              <div class="muted">
                ${escapeHtml((s.started_at || "").slice(0, 16))} • ${s.solved_questions}/${s.total_questions} soru • <i data-lucide="clock" class="icon-xs"></i> ${formatDurationTR(s.duration_seconds)}
              </div>
              <div style="font-size:0.76rem;font-weight:700;color:var(--emerald);margin-top:2px;">
                <i data-lucide="award" class="icon-xs"></i> <span>${escapeHtml(s.time_grade || "Devam Ediyor")}</span>
              </div>
            </div>
            <button class="btn btn-outline" onclick="closeModal(); openSheet('${escapeHtml(s.sheet_id)}')">Aç</button>
          </div>`
        )
        .join("")
      : '<p class="muted">Henüz kaydedilmiş bir ödev sayfası yok.</p>';

    const rawMem = res.memories || [];
    const memories = Array.isArray(rawMem) ? rawMem : (rawMem.academic || []);
    const autoProfile = Array.isArray(rawMem) ? [] : (rawMem.autonomous_profile || []);

    const memBadges = {
      mastered: { cls: "hw-solved", icon: "sparkles", txt: "Pekiştirdi" },
      needs_review: { cls: "hw-needs_retry", icon: "alert-triangle", txt: "Tekrar Gerekli" },
      learning: { cls: "hw-in_progress", icon: "book-open", txt: "Öğreniyor" },
    };
    const memHtml = memories.length
      ? `<div style="margin-top:8px;font-weight:800;color:var(--brand-blue);display:flex;align-items:center;gap:6px;"><i data-lucide="brain" class="icon-sm"></i> Uzun Dönem Öğrenme Hafızası (Dersler Arası)</div>` +
      memories
        .map((m) => {
          const b = memBadges[m.mastery_status] || memBadges.learning;
          return `
            <div class="report-row" style="flex-direction:column;align-items:flex-start;gap:4px;">
              <div>
                <span class="hw-status ${b.cls}"><i data-lucide="${b.icon}" class="icon-xs"></i> <span>${b.txt}</span></span>
                <strong>${escapeHtml(m.subject)} — ${escapeHtml(m.topic)}</strong>
                <span class="muted">(${m.solved_count} doğru • ${m.mistake_count} takılma)</span>
              </div>
              ${m.struggle_notes ? `<div class="muted" style="color:var(--amber);">Takıldığı: ${escapeHtml(m.struggle_notes.replace(/\n/g, " | "))}</div>` : ""}
              ${m.strength_notes ? `<div class="muted" style="color:var(--emerald);">Güçlü: ${escapeHtml(m.strength_notes.replace(/\n/g, " | "))}</div>` : ""}
            </div>`;
        })
        .join("")
      : "";

    const profileHtml = autoProfile.length
      ? `<div style="margin-top:14px;font-weight:800;color:var(--brand-blue);display:flex;align-items:center;gap:6px;"><i data-lucide="sparkles" class="icon-sm"></i> Öğretmenin Otonom Gözlem & Profil Hafızası</div>` +
      autoProfile
        .map((item) => `
          <div class="report-row" style="flex-direction:column;align-items:flex-start;gap:4px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="hw-status hw-solved" style="text-transform:uppercase;"><i data-lucide="tag" class="icon-xs"></i> <span>${escapeHtml(item.category || "Profil")}</span></span>
              <strong style="color:var(--brand-blue-deep);">${escapeHtml(item.key)}</strong>
            </div>
            <div style="font-size:0.8rem;color:var(--ink-primary);">${escapeHtml(item.value)}</div>
            ${item.reason ? `<div class="muted" style="font-size:0.72rem;">Gerekçe: ${escapeHtml(item.reason)}</div>` : ""}
          </div>`)
        .join("")
      : "";

    showModal(
      "Ödev Geçmişi & Zaman Notları",
      `<div class="report-kpi-row">
        <div class="report-kpi"><strong>${completed}/${sheets.length}</strong><span class="muted">Tamamlanan Ödev</span></div>
        <div class="report-kpi"><strong>${formatDurationTR(totalSec)}</strong><span class="muted">Toplam Süre</span></div>
        <div class="report-kpi"><strong>${avgScore ? avgScore + "/100" : "—"}</strong><span class="muted">Ortalama Zaman Puanı</span></div>
      </div>
      ${rowsHtml}
      ${memHtml}
      ${profileHtml}`
    );
    refreshIcons(el("app-modal-body"));
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
  el("btn-toggle-pen").innerHTML = on
    ? '<i data-lucide="pen-tool" class="icon-sm"></i> <span>Kalemi Kapat</span>'
    : '<i data-lucide="pen-tool" class="icon-sm"></i> <span>Kalemi Aç</span>';
  refreshIcons(el("btn-toggle-pen"));
  const badge = el("pen-active-badge");
  if (badge) {
    badge.classList.toggle("hidden", !on);
    refreshIcons(badge);
  }
};
el("btn-clear-pen").onclick = () => window.clearStudentCanvas && window.clearStudentCanvas();
const btnUndo = el("btn-undo-pen");
if (btnUndo) btnUndo.onclick = () => window.undoStudentPen && window.undoStudentPen();
const btnRedo = el("btn-redo-pen");
if (btnRedo) btnRedo.onclick = () => window.redoStudentPen && window.redoStudentPen();

// Orijinal Kağıt Referans Paneli (Split View) Kontrolleri
const btnToggleDoc = el("btn-toggle-doc");
const btnCloseDoc = el("btn-close-doc");
const docDrawer = el("original-doc-drawer");

if (btnToggleDoc && docDrawer) {
  btnToggleDoc.onclick = () => {
    const isHidden = docDrawer.classList.toggle("hidden");
    btnToggleDoc.innerHTML = isHidden
      ? '<i data-lucide="file-text" class="icon-sm"></i> <span>Orijinal Kağıt</span>'
      : '<i data-lucide="file-x" class="icon-sm"></i> <span>Kağıdı Gizle</span>';
    refreshIcons(btnToggleDoc);
  };
}
if (btnCloseDoc && docDrawer && btnToggleDoc) {
  btnCloseDoc.onclick = () => {
    docDrawer.classList.add("hidden");
    btnToggleDoc.innerHTML = '<i data-lucide="file-text" class="icon-sm"></i> <span>Orijinal Kağıt</span>';
    refreshIcons(btnToggleDoc);
  };
}

// Hızlı Cevap Çipleri (Quick Reply Chips)
const chipsWrap = el("quick-reply-chips");
if (chipsWrap) {
  chipsWrap.onclick = async (e) => {
    const btn = e.target.closest(".quick-chip-btn");
    if (!btn) return;
    const replyText = btn.getAttribute("data-reply");
    if (replyText) {
      const input = el("chat-input");
      if (input) {
        input.value = replyText;
        input.style.height = "auto";
      }
      await sendStudentMessage(replyText);
      if (input) input.value = "";
    }
  };
}

// Çok Satırlı Ergonomik Metin Girişi ve Klavye Kısayolları
const chatInput = el("chat-input");
if (chatInput) {
  chatInput.addEventListener("input", function () {
    this.style.height = "auto";
    const newH = Math.min(Math.max(this.scrollHeight, 58), 150);
    this.style.height = newH + "px";
  });

  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      el("chat-form").dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });
}

// Satır içi mikrofon butonu (Bas-Konuş / Durdur & Textarea Entegrasyonu)
const btnInlineMic = el("btn-chat-mic-inline");
if (btnInlineMic) {
  btnInlineMic.onclick = () => {
    if (fsmState === "LISTENING") {
      finishListeningAndProcess(false);
    } else {
      startManualListening();
    }
  };
}

// Dosya Eki Butonu ve Dosya Seçimi
const btnChatAttach = el("btn-chat-attach");
const inputChatFile = el("input-chat-file");
if (btnChatAttach && inputChatFile) {
  btnChatAttach.onclick = () => inputChatFile.click();
  inputChatFile.onchange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setAttachedFile(e.target.files[0]);
    }
  };
}
const btnRemoveAttach = el("btn-remove-attachment");
if (btnRemoveAttach) {
  btnRemoveAttach.onclick = clearAttachedFile;
}

// Yeni Ödev Başlat Butonu
const btnNewHw = el("btn-new-homework");
if (btnNewHw) {
  btnNewHw.onclick = startNewHomework;
}

// Sürükle & Bırak (Drag & Drop) ve Pano Yapıştırma (Ctrl+V)
const promptCard = document.querySelector(".chat-prompt-card");
if (promptCard) {
  ["dragenter", "dragover"].forEach((evtName) => {
    promptCard.addEventListener(evtName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      promptCard.classList.add("drag-over");
    });
  });
  ["dragleave", "drop"].forEach((evtName) => {
    promptCard.addEventListener(evtName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      promptCard.classList.remove("drag-over");
    });
  });
  promptCard.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
      setAttachedFile(e.dataTransfer.files[0]);
    }
  });
}

if (chatInput) {
  chatInput.addEventListener("paste", (e) => {
    const items = (e.clipboardData || window.clipboardData)?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === "file") {
          const blob = items[i].getAsFile();
          if (blob) {
            setAttachedFile(blob);
            break;
          }
        }
      }
    }
  });
}

el("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  const input = el("chat-input");
  const txt = (input ? input.value : "").trim();
  if (input) {
    input.value = "";
    input.style.height = "auto";
  }
  await sendStudentMessage(txt);
};

function updateTeacherUI() {
  const titleEl = el("teacher-display-name");
  if (titleEl) {
    titleEl.innerHTML = `<i data-lucide="${activeTeacher.icon}" class="icon-head"></i> <span>${escapeHtml(activeTeacher.name)}</span>`;
    refreshIcons(titleEl);
  }
  const overlay = el("teacher-portrait-overlay");
  const pImg = el("teacher-portrait-img");
  if (overlay && pImg) {
    if (activeTeacher.id === "elif") {
      overlay.classList.add("hidden");
    } else {
      pImg.src = activeTeacher.avatarImg;
      pImg.alt = activeTeacher.name;
      overlay.classList.remove("hidden");
    }
  }
}

function openTeacherModal() {
  const cardsHtml = Object.values(TEACHERS).map((t) => {
    const isActive = t.id === activeTeacher.id;
    return `
      <div class="teacher-card ${isActive ? 'active' : ''}" onclick="selectTeacher('${t.id}')">
        <div style="display:flex;align-items:center;gap:12px;">
          <img src="${t.avatarImg}" alt="${escapeHtml(t.name)}" class="teacher-card-avatar" />
          <div style="flex:1;min-width:0;">
            <div class="teacher-card-head">
              <strong style="color:var(--brand-blue-deep);font-size:0.92rem;">${escapeHtml(t.name)}</strong>
              <span class="teacher-gender-badge ${t.gender}">${escapeHtml(t.genderLabel)}</span>
            </div>
            <div style="font-size:0.75rem;color:var(--ink-secondary);margin-top:2px;">${escapeHtml(t.role)}</div>
          </div>
        </div>
        <div style="margin-top:auto;padding-top:6px;border-top:1px dashed rgba(74,14,46,0.12);font-size:0.72rem;color:var(--brand-blue);font-weight:700;display:flex;align-items:center;justify-content:space-between;">
          <span>${isActive ? '<i data-lucide="check-circle-2" class="icon-xs"></i> Aktif Rehber' : 'Seçmek İçin Tıkla →'}</span>
          <span class="muted" style="font-size:0.68rem;">${t.gender === 'female' ? 'Kız Öğretmen' : 'Erkek Öğretmen'}</span>
        </div>
      </div>
    `;
  }).join("");

  showModal(
    "Öğretmenini ve Sesini Seç",
    `<div style="font-size:0.84rem;color:var(--ink-muted);margin-bottom:8px;">
       Ders çalışırken sana eşlik edecek sanal öğretmenini ve ses tonunu seçebilirsin:
     </div>
     <div class="teacher-grid">${cardsHtml}</div>`
  );
  refreshIcons(el("app-modal-body"));
}

window.selectTeacher = async function (teacherId) {
  if (!TEACHERS[teacherId]) return;
  activeTeacher = TEACHERS[teacherId];
  localStorage.setItem("elif_active_teacher", teacherId);
  updateTeacherUI();
  closeModal();
  showToast(`${activeTeacher.name} (${activeTeacher.genderLabel}) seçildi!`, "success");
  await speakTeacherAndWaitButton(activeTeacher.greeting, "celebrate");
};

const btnOpenTeacher = el("btn-open-teacher-modal");
if (btnOpenTeacher) {
  btnOpenTeacher.onclick = openTeacherModal;
}

async function initOdevApp() {
  updateTeacherUI();
  refreshIcons();
  avatar3D = new TeacherAvatar3D("avatar-3d-container");
  initStudentPen();
  renderSubjectChips();
  await loadSheetsList();
  updateVoiceUI("IDLE");
  refreshIcons();
}

initOdevApp();
