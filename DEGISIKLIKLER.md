# `arkadas-kodu` dalı — ne var, ne değişti

Bu dal, Ek İşler'in **saha güvenlik katmanlarını** baştan kurar. Geçmişi takımın `main`
dalından bağımsızdır; birleştirme sonradan elle yapılacaktır.

Tarih: 19 Eylül 2026 · Stellar Hackathon Türkiye

---

## 1. Kural özeti

Üç saha adımı var ve **yalnızca sonuncusu para hareket ettirir**. Bu, bilerek verilmiş bir
karardır: ara adımlar kanıt toplar, ödeme tek seferde yapılır.

| Adım | Ne yapar | Para |
|---|---|---|
| **Kod 1** · varış | İhaleci sahada çalışana 12 karakterlik kodu (`K7M2-QX9F-4B3T`) **elden** verir. Çalışan uygulamasına yazar, zincire "geldi" yazılır. | ❌ |
| **Kod 2** · yoklama | Çalışma saatlerinin **tam ortasında** ihaleciye tek bildirim gider ve **15 dakika** açık kalır: "çalışanlar iş yerinde ve çalışıyor mu?". İhaleci çalışmayanları işaretler; onlara anında bildirim düşer. | ❌ |
| **Gün sonu QR** · ödeme | İş bitince ihaleci QR'ı gösterir, çalışan **kamerayla** okutur, **payının tamamı** anında hesabına geçer. | ✅ |
| **Konum** | Kod 1'den gün sonu ödemesine kadar çalışanın cihazında izlenir. Alandan çıkılırsa ihaleciye bildirim gider. | ❌ |

**Kapora yoktur.** Çalışan gün içinde para görmez; karşılığında paranın escrow'da kilitli
olduğunu zincirden doğrulayabilir ve ihaleci ortadan kaybolsa bile son tarih kuralıyla
parasını alır.

### Emniyet supapları

| Ne ters giderse | Ne olur |
|---|---|
| İhaleci Kod 1'i vermezse | Çalışan konum kanıtı gönderir, hakem `arbiter_confirm_arrival` ile *gelmiş* işaretler |
| İhaleci gün sonu QR'ını vermezse | Son tarih sonrası `release_after_deadline`, gelmiş herkese öder (imza gerekmez) |
| Çalışan hiç gelmezse | Payı Trustless Work dispute'una alınır, hakem işverene iade eder |
| Acil durum | Hakem `arbiter_release` ile payı doğrudan açabilir |
| İş iptal olursa | İşveren + ihaleci birlikte `refund`; ödenmiş paylar çalışanda kalır |

---

## 2. Kontrat arayüzü değişiklikleri

Bu dal kontratın **arayüzünü değiştirir**, yani eski deploy ile uyumlu değildir.

| Eski | Yeni | Neden |
|---|---|---|
| `deposit(job_id, commitments)` | `deposit(job_id)` + `set_codes(job_id, commitments)` | Kodları artık **ihaleci** belirler, işveren değil. Sahada olan kişi odur. |
| `claim(job_id, worker, tranche, code)` | `check_in(job_id, worker, code)` + `claim(job_id, worker, code)` | Varış kanıtı ile ödeme ayrıldı |
| `confirm_presence` ödeme yapardı | `confirm_presence_all(job_id, absent)` — ödeme yapmaz | Kod 2 yoklamadır |
| `arbiter_release(.., tranche)` | `arbiter_confirm_arrival(..)` + `arbiter_release(..)` | Hakem varış işaretleyebilir ya da ödeyebilir |
| `JobTerms.arrival_bps`, `mid_bps` | — kaldırıldı | Kapora yok |
| — | `JobTerms.work_start`, `work_end` | Kod 2 penceresi bundan hesaplanır |
| Paydaş başına 3 milestone | Paydaş başına **1** milestone | İş başına en fazla 49 çalışan (eskiden 16) |

Yeni hatalar: `AlreadyArrived (11)`, `InvalidCodeKind (15)`, `CodesNotSet (18)`,
`PresenceWindowClosed (19)`, `InvalidWorkHours (20)`.

Yeni olaylar: `CodesSet`, `CheckedIn`, `PaymentReleased` (eski `TrancheReleased` yerine).

### Yoklama penceresi

```
orta = work_start + (work_end - work_start) / 2
pencere = [orta, orta + 15 dakika)
```

Pencere **zincirde zorunludur**: dışında `confirm_presence*` reddedilir. Sonucu şudur —
ihaleci 15 dakikayı kaçırırsa o iş için yoklama hiç yapılmamış olur. Ödeme akışı
etkilenmez, sadece kayıt oluşmaz. Bu bilinçli bir tercihtir; "istediğim zaman yoklarım"
esnekliği Kod 2'nin anlamını bitirirdi.

