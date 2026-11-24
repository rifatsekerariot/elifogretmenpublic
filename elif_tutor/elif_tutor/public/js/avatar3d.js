/**
 * 3D Konuşan Öğretmen (Three.js GLB + Türkçe Fonetik Viseme Dudak Senkronu)
 * Konuşma sırasında jawOpen/mouthOpen 0 tutulur; yalnızca aktif Oculus visemi oynatılır.
 */

const TR_VISEME_MAP = {
  a: { v: "viseme_aa", w: 0.24, d: 1.2 },
  e: { v: "viseme_E",  w: 0.24, d: 1.1 },
  i: { v: "viseme_I",  w: 0.22, d: 1.0 },
  "ı": { v: "viseme_I", w: 0.20, d: 1.0 },
  o: { v: "viseme_O",  w: 0.26, d: 1.2 },
  "ö": { v: "viseme_O", w: 0.22, d: 1.1 },
  u: { v: "viseme_U",  w: 0.26, d: 1.1 },
  "ü": { v: "viseme_U", w: 0.22, d: 1.1 },
  p: { v: "viseme_PP", w: 0.55, d: 0.7 },
  b: { v: "viseme_PP", w: 0.52, d: 0.7 },
  m: { v: "viseme_PP", w: 0.55, d: 0.8 },
  f: { v: "viseme_FF", w: 0.45, d: 0.8 },
  v: { v: "viseme_FF", w: 0.40, d: 0.8 },
  s: { v: "viseme_SS", w: 0.22, d: 0.8 },
  "ş": { v: "viseme_CH", w: 0.24, d: 0.8 },
  z: { v: "viseme_SS", w: 0.20, d: 0.8 },
  c: { v: "viseme_CH", w: 0.22, d: 0.8 },
  "ç": { v: "viseme_CH", w: 0.24, d: 0.8 },
  t: { v: "viseme_DD", w: 0.18, d: 0.65 },
  d: { v: "viseme_DD", w: 0.18, d: 0.65 },
  n: { v: "viseme_nn", w: 0.18, d: 0.7 },
  l: { v: "viseme_nn", w: 0.16, d: 0.7 },
  r: { v: "viseme_RR", w: 0.18, d: 0.75 },
  k: { v: "viseme_kk", w: 0.16, d: 0.65 },
  g: { v: "viseme_kk", w: 0.16, d: 0.65 },
  "ğ": { v: "viseme_aa", w: 0.12, d: 0.7 },
  y: { v: "viseme_I",  w: 0.16, d: 0.7 },
  h: { v: "viseme_aa", w: 0.14, d: 0.6 },
};

const ALL_VISEMES = [
  "viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD",
  "viseme_kk", "viseme_CH", "viseme_SS", "viseme_nn", "viseme_RR",
  "viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U",
];

function buildTurkishVisemeTimeline(text) {
  const lower = String(text || "").toLocaleLowerCase("tr-TR");
  const timeline = [];
  let cursor = 0;
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (TR_VISEME_MAP[ch]) {
      const m = TR_VISEME_MAP[ch];
      timeline.push({ t0: cursor, t1: cursor + m.d, v: m.v, w: m.w });
      cursor += m.d;
    } else if (ch === "." || ch === "!" || ch === "?" || ch === ",") {
      const pause = ch === "," ? 1.8 : 3.2;
      timeline.push({ t0: cursor, t1: cursor + pause, v: "viseme_sil", w: 0 });
      cursor += pause;
    } else if (ch === " ") {
      timeline.push({ t0: cursor, t1: cursor + 0.55, v: "viseme_sil", w: 0 });
      cursor += 0.55;
    }
  }
  return { timeline, totalUnits: Math.max(1, cursor) };
}

class TeacherAvatar3D {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.isSpeaking = false;
    this.emotion = "happy";
    this.analyser = null;
    this.timeData = null;
    this.audioCtx = null;
    this.activeAudioEl = null;
    this.visemeTrack = null;
    this.speechStartMs = 0;

    this.morphMeshes = [];
    this.headBone = null;
    this.baseHeadRot = { x: 0, y: 0, z: 0 };
    this.visemeWeights = {};
    for (const v of ALL_VISEMES) this.visemeWeights[v] = 0;

    this.t = 0;
    this.nextBlinkAt = 2.6;
    this.blinkVal = 0;

