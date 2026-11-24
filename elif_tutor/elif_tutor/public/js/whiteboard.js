/**
 * İnteraktif Akıllı Tahta Motoru:
 * - KaTeX Matematik Render
 * - Adım Adım SVG Çizimleri (Kesir Çubuğu, Üçgen, Dikdörtgen, Sayı Doğrusu, Güneş-Dünya-Ay, Elektrik Devresi, İngilizce Kart, Kavram Haritası)
 * - Öğrenci Serbest Çizim Kalemi (HTML5 Canvas)
 */
function renderWhiteboard(wb) {
  if (!wb) return;
  const titleEl = document.getElementById("wb-title");
  const stepsEl = document.getElementById("wb-steps");
  const latexEl = document.getElementById("wb-latex");
  const svgEl = document.getElementById("wb-svg");

  titleEl.textContent = wb.title || "Akıllı Ders Tahtası";
  const steps = wb.steps || [];
  stepsEl.innerHTML = steps
    .map((s, i) => `<div class="board-step"><strong>Adım ${i + 1}:</strong> ${escapeHtml(s)}</div>`)
    .join("");

  if (wb.latex && wb.latex.trim()) {
    latexEl.classList.remove("hidden");
    try {
      if (typeof katex !== "undefined") {
        katex.render(wb.latex, latexEl, { throwOnError: false, displayMode: true });
      } else {
        latexEl.textContent = wb.latex;
      }
    } catch (_) {
      latexEl.textContent = wb.latex;
    }
  } else {
    latexEl.classList.add("hidden");
  }

  const draw = wb.drawing || { type: "none", params: {} };
  svgEl.innerHTML = buildDrawingSVG(draw.type, draw.params || {});
}