### Kod uzunlukları bir güvenlik parametresidir

Kod taahhütleri (sha256) zincirde herkese açıktır, yani kısa kod hash'ten geri bulunabilir.

- **Kod 1** elle yazıldığı için kısa olmak zorunda: 32 harfli alfabeden **12 karakter**
  (60 bit). Karışan harfler (I, L, O, U) alfabede yok. `CODE_LENGTH` ile ayarlanır.
- **Gün sonu QR'ı** yalnızca kamerayla okunduğu için kısa olma zorunluluğu yok:
  **32 baytlık** tam rastgele giz (256 bit).

Parayı aktaran adımın en güçlü gize sahip olması bilinçlidir. 6 haneli sayı (10⁶ ihtimal)
saniyeler içinde kırılır ve çalışan sahaya hiç gelmeden ödeme alabilirdi.

### Kamera

Gün sonu QR'ı parayı hareket ettiren tek adım olduğu için kamera akışı ayrı bir katmana
çekildi (`frontend/src/lib/camera.ts`) ve çalışan burada takılıp kalmayacak şekilde kuruldu:

- **İzin önceden istenir.** Çalışan şartları onaylarken bildirim, kamera ve konum izinleri
  sırayla sorulur (`askFieldPermissions`). Sahada, ödeme anında izin penceresiyle uğraşılmaz.
  Kamera bir an açılıp hemen kapatılır; üçü de reddedilse akış durmaz.
- **Hata nedeni söylenir.** `denied` / `notfound` / `busy` / `insecure` / `unsupported`
  ayrıştırılır ve her biri için ne yapılacağı yazılır. Eskiden hepsi tek bir "kameraya
  erişilemedi" mesajıydı.
- **Daha önce reddedilmişse** `getUserMedia` hiç çağrılmaz: tarayıcı sessizce hata verir,
  çalışan da neden bir şey olmadığını anlamazdı. Yerine "tekrar dene" düğmesi çıkar.
- **Elle yapıştırma yolu** her zaman açık. Eski kod "kodu aşağıya yapıştırabilirsin" diyordu
  ama öyle bir alan yoktu; artık var ve ödemeyi gerçekten tamamlıyor.
- Birden fazla kamera varsa ön/arka değiştirilebilir; tarama karesi 640 px'e küçültülür
  (telefonda tam çözünürlükte jsQR gereksiz pahalı).
- `onResult` bir ref'te tutuluyor. Liste 15 saniyede bir yenilendiği için eskiden kamera
  her yenilemede kapanıp açılıyordu.

---

## 3. Doğrulama

Hepsi 19 Eylül 2026'da gerçek Stellar testnet'inde çalıştırıldı.

| Kontrol | Sonuç |
|---|---|
| `cargo test` | **24/24 geçti** |
| `stellar contract build` | Derlendi |
| `npx tsc --noEmit` | Temiz |
| `node scripts/e2e.ts` | Baştan sona geçti |
| `node scripts/e2e-dispute.ts` | Baştan sona geçti |
| Tarayıcıda tam akış | Geçti (aşağıda) |

### Uçtan uca senaryoda ölçülen değerler

```
w1 Kod 1 · varış      → bakiye 0.0000000 → 0.0000000  (değişmedi ✓)
Kod 2 · herkes çalışıyor → bakiye 0.0000000            (değişmedi ✓)
w1 gün sonu QR        → 6.5248 USDC
hakem w2'yi gelmiş işaretledi (ödeme değil)
hakem w2 payını serbest bıraktı → 3.6702 USDC
SEP-6 withdraw: 6.5052256 USDC → 315.77 TRY
```

Gelmeyen çalışan senaryosu: w1 Kod 1'i girdi ve payını aldı, w2 hiç gelmedi; payı
dispute'a alındı ve hakem kararıyla işverene **+1.9940 USDC** iade edildi.

### Tarayıcıda doğrulananlar

İş oluşturma (çalışma saatleri ve Kod 2 zamanının önceden gösterilmesi), çalışan onayları,
TL→USDC on-ramp (SEP-10 / 12 / 38 / 6), escrow fonlama, kod üretimi, Kod 2 penceresinin
geri sayımla açılması, "çalışmıyor" işaretlemenin o çalışanın ekranına bildirim düşürmesi,
Kod 1'in `✓ geldi` yazıp para ödememesi, gün sonu QR'ının payın tamamını ödemesi.

### Test edilemeyenler