    if (!this.container || typeof THREE === "undefined" || !THREE.GLTFLoader) {
      this._renderFallback();
      return;
    }
    try {
      this._initScene();
      this._loadModel("/assets/elif_tutor/models/elif_teacher.glb");
      this._animate();
    } catch (e) {
      console.warn("3D Avatar fallback:", e);
      this._renderFallback();
    }
  }

  _renderFallback() {
    this.container.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;">' +
      '<div style="font-size:4.2rem;">👩‍🏫</div>' +
      '<div style="font-weight:700;color:#4a0e2e;">Elif Öğretmen</div></div>' +
      '<span id="avatar-emotion-pill" class="avatar-badge">😊 Hazır</span>';
  }

  _initScene() {
    const w = this.container.clientWidth || 320;
    const h = this.container.clientHeight || 270;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(26, w / h, 0.05, 50);
    this.camera.position.set(0, 1.62, 0.86);
    this.camera.lookAt(0, 1.60, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xfffaf2, 0xd8c3b8, 1.05));
    const keyLight = new THREE.DirectionalLight(0xfff5e8, 1.15);
    keyLight.position.set(1.2, 2.2, 2.4);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xf6ebf1, 0.45);
    fillLight.position.set(-1.8, 1.5, 1.5);
    this.scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffe7b3, 0.38);
    rimLight.position.set(0, 2.4, -1.6);
    this.scene.add(rimLight);

    window.addEventListener("resize", () => {
      if (!this.container || !this.renderer) return;
      const nw = this.container.clientWidth || 320;
      const nh = this.container.clientHeight || 270;
      this.camera.aspect = nw / nh;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(nw, nh);
    });
  }

  _loadModel(url) {
    const badge = document.getElementById("avatar-emotion-pill");
    if (badge) badge.textContent = "⏳ 3D Öğretmen Yükleniyor...";

    const loader = new THREE.GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        const model = gltf.scene;
        this.scene.add(model);

        model.traverse((obj) => {
          if (obj.isMesh) {
            obj.frustumCulled = false;
            if (obj.morphTargetDictionary && obj.morphTargetInfluences) {
              this.morphMeshes.push(obj);
            }
          }
          if (obj.isBone && obj.name === "Head") {
            this.headBone = obj;
          }
        });

        model.updateMatrixWorld(true);

        // Tam baş + saç + gözlük + üst omuz kadrajı (kesilmeden sürekli karşıya bakar)
        const target = new THREE.Vector3(0, 1.60, 0);
        if (this.headBone) {
          this.headBone.getWorldPosition(target);
          this.baseHeadRot = {
            x: this.headBone.rotation.x,
            y: this.headBone.rotation.y,
            z: this.headBone.rotation.z,
          };
          target.y += 0.035;
        }
        this.camera.position.set(target.x, target.y + 0.015, target.z + 0.86);
        this.camera.lookAt(target.x, target.y, target.z);

        // jawOpen ve mouthOpen daima 0 (çift açılma engeli!)
        this._setMorph("jawOpen", 0);
        this._setMorph("mouthOpen", 0);
        this._setMorph("mouthSmile", 0.24);
        if (badge) badge.textContent = "😊 Ödev Sayfası Bekliyor";
      },
      undefined,
      (err) => {
        console.error("GLB yükleme hatası:", err);
        this._renderFallback();
      }
    );
  }

  _setMorph(name, value) {
    const v = Math.max(0, Math.min(1, value));
    for (const mesh of this.morphMeshes) {
      const idx = mesh.morphTargetDictionary[name];
      if (idx !== undefined) {
        mesh.morphTargetInfluences[idx] = v;
      }
    }
  }

  setEmotion(emo) {
    this.emotion = emo || "happy";
  }

  setSpeechText(text) {
    this.visemeTrack = buildTurkishVisemeTimeline(text);
    this.speechStartMs = performance.now();
  }

  attachAudioElement(audioEl, spokenText = "") {
    if (spokenText) this.setSpeechText(spokenText);
    this.activeAudioEl = audioEl;
    try {
      if (!this.audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AC();
      }
      if (this.audioCtx.state === "suspended") this.audioCtx.resume();
      const src = this.audioCtx.createMediaElementSource(audioEl);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      src.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);
      this.timeData = new Uint8Array(this.analyser.fftSize);
      this.isSpeaking = true;
      const stop = () => {
        this.isSpeaking = false;
        this.activeAudioEl = null;
      };
      audioEl.addEventListener("ended", stop);
      audioEl.addEventListener("pause", stop);
    } catch (e) {
      this.isSpeaking = true;
    }
  }

  _getLiveAudioRms() {
    if (!this.analyser || !this.timeData) return 0.65;
    this.analyser.getByteTimeDomainData(this.timeData);
    let sumSq = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const norm = (this.timeData[i] - 128) / 128;
      sumSq += norm * norm;
    }
    return Math.sqrt(sumSq / this.timeData.length);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.t += 0.016;

    // 1. Doğal Göz Kırpma
    if (this.t >= this.nextBlinkAt) {
      this.blinkVal = 1.0;
      this.nextBlinkAt = this.t + 2.6 + Math.random() * 2.5;
    } else if (this.blinkVal > 0) {
      this.blinkVal = Math.max(0, this.blinkVal - 0.14);
    }
    this._setMorph("eyeBlinkLeft", this.blinkVal);
    this._setMorph("eyeBlinkRight", this.blinkVal);

    // 2. Duygu İfadeleri
    const targetSmile =
      this.emotion === "celebrate" ? 0.55 :
      this.emotion === "thinking" ? 0.10 :
      this.emotion === "encouraging" ? 0.34 : 0.24;
    const targetBrow =
      this.emotion === "thinking" ? 0.38 :
      this.emotion === "celebrate" ? 0.30 : 0.06;
    this._setMorph("mouthSmile", targetSmile);
    this._setMorph("browInnerUp", targetBrow);

    // jawOpen ve mouthOpen kesinlikle 0 (TalkingHead kuralı: sadece tek viseme çalışır!)
    this._setMorph("jawOpen", 0);
    this._setMorph("mouthOpen", 0);

    // 3. TalkingHead Tarzı Tek-Aktif-Viseme Dudak Senkronu
    let activeViseme = "viseme_sil";
    let activeWeight = 0;

    if (this.isSpeaking) {
      const rms = this._getLiveAudioRms();
      // Ses sessizleştiyse (cümle arası nefes) ağzı doğalca kapat; konuşurken yumuşak doğal açıklık
      const volScale = rms < 0.015 ? 0 : Math.min(0.88, 0.45 + rms * 2.2);

      if (volScale > 0 && this.visemeTrack && this.visemeTrack.timeline.length > 0) {
        let progress = 0;
        if (this.activeAudioEl && this.activeAudioEl.duration > 0) {
          progress = Math.min(0.999, this.activeAudioEl.currentTime / this.activeAudioEl.duration);
        } else {
          // Tarayıcı TTS fallback için tahmini okuma hızı (~13 karakter/sn)
          const estSec = Math.max(1.5, this.visemeTrack.totalUnits / 13);
          progress = Math.min(0.999, ((performance.now() - this.speechStartMs) / 1000) / estSec);
        }
        const pos = progress * this.visemeTrack.totalUnits;
        const tl = this.visemeTrack.timeline;
        for (let i = 0; i < tl.length; i++) {
          if (pos >= tl[i].t0 && pos <= tl[i].t1) {
            activeViseme = tl[i].v;
            activeWeight = tl[i].w * volScale;
            break;
          }
        }
      }
    }

    // Tüm visemeleri yumuşakça hedef değere geçiş yaptır (diğerleri 0'a söner)
    const smooth = 0.35;
    for (const v of ALL_VISEMES) {
      const tgt = v === activeViseme ? activeWeight : 0;
      this.visemeWeights[v] += (tgt - this.visemeWeights[v]) * smooth;
      this._setMorph(v, this.visemeWeights[v]);
    }

    // 4. Sürekli Karşıya Bakan Yumuşak Kafa Hareketi
    if (this.headBone) {
      const nodAmp = this.isSpeaking ? 0.032 : 0.010;
      const tiltAmp = this.isSpeaking ? 0.022 : 0.008;
      this.headBone.rotation.x = this.baseHeadRot.x + Math.sin(this.t * 2.2) * nodAmp;
      this.headBone.rotation.y = this.baseHeadRot.y + Math.sin(this.t * 0.9) * 0.018;
      this.headBone.rotation.z = this.baseHeadRot.z + Math.sin(this.t * 1.4) * tiltAmp;
    }

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }
}
