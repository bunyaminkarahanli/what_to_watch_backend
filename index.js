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
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT_JSON yok. Token doğrulama çalışmaz.");
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
    console.error("❌ FIREBASE_SERVICE_ACCOUNT_JSON parse edilemedi:", e.message);
  }
}

initFirebaseAdmin();

// ✅ Firestore handle
const db = admin.apps.length ? admin.firestore() : null;

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
// ✅ Firestore tabanlı kredi sistemi
// users/{uid} -> { credits: number, createdAt, updatedAt }
// purchases/{purchaseToken} -> { userId, amount, createdAt, meta }
// -----------------------------
const INITIAL_CREDITS = 7;

function requireFirestore(req, res) {
  if (!db) {
    res.status(500).json({
      error: "firestore_not_initialized",
      message: "Firestore başlatılamadı. Firebase Admin init / env kontrol et.",
    });
    return false;
  }
  return true;
}

async function getOrCreateUserCredits(userId) {
  const ref = db.collection("users").doc(userId);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({
      credits: INITIAL_CREDITS,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return INITIAL_CREDITS;
  }

  const data = snap.data() || {};
  const credits = typeof data.credits === "number" ? data.credits : 0;
  return credits;
}

async function decreaseCredit(userId) {
  const ref = db.collection("users").doc(userId);

  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);

    // kullanıcı yoksa oluştur ve 1 düş
    if (!snap.exists) {
      tx.set(ref, {
        credits: INITIAL_CREDITS - 1,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { ok: true, remaining: INITIAL_CREDITS - 1 };
    }

    const data = snap.data() || {};
    const credits = typeof data.credits === "number" ? data.credits : 0;

    if (credits <= 0) {
      return {
        ok: false,
        code: "limit_exceeded",
        message: "Ücretsiz araç önerisi hakkınız bitti.",
      };
    }

    tx.update(ref, {
      credits: credits - 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { ok: true, remaining: credits - 1 };
  });
}

async function addCredits(userId, amount) {
  const ref = db.collection("users").doc(userId);

  // kullanıcı yoksa bile merge ile oluşturur
  await ref.set(
    {
      credits: admin.firestore.FieldValue.increment(amount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const snap = await ref.get();
  const data = snap.data() || {};
  return typeof data.credits === "number" ? data.credits : 0;
}

// -----------------------------
// 🚀 ARAÇ ÖNERİ ENDPOINTİ (TOKEN ZORUNLU)
// -----------------------------
app.post("/api/cars/recommend", rateLimit, requireFirebaseAuth, async (req, res) => {
  try {
    if (!requireFirestore(req, res)) return;

    const prefs = req.body || {};
    const userId = req.user.uid;

    // ✅ önce kredi düş (OpenAI çağrısından önce)
    const creditResult = await decreaseCredit(userId);
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

    const content = (openaiRes.data.choices?.[0]?.message?.content || "").trim();

    let jsonText = content;
    const firstBracket = content.indexOf("[");
    const lastBracket = content.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      jsonText = content.slice(firstBracket, lastBracket + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      // JSON bozulursa krediyi geri ver
      await addCredits(userId, 1);
      return res.status(500).json({ error: "Invalid JSON from OpenAI" });
    }

    console.log(`✅ user=${userId} öneri aldı. kalan=${creditResult.remaining}`);
    return res.json(parsed);
  } catch (err) {
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

// -----------------------------
// 🚀 SATIN ALIM SONRASI KREDİ EKLEME (IDEMPOTENT - Firestore)
// -----------------------------
app.post("/api/cars/add-credits", requireFirebaseAuth, async (req, res) => {
  try {
    if (!requireFirestore(req, res)) return;

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

    const amountToAdd = productId === "credits-10" ? 10 : 0;
    if (amountToAdd <= 0) {
      return res.status(400).json({
        error: "unknown_product",
        message: "Bu productId için kredi tanımlı değil.",
      });
    }

    // ✅ idempotency: purchaseToken ile tekil
    const purchaseRef = db.collection("purchases").doc(purchaseToken);

    const result = await db.runTransaction(async (tx) => {
      const purchaseSnap = await tx.get(purchaseRef);

      if (purchaseSnap.exists) {
        // daha önce işlenmiş
        const credits = await getOrCreateUserCredits(userId);
        return { ok: true, alreadyProcessed: true, total: credits };
      }

      // satın alımı kaydet
      tx.set(purchaseRef, {
        userId,
        amount: amountToAdd,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        meta: { platform, packageName, productId },
      });

      // krediyi ekle
      const userRef = db.collection("users").doc(userId);
      const userSnap = await tx.get(userRef);

      if (!userSnap.exists) {
        tx.set(userRef, {
          credits: INITIAL_CREDITS + amountToAdd,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return { ok: true, alreadyProcessed: false, total: INITIAL_CREDITS + amountToAdd };
      }

      const current = (userSnap.data()?.credits ?? 0);
      const newTotal = current + amountToAdd;

      tx.update(userRef, {
        credits: newTotal,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { ok: true, alreadyProcessed: false, total: newTotal };
    });

    console.log(`✅ add-credits user=${userId} +${amountToAdd} total=${result.total}`);
    return res.json({
      ok: true,
      alreadyProcessed: result.alreadyProcessed,
      total: result.total,
      message: result.alreadyProcessed
        ? "Bu satın alım daha önce işlendi. Tekrar kredi eklenmedi."
        : "Kredi eklendi.",
    });
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
app.listen(port, () => console.log(`Backend çalıştı: http://localhost:${port}`));