- **İşletim sistemi bildirimleri**: otomatik tarayıcı izin vermedi. Uygulama içi uyarılar
  çalışıyor; bildirim kodu izin yoksa sessizce atlıyor.
- **Gerçek GPS takibi**: konum izni yoktu, takip kendini kapattı (hata vermeden).
- **Kameranın gerçekten açılması**: otomatik tarayıcı kamerayı engelliyor. *Reddedilme* yolu
  uçtan uca doğrulandı: izin yok → doğru hata mesajı + "tekrar dene" + elle yapıştırma →
  gerçek ödeme (İspanyolca tercüman 0.00 → **3.59 USDC**). Görüntüden QR okuma yolu (jsQR)
  test edilemedi.

Bu üçü gerçek bir telefonda doğrulanmalı.

---

## 4. Testnet

| | |
|---|---|
| Bu daldaki Ek İşler kontratı | [`CBPHNMV5DZ3IFT43GRQ6NS65U5W6KTRBENHK3NWFUXJCWTIK3BD72BMT`](https://stellar.expert/explorer/testnet/contract/CBPHNMV5DZ3IFT43GRQ6NS65U5W6KTRBENHK3NWFUXJCWTIK3BD72BMT) |
| Trustless Work escrow wasm hash | `3c42a38069af01f4332aba5e5817bf0415070d5f47d184a9c42c5133433af6d0` |
| Örnek escrow (uçtan uca çalıştırmadan) | [`CD6ASAP2…` Escrow Viewer'da](https://viewer.trustlesswork.com/testnet/v1/CD6ASAP22GFWRB23GX6XAWL3BUZVXCYKVN2BFGO35P6BB2UBZQD7FPIZ) |

Takımın `main` dalındaki canlı kontratına **dokunulmadı**; bu ayrı bir adrestir.
Birleştirmeden sonra yeni kontratın yeniden deploy edilmesi ve `VITE_CONTRACT_ID`'nin
güncellenmesi gerekir.

---

## 5. Çalıştırırken dikkat

**Klasör adında Türkçe karakter olmasın.** `stellar miraç` gibi bir yolda Rust'ın MinGW
linker'ı dosyaları bulamıyor (`ld: cannot find ...miraÃ§...`). İki çözüm: klasörü ASCII bir
ada taşıyın (`stellar-mirac`) ya da derleme çıktısını başka yere yönlendirin:

```bash
set CARGO_TARGET_DIR=C:\temp\ekisler-target
```

**Node'u IPv4'e zorlayın.** Mock anchor'a IPv6 üzerinden bağlantı zaman aşımına uğruyor:

```bash
node --dns-result-order=ipv4first scripts/e2e.ts
```

**Telefonda deneyecekseniz https şart.** Tarayıcılar kamerayı ve konumu yalnızca *güvenli
kaynakta* açar: https ya da localhost. Telefondan `http://192.168.x.x:5173` açarsanız
`navigator.mediaDevices` hiç tanımlı olmaz ve gün sonu QR'ı okutulamaz — uygulama bu durumu
tanıyıp sebebini yazar ama kamera yine de açılmaz. Bunun için:

```bash
npm run dev:https
```

Kendinden imzalı sertifikayla açar (`@vitejs/plugin-basic-ssl`); telefonda bir kez "yine de
devam et" demek gerekir. Bilgisayarda `npm run dev` yeterlidir, localhost zaten güvenlidir.

---

## 6. Bu dalda düzeltilen hata

`frontend/src/lib/config.ts` yalnızca Vite'ın `import.meta.env`'ini okuyordu. Node altında
bu tanımsız olduğu için `VITE_CONTRACT_ID` yok sayılıyor, scriptler koda gömülü eski
kontrata bağlanıyor ve `JobTerms` alanları tutmadığı için `create_job` SDK tarafında
patlıyordu. Artık `process.env` de okunuyor; tarayıcıda Vite değeri önceliklidir.

Bu hatayı yalnızca uygulamayı gerçekten çalıştırınca bulduk — `tsc` ve birim testleri
yakalayamıyordu.

---

## 7. Yapılacaklar

- [ ] README'deki testnet işlem tablosunu bugünkü gerçek hash'lerle güncelle
- [ ] Bildirim, GPS ve kamera akışını gerçek telefonda dene (`npm run dev:https`)
- [ ] `main` ile birleştir, kontratı yeniden deploy et, `VITE_CONTRACT_ID`'yi güncelle
- [ ] Canlı demo URL'si (Vercel)
- [ ] Yoklama kaçırılırsa zincire "yapılmadı" kaydı düşürmek (isteğe bağlı)
