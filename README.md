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
- Hesaplar Instagram **kullanıcı adı ve şifreyle** bağlanır. Meta geliştirici hesabı veya token gerekmez. Şifre saklanmaz; oturum bilgisi macOS Anahtar Zinciri ile şifrelenerek saklanır.

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
1. Uygulamada **Hesaplar** sayfasına Instagram **kullanıcı adınızı** (e-posta değil) ve şifrenizi yazıp **Giriş yap**'a basın.
2. Uygulama Instagram'a arka planda giriş yapar. Instagram doğrulama kodu isterse veya şifre yanlışsa Instagram penceresi açılır; kodu orada girin.
3. İkinci hesap için tekrarlayın.

Instagram oturumu kapatırsa hesap **"Yeniden giriş gerekli"** olarak görünür; **Yeniden giriş yap**'a basıp şifrenizi tekrar girmeniz yeterli.

> **Risk:** Bu yöntem Instagram'ın web sitesinin kullandığı, belgelenmemiş servislerle çalışır; resmî otomasyon yolu değildir. Instagram bu servisleri değiştirebilir veya otomatik mesajları kurallarına aykırı sayıp hesabı kısıtlayabilir. Saatlik gönderim sınırını düşük tutun.

## Geliştirme
```bash
npm start          # uygulamayı geliştirme modunda açar
npm test           # birim testleri
npm run test:e2e   # uçtan uca arayüz testleri (sahte Instagram sunucusuyla)
```
