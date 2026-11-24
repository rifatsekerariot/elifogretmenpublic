# Elif Öğretmen — 3D Ev Ödevi Asistanı (Community Edition)

**Elif Öğretmen**, öğrencilerin yüklediği ev ödevi sayfalarını (fotoğraf veya PDF) okuyup kontrol eden, boş soruları adım adım Sokratik yöntemle birlikte çözdüren, her soru ve sayfa için çalışma süresini ölçerek **Ödev Zamanı Notu** çıkaran ve dersler arası uzun dönem öğrenme hafızası tutan **Frappe Framework v15** tabanlı sanal öğretmen uygulamasıdır.

---

## Özellikler (Community Edition — Bireysel Kullanım)

- **Ödev Sayfası Okuma & Kontrol:** Kameradan çekilen veya Fotoğraf/PDF olarak yüklenen ödev sayfasını okur. Cevaplı soruları kontrol eder; doğruları `Oldu` işaretler, yanlışlarda nedeni ve çözüm yolunu tahtada anlatır; boş soruları adım adım birlikte çözdürür.
- **Kalıcı Ödev & Soru Hafızası (MariaDB):** Her soru normalize edilmiş parmak iziyle (`question_hash`) saklanır. Aynı kağıt tekrar yüklendiğinde çözülmüş sorular atlanır, yarım kalan sorular kaldığı yerden devam eder.
- **Uzun Dönem Öğrenme Hafızası (Cross-Session):** `Student Learning Memory` DocType ve okunabilir Markdown günlüğü ile öğrencinin geçmiş ödevlerde takıldığı kavramları özetler; model yalnızca ilgili konu tekrar çıktığında bu özeti çağırır.
- **Canlı Kronometre & Ödev Zamanı Notu:** Soru ve sayfa bazlı aktif çalışma süresi (mola korumalı) ölçülür; tamamlama, tempo ve dikkat dengesine göre 0–100 + harf notu (`A+`, `A`, `B`, `C`, `D`) hesaplanır.
- **3D Konuşan Öğretmen (Türkçe Fonetik Viseme):** Three.js + 72 morph target'lı `.glb` kafa modeli, ses seviyesi (RMS) ve Türkçe harf/hece zaman çizelgesiyle tarayıcı içinde gerçek zamanlı dudak senkronu sağlar (sunucuda ek RAM harcamaz).
- **Buton Kontrollü Sesli Diyalog:** Global audio mutex kilidi ve *Bas -> Konuş -> Gönder* akışıyla yankı ve üst üste binen ses sorununu engeller.
- **Düşük Token Mimarisi:** Ödev görseli modele yalnızca ilk okuma anında 1 kez gönderilir; takip eden tüm sohbet turları hafif metin modeliyle ve son 6 mesajlık kayan pencereyle yürür.

---

## Community Edition vs. Pro / Okul Sürümü (Open-Core)

Bu depo **bireysel, ticari olmayan kullanım** için tam çalışan **Community Edition** sürümünü içerir. Kurumsal eğitim kurumları ve ticari projeler için kapalı kaynak **Pro / Okul** sürümü ayrı lisanslanır:

| Özellik | Community Edition (Bu Repo) | Pro / Okul & Ticari Sürüm |
| :--- | :---: | :---: |
| Tek öğrenci ev ödevi asistanı | ✅ | ✅ |
| 3D konuşan öğretmen & Akıllı Tahta (KaTeX/SVG) | ✅ | ✅ |
| Cevaplı/boş ödev kontrolü & süre/zaman notu | ✅ | ✅ |
| Uzun dönem öğrenme hafızası (`Student Learning Memory`) | ✅ | ✅ |
| Çoklu öğrenci, sınıf, şube ve öğretmen yönetimi | — | ✅ |
| Veliye otomatik WhatsApp / SMS haftalık karne | — | ✅ |
| Okula özel müfredat & PDF soru bankası RAG motoru | — | ✅ |
| White-Label (okul logosu, özel domain, KVKK on-premise) | — | ✅ |
| Çoklu kiracı (Multi-Tenant) SaaS & kota/faturalandırma | — | ✅ |
| Kurumsal SLA, kurulum ve bakım desteği | — | ✅ |

---

## Hızlı Kurulum (Docker — ~250 MB RAM)

### 1. Ortam Değişkenlerini Hazırlayın
```bash
cp .env.example .env
chmod 600 .env
```
`.env` içinde `GOOGLE_API_KEY`, `MARIADB_ROOT_PASSWORD`, `FRAPPE_ADMIN_PASSWORD`, `SITE_NAME` ve `STUDENT_NAME` değerlerini kendi ortamınıza göre düzenleyin.

### 2. Veritabanı ve Redis'i Başlatın
```bash
docker compose up -d odev-mariadb odev-redis
```

### 3. Frappe Sitesini ve `elif_tutor` Uygulamasını Kurun
```bash
mkdir -p sites/assets/elif_tutor
cp -r elif_tutor/elif_tutor/public/* sites/assets/elif_tutor/

docker compose run --rm --entrypoint bash odev-frappe -c '
  set -e
  cd /home/frappe/frappe-bench
  bench set-config -g db_host odev-mariadb
  bench set-config -g redis_cache redis://odev-redis:6379
  bench set-config -g redis_queue redis://odev-redis:6379
  bench set-config -g redis_socketio redis://odev-redis:6379
  /home/frappe/frappe-bench/env/bin/pip install --no-deps --no-build-isolation -e apps/elif_tutor
  bench new-site "${SITE_NAME:-odev.localhost}" \
    --mariadb-root-password "$MARIADB_ROOT_PASSWORD" \
    --admin-password "$FRAPPE_ADMIN_PASSWORD" \
    --db-host odev-mariadb --mariadb-user-host-login-scope="%"
  bench --site "${SITE_NAME:-odev.localhost}" install-app elif_tutor
  bench --site "${SITE_NAME:-odev.localhost}" clear-cache
'
```

### 4. Uygulamayı Başlatın
```bash
docker compose up -d odev-frappe
```
Uygulama varsayılan olarak `127.0.0.1:8095` üzerinde çalışır; üretimde HTTPS (Nginx + Let's Encrypt) arkasında yayınlamanız önerilir.

---

## Lisans ve Ticari Kullanım

Bu yazılım **PolyForm Noncommercial License 1.0.0** kapsamında lisanslanmıştır. Ayrıntılar için [LICENSE](LICENSE) dosyasına bakın.

- **Kişisel, ev içi ve ticari olmayan kullanım (PolyForm 1.0.0 kapsamındaki kâr amacı gütmeyen eğitim kurumları dahil) ücretsizdir.**
- **Ticari kullanım yasaktır:** Ücretli SaaS hizmeti sunmak, kâr amaçlı ticari bir ürün veya hizmetin parçası olarak sunmak veya ticari white-label dağıtım yapmak için ayrıca **Ticari Lisans** alınması gerekir.
- Ticari lisanslama, okul kurulumu ve Pro sürüm için GitHub profili üzerinden iletişime geçebilirsiniz.

---

*Antigravity ile geliştirilmiştir.*
