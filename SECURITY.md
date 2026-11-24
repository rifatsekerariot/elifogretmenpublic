# Güvenlik Politikası (Security Policy)

## Desteklenen Sürümler

| Sürüm | Destek Durumu |
| :--- | :--- |
| `main` (v1.x) | Destekleniyor |

## Güvenlik Açığı Bildirimi

Bir güvenlik açığı tespit ettiğinizde lütfen herkese açık bir GitHub Issue **açmayın**.

Bunun yerine GitHub Security Advisories üzerinden özel bildirim gönderin veya depo sahibiyle doğrudan iletişime geçin. Bildiriminizde mümkünse:
- Etkilenen dosya / uç nokta
- Yeniden üretme adımları
- Olası etki özeti

bilgilerini paylaşın. En kısa sürede inceleyip düzeltme yayınlanacaktır.

## Üretim Ortamı Önerileri

- `.env` dosyasını `chmod 600` ile koruyun ve asla sürüm kontrolüne eklemeyin.
- Üretimde mutlaka HTTPS (Let's Encrypt / reverse proxy), `disable_signup = 1` ve `/api/method/login` üzerinde rate-limiting kullanın.
- Yalnızca güvenli dosya türlerinin (`JPG`, `PNG`, `WEBP`, `PDF`, maks. 15 MB) yüklenmesine izin veren sunucu taraflı doğrulamayı devre dışı bırakmayın.