function buildDrawingSVG(type, p) {
  if (!type || type === "none") return "";

  if (type === "fraction_bar") {
    const fracs = (Array.isArray(p.fractions) && p.fractions.length)
      ? p.fractions.slice(0, 6)
      : [{ num: 2, den: 3, label: "2/3" }];
    let rows = "";
    fracs.forEach((f, rIdx) => {
      const den = Math.min(24, Math.max(1, Math.floor(Number(f.den) || 4)));
      const num = Math.max(0, Math.min(den, Math.floor(Number(f.num) || 1)));
      const y = 20 + rIdx * 62;
      const cellW = 280 / den;
      rows += `<text x="10" y="${y + 24}" font-size="14" font-weight="700" fill="#035488">${escapeHtml(f.label || `${num}/${den}`)}</text>`;
      for (let i = 0; i < den; i++) {
        const fill = i < num ? "#0575bc" : "#eaf4fc";
        rows += `<rect x="${95 + i * cellW}" y="${y}" width="${cellW - 3}" height="34" rx="6" fill="${fill}" stroke="#035488" stroke-width="1.5"/>`;
      }
    });
    return `<svg width="410" height="${Math.max(90, fracs.length * 68 + 20)}" viewBox="0 0 410 ${Math.max(90, fracs.length * 68 + 20)}">${rows}</svg>`;
  }

  if (type === "geometry_triangle") {
    const ang = p.angles || ["60°", "50°", "?"];
    return `
      <svg width="360" height="190" viewBox="0 0 360 190">
        <polygon points="180,22 65,155 295,155" fill="#eaf4fc" stroke="#0575bc" stroke-width="3"/>
        <text x="170" y="54" font-size="14" font-weight="700" fill="#dc2626">${escapeHtml(ang[2] || "?")}</text>
        <text x="86" y="146" font-size="14" font-weight="700" fill="#035488">${escapeHtml(ang[0] || "60°")}</text>
        <text x="242" y="146" font-size="14" font-weight="700" fill="#035488">${escapeHtml(ang[1] || "50°")}</text>
        <text x="180" y="180" text-anchor="middle" font-size="13" fill="#475569">${escapeHtml(p.note || "Üçgenin iç açıları toplamı = 180°")}</text>
      </svg>`;
  }

  if (type === "geometry_rectangle") {
    return `
      <svg width="360" height="180" viewBox="0 0 360 180">
        <rect x="85" y="34" width="190" height="100" rx="6" fill="#eaf4fc" stroke="#0575bc" stroke-width="3"/>
        <text x="180" y="24" text-anchor="middle" font-size="14" font-weight="700" fill="#035488">${escapeHtml(p.width || "Uzun Kenar")}</text>
        <text x="285" y="88" font-size="14" font-weight="700" fill="#035488">${escapeHtml(p.height || "Kısa Kenar")}</text>
        <text x="180" y="162" text-anchor="middle" font-size="13" fill="#059669" font-weight="700">${escapeHtml(p.note || "Alan = Kısa × Uzun")}</text>
      </svg>`;
  }

  if (type === "solar_system") {
    return `
      <svg width="420" height="165" viewBox="0 0 420 165">
        <circle cx="70" cy="80" r="38" fill="#fbbf24" stroke="#d97706" stroke-width="3"/>
        <text x="70" y="85" text-anchor="middle" font-size="12" font-weight="700" fill="#78350f">GÜNEŞ</text>
        <circle cx="245" cy="80" r="24" fill="#3b82f6" stroke="#1d4ed8" stroke-width="2.5"/>
        <text x="245" y="84" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">DÜNYA</text>
        <circle cx="245" cy="80" r="56" fill="none" stroke="#94a3b8" stroke-dasharray="4 4"/>
        <circle cx="301" cy="80" r="11" fill="#e2e8f0" stroke="#475569" stroke-width="2"/>
        <text x="330" y="84" font-size="12" font-weight="700" fill="#334155">AY</text>
        <text x="210" y="155" text-anchor="middle" font-size="12" fill="#475569">${escapeHtml(p.note || "Ay kendi ışığını üretmez, Güneş ışığını yansıtır")}</text>
      </svg>`;
  }

  if (type === "electric_circuit") {
    const closed = p.switch_closed !== false;
    return `
      <svg width="380" height="170" viewBox="0 0 380 170">
        <rect x="65" y="32" width="250" height="96" rx="14" fill="none" stroke="#0575bc" stroke-width="3"/>
        <rect x="48" y="62" width="34" height="36" rx="6" fill="#fde68a" stroke="#d97706" stroke-width="2"/>
        <text x="65" y="85" text-anchor="middle" font-size="11" font-weight="700">PİL×${Number(p.batteries) || 1}</text>
        <circle cx="315" cy="80" r="20" fill="${closed ? "#fef08a" : "#e2e8f0"}" stroke="#ca8a04" stroke-width="2.5"/>
        <text x="315" y="84" text-anchor="middle" font-size="11" font-weight="700">💡</text>
        <text x="190" y="154" text-anchor="middle" font-size="12" font-weight="700" fill="#035488">${escapeHtml(p.note || (closed ? "Anahtar Kapalı → Ampul Yanar" : "Anahtar Açık → Ampul Söner"))}</text>
      </svg>`;
  }

  if (type === "english_card") {
    return `
      <div style="width:100%;max-width:440px;background:#f5f3ff;border:2px solid #8b5cf6;border-radius:16px;padding:14px;text-align:center;">
        <div style="font-size:1.05rem;font-weight:800;color:#4c1d95;">🇬🇧 ${escapeHtml(p.en || "")}</div>
        <div style="font-size:0.88rem;color:#475569;margin-top:6px;">🇹🇷 ${escapeHtml(p.tr || "")}</div>
        ${p.rule ? `<div style="margin-top:8px;font-size:0.78rem;background:#ede9fe;color:#5b21b6;padding:5px 10px;border-radius:999px;display:inline-block;font-weight:700;">💡 ${escapeHtml(p.rule)}</div>` : ""}
      </div>`;
  }

  if (type === "concept_map") {
    const branches = p.branches || [];
    return `
      <div style="display:flex;flex-direction:column;align-items:center;gap:10px;width:100%;">
        <div style="background:#0575bc;color:#fff;padding:8px 18px;border-radius:999px;font-weight:700;font-size:0.9rem;">${escapeHtml(p.center || "Kavram")}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;">
          ${branches.map((b) => `<span style="background:#eaf4fc;color:#035488;padding:6px 12px;border-radius:12px;font-size:0.8rem;font-weight:600;border:1px solid rgba(5,117,188,0.25);">${escapeHtml(b)}</span>`).join("")}
        </div>
      </div>`;
  }

  return "";
}

// Öğrenci serbest çizim kalemi
function initStudentPen() {
  const canvas = document.getElementById("student-draw-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let painting = false;

  const resize = () => {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
  };
  resize();
  window.addEventListener("resize", resize);

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const pt = e.touches ? e.touches[0] : e;
    return { x: pt.clientX - r.left, y: pt.clientY - r.top };
  };

  const start = (e) => {
    painting = true;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e) => {
    if (!painting) return;
    const { x, y } = pos(e);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#dc2626";
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const stop = () => { painting = false; };

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", stop);
  canvas.addEventListener("touchstart", start, { passive: true });
  canvas.addEventListener("touchmove", move, { passive: true });
  window.addEventListener("touchend", stop);

  window.clearStudentCanvas = () => ctx.clearRect(0, 0, canvas.width, canvas.height);
}
