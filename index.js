// index.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");
const admin = require("firebase-admin");

dotenv.config();

// ✅ app TANIMI
const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// ✅ Firebase Admin Init (ENV JSON)
// Render env: FIREBASE_SERVICE_ACCOUNT_JSON
// -----------------------------
function initFirebaseAdmin() {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!json) {
    console.warn(
      "⚠️ FIREBASE_SERVICE_ACCOUNT_JSON yok. Token doğrulama çalışmaz."
    );
    return;
  }

  try {
    const serviceAccount = JSON.parse(json);

    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log("✅ Firebase Admin initialized (env)");
    }
  } catch (e) {
    console.error(
      "❌ FIREBASE_SERVICE_ACCOUNT_JSON parse edilemedi:",
      e.message
    );
  }
}

initFirebaseAdmin();

// -----------------------------
// Health check
// -----------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// -----------------------------
// Rate limit (dakikada 20 istek - IP bazlı)
// -----------------------------
const requests = {};
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();

  if (!requests[ip]) requests[ip] = [];
  requests[ip] = requests[ip].filter((t) => now - t < WINDOW_MS);

  if (requests[ip].length >= MAX_PER_WINDOW) {
    return res.status(429).json({
      error: "too_many_requests",
      message: "Lütfen daha sonra tekrar deneyin.",
    });
  }

  requests[ip].push(now);
  next();
}

// -----------------------------
// ✅ Firebase Auth Middleware
// Authorization: Bearer <Firebase ID Token>
// -----------------------------
async function requireFirebaseAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const parts = header.split(" ");
    const token = parts.length === 2 ? parts[1] : null;

    if (!token) {
      return res.status(401).json({
        error: "unauthorized",
        message: "Authorization Bearer token eksik.",
      });
    }

    if (admin.apps.length === 0) {
      return res.status(500).json({
        error: "firebase_not_initialized",
        message:
          "Firebase Admin başlatılamadı. Render env: FIREBASE_SERVICE_ACCOUNT_JSON kontrol et.",
      });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid, email: decoded.email || null };
    next();
  } catch (e) {
    return res.status(401).json({
      error: "invalid_token",
      message: "Firebase token doğrulanamadı.",
    });
  }
}

// -----------------------------
// 🚀 Kredi sistemi (RAM tabanlı)
// -----------------------------
const userCredits = {};
const INITIAL_CREDITS = 7;

// ✅ Idempotency: aynı purchaseToken tekrar gelirse kredi ekleme
const processedPurchases = {}; // purchaseToken -> { userId, amount, createdAt, meta }

function ensureUserCredits(userId) {
  if (userCredits[userId] === undefined) userCredits[userId] = INITIAL_CREDITS;
  return userCredits[userId];
}

function decreaseCredit(userId) {
  ensureUserCredits(userId);

  if (userCredits[userId] <= 0) {
    return {
      ok: false,
      code: "limit_exceeded",
      message: "Ücretsiz araç önerisi hakkınız bitti.",
    };
  }

  userCredits[userId] -= 1;
  return { ok: true, remaining: userCredits[userId] };
}

function addCredits(userId, amount) {
  if (userCredits[userId] === undefined) userCredits[userId] = 0;
  userCredits[userId] += amount;
  return userCredits[userId];
}

