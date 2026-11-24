# DM Otomasyon

`dj_engine` ve `gsridercyprus` Instagram hesapları için kişisel kullanıma yönelik bir Mac uygulaması. Yorum ve DM otomasyonu yapar.

## Ne yapar?
- **Yorum → DM:** Gönderinize belirlediğiniz bir kelimeyi (örn. `SET`) yazan kişiye otomatik özel mesaj gönderir. İsterseniz yoruma herkese açık bir cevap da yazar.
- **DM → otomatik cevap:** Size gelen DM'de `fiyat` veya `booking` gibi bir kelime geçerse hazır cevabı gönderir.
- **Birden çok hesap:** İki hesabınız tek panelden yönetilir.
- **Test modu:** Mesajları göndermeden "neyin gönderileceğini" Aktivite sayfasına yazar. İlk açılışta açık gelir.
- **Güvenlik önlemleri:**
  - Aynı kişiye aynı otomasyondan bir kez mesaj gider.
  - Saatlik gönderim sınırı vardır.
  - Uygulamanın kurulmasından önceki yorumlara mesaj gönderilmez.
  - Kendi yorumlarınıza cevap verilmez.
- Uygulama menü çubuğunda (saatin yanında) yaşar; pencereyi kapatınca da çalışmaya devam eder.
- Instagram token'ları macOS Anahtar Zinciri ile şifrelenerek saklanır ve 60 günde bir otomatik yenilenir.

> Otomasyon Mac açık ve uygulama çalışırken işler. Mac uykudan uyanınca, kapalıyken gelen son 7 günlük yorumlara cevap verilir.

## Mac'e kurulum (kaynaktan)
1. [Node.js](https://nodejs.org) LTS sürümünü kurun.
2. Terminal'de çalıştırın:
   ```bash
   git clone https://github.com/djengine/djengine.git && cd djengine
   npm install
   npm run icons      # isteğe bağlı: ikonları yeniden üretir
   npm run dist:mac
   ```
3. `dist/` klasöründeki `DM Otomasyon-1.0.0-*.dmg` dosyasını açın ve uygulamayı **Uygulamalar** klasörüne sürükleyin.

## Instagram bağlantısı
Uygulamadaki **Kurulum Rehberi** sayfası adım adım anlatıyor. Kısaca:
1. Her iki Instagram hesabı Profesyonel (İşletme veya İçerik Üreticisi) olmalı.
2. developers.facebook.com'da bir uygulama oluşturun. Kullanım durumu: "Instagram ile mesajları ve içeriği yönetin".
3. Hesaplarınızı **Instagram Test Kullanıcısı** olarak ekleyin ve daveti Instagram'dan kabul edin.
4. "API kurulumu (Instagram girişi ile)" bölümünden her hesap için token oluşturun.
5. Token'ı uygulamadaki **Hesaplar** sayfasına yapıştırın.

Uygulama sadece sizin hesaplarınızda çalışacağı için Meta incelemesine (App Review) gerek yoktur.

## Geliştirme
```bash
npm start          # uygulamayı geliştirme modunda açar
npm test           # birim testleri
npm run test:e2e   # uçtan uca arayüz testleri (sahte Instagram sunucusuyla)
```
