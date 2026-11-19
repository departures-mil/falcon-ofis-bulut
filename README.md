# Falcon Ofis · bulut cüzdan izleyici

Program bilgisayarda ya da telefonda kapalıyken de kripto cüzdanlara gelen / giden paraları
5 dakikada bir kontrol eder, kasaya yazar ve Firebase'e gönderir (GitHub Actions).

- `src/`: Falcon Ofis'in kendi kodu (kayıt defteri, cüzdan kontrolü, eşitleme) — program güncellenince buraya da kopyalanır.
- `run.js`: tek tur (eşitle → cüzdanları kontrol et → eşitle).
- Kayıt defteri şifreli olarak Actions önbelleğinde tutulur; kayıtlarda tutar / adres yazılmaz.
- Gerekli secret: `FALCON_PASSWORD` (programdaki eşitleme hesabının şifresi, qa757939@gmail.com). Kayıt defterinin şifresi bundan türetilir.
