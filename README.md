# Falcon Ofis · bulut cüzdan izleyici

Program bilgisayarda ya da telefonda kapalıyken de kripto cüzdanlara gelen / giden paraları
5 dakikada bir kontrol eder, kasaya yazar ve Firebase'e gönderir (GitHub Actions). v1.54: yeni hareket yoksa ikinci eşitleme turu yapılmaz.

- `src/`: Falcon Ofis'in kendi kodu (kayıt defteri, cüzdan kontrolü, eşitleme) — program güncellenince buraya da kopyalanır.
- `run.js`: tek tur (eşitle → cüzdanları kontrol et → eşitle).
- Kayıt defteri şifreli olarak Actions önbelleğinde tutulur; kayıtlarda tutar / adres yazılmaz.
- Gerekli secret: `FALCON_PASSWORD` (programdaki eşitleme hesabının şifresi). Hesabın e-posta adresi depoda açık yazılmaz:
  `yayin/eposta.enc.json` (bu şifreden türetilen anahtarla AES-256-GCM; `araclar/eposta.js`). Kayıt defterinin şifresi ikisinden türetilir.
- **Güncellemeler artık Firebase'e yüklenmez** (Firebase yalnız canlı kayıtlar içindir). `guncellemeler/masaustu` belgesinde son kez
  Falcon Ofis 1.58.0 köprüsü duruyor (≤1.50 kurulumları yeni GitHub Releases kanalına geçirir). Yayın iş akışı (`yayin.yml`) kaldırıldı;
  `yayin/yayinla.js` yalnız geçmiş kaydı olarak duruyor. Yeni sürümler: departures-mil/falcon-ofis GitHub Releases.