// -----------------------------
// 🚀 ARAÇ ÖNERİ ENDPOINTİ (TOKEN ZORUNLU)
// -----------------------------
app.post(
  "/api/cars/recommend",
  rateLimit,
  requireFirebaseAuth,
  async (req, res) => {
    try {
      const prefs = req.body || {};
      const userId = req.user.uid; // ✅ TOKEN'DAN

      // ✅ önce kredi düş (OpenAI çağrısından önce)
      const creditResult = decreaseCredit(userId);
      if (!creditResult.ok) {
        return res.status(403).json({
          error: creditResult.code,
          message: creditResult.message,
        });
      }

      const prompt = `
Sen bir araç danışmanısın. Görevin, kullanıcının verdiği bilgilere göre Türkiye koşullarında ona uygun araç segmentini ve 3–5 adet model önerisini sunmaktır.

Kurallar:
- Türkiye’deki güncel fiyatları bilmiyorsun. Kesinlikle FİYAT bilgisi, TL, bütçe, fiyat aralığı yazma.
- “Şu kadar TL’ye alırsın”, “bu fiyat bandında” gibi ifadeler kullanma.
- Sadece genel tavsiye ver: segment, araç/kasa tipi, yakıt tipi, vites tipi, uygun kullanım senaryosu vb.
- Önerdiğin her araç için kısa ama açıklayıcı bir açıklama yaz: kime uygun, artıları neler, neden öneriyorsun.
- Kullanıcının ek notlarını da mutlaka dikkate al.
- Cevabı mutlaka GEÇERLİ BİR JSON olarak döndür.
- JSON dışında hiçbir açıklama, yorum, metin yazma. Sadece JSON üret.

Kullanıcının cevapları şunlardır:
- Kullanım alanı: ${prefs.usage}
- Aile büyüklüğü: ${prefs.family_size}
- Sürüş tecrübesi: ${prefs.driving_experience}
- Yakıt tercihi: ${prefs.fuel_type}
- Vites tercihi: ${prefs.gearbox}
- Araç tipi: ${prefs.body_type}
- Sıfır / ikinci el tercihi: ${prefs.new_or_used}
- Önceliği: ${prefs.priority}
- Teknoloji/donanım beklentisi: ${prefs.tech_level}
- Ek not: ${prefs.extra_desc || ""}

Bu bilgilere göre bana SADECE şu formatta bir JSON DİZİSİ döndür:

[
  {
    "model": "Model adı",
    "why": "Bu modelin neden uygun olduğu, artıları, kime hitap ettiği (kısa açıklama)",
    "segment": "Önerilen segment (örneğin C-SUV, B-Hatchback vb.)"
  }
]

Dikkat:
- "price", "fiyat", "TL" gibi kelimeleri kullanma.
- JSON dışında TEK BİR KARAKTER bile yazma.
`;

      const openaiRes = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4.1-mini",
          messages: [
            { role: "system", content: "You are a car recommendation AI." },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const content = (
        openaiRes.data.choices?.[0]?.message?.content || ""
      ).trim();

      let jsonText = content;
      const firstBracket = content.indexOf("[");
      const lastBracket = content.lastIndexOf("]");
      if (
        firstBracket !== -1 &&
        lastBracket !== -1 &&
        lastBracket > firstBracket
      ) {
        jsonText = content.slice(firstBracket, lastBracket + 1);
      }

      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch (e) {
        // JSON bozulursa krediyi geri ver
        addCredits(userId, 1);
        return res.status(500).json({ error: "Invalid JSON from OpenAI" });
      }

      console.log(
        `✅ user=${userId} öneri aldı. kalan=${creditResult.remaining}`
      );
      return res.json(parsed);
    } catch (err) {
      console.error(err.response?.data || err.message);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

// -----------------------------
// 🚀 SATIN ALIM SONRASI KREDİ EKLEME (IDEMPOTENT)
// -----------------------------
app.post("/api/cars/add-credits", requireFirebaseAuth, (req, res) => {
  try {
    const userId = req.user?.uid;
    const { platform, packageName, productId, purchaseToken } = req.body || {};

    if (!userId) {
      return res.status(401).json({
        error: "unauthorized",
        message: "Kullanıcı doğrulanamadı.",
      });
    }

    if (!platform || !packageName || !productId || !purchaseToken) {
      return res.status(400).json({
        error: "invalid_params",
        message: "platform / packageName / productId / purchaseToken eksik.",
      });
    }

    const amountToAdd = productId === "credits_20" ? 20 : 0;
    if (amountToAdd <= 0) {
      return res.status(400).json({
        error: "unknown_product",
        message: "Bu productId için kredi tanımlı değil.",
      });
    }

    // ✅ IDMPOTENCY
    if (processedPurchases[purchaseToken]) {
      const total = userCredits[userId] ?? 0;
      return res.json({
        ok: true,
        alreadyProcessed: true,
        total,
        message: "Bu satın alım daha önce işlendi. Tekrar kredi eklenmedi.",
      });
    }

    processedPurchases[purchaseToken] = {
      userId,
      amount: amountToAdd,
      createdAt: Date.now(),
      meta: { platform, packageName, productId },
    };

    const total = addCredits(userId, amountToAdd);

    console.log(`✅ add-credits user=${userId} +${amountToAdd} total=${total}`);
    return res.json({ ok: true, alreadyProcessed: false, total });
  } catch (e) {
    console.error("add-credits error:", e);
    return res.status(500).json({
      error: "server_error",
      message: "Kredi eklerken sunucu hatası oluştu.",
    });
  }
});

// -----------------------------
const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`Backend çalıştı: http://localhost:${port}`)
);
