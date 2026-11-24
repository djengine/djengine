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

## Yeni özellikler
- **Takip şartı:** Mesaj sadece takipçilere gider. Takip etmeyene "önce takip et" mesajı gider; takip edip yazınca asıl mesaj otomatik gönderilir.
- **Gönderi kapsamı:** Tüm son gönderiler, sadece Reels, belirli bir tarihten sonraki gönderiler veya seçilen gönderiler.
- **Hikâye cevabı tetikleyicisi:** Hikâyenize anahtar kelimeyle cevap verene otomatik DM.
- **Kişiler:** Etkileşime giren herkes listelenir; DM'de paylaşılan e-posta/telefon otomatik kaydedilir ve Excel'e (CSV) aktarılır.
- **İstatistik:** Her otomasyon için tetiklenme, gönderim ve takip şartı sayıları.
- **Ücretsiz yapay zekâ (Ollama):** Hesap analizi, haftalık içerik planı, gönderi metni, bio ve büyüme stratejisi önerileri; otomasyon cevaplarını yapay zekâ yazabilir; **Otomatik pilot** tüm DM'lere sizin yerinize cevap verir. Model Mac'inizde çalışır, ücretsizdir, veriler dışarı gönderilmez.

### Yapay zekâyı eğitme
**Yapay Zekâ → 🧠 Beni tanı** bölümünde kim olduğunuzu, hedeflerinizi, fiyat/link/iletişim bilgilerinizi, sık sorulan sorulara cevaplarınızı, üslubunuzu ve yapmaması gerekenleri yazın. **DM'lerimden öğren** Instagram'da bizzat verdiğiniz cevapları örnek olarak toplar; **Dene ve öğret** ile yapay zekânın cevabını onaylayıp ya da düzelterek ona öğretirsiniz. Yapay zekâ cevap yazarken sohbetin son mesajlarını da görür; sizin zaten cevap verdiğiniz mesajlara tekrar cevap vermez. Mesaj isteklerine (sizi takip etmeyenlerin DM'leri) de cevap verir.

### Yapay zekâ kurulumu (bir kez)
1. [ollama.com/download](https://ollama.com/download) adresinden Ollama'yı indirip açın.
2. Uygulamada **Yapay Zekâ** sayfasında **Modeli indir**'e basın (Gemma 3 4B, ~3,3 GB).

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
