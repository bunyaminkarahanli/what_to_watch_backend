// index.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const axios = require("axios");

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Basit health check
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Basit rate limit (dakikada 20 istek)
const requests = {};
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();

  if (!requests[ip]) {
    requests[ip] = [];
  }

  // Eski istekleri temizle
  requests[ip] = requests[ip].filter((t) => now - t < WINDOW_MS);

  if (requests[ip].length >= MAX_PER_WINDOW) {
    return res
      .status(429)
      .json({ error: "Too many requests, please try again later." });
  }

  requests[ip].push(now);
  next();
}

app.post("/api/cars/recommend", rateLimit, async (req, res) => {
  try {
    const prefs = req.body;

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
  },
  {
    "model": "Diğer model",
    "why": "Açıklama",
    "segment": "Segment"
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

    const content = openaiRes.data.choices[0].message.content;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.error("JSON parse error, model cevabı:", content);
      return res.status(500).json({ error: "Invalid JSON from OpenAI" });
    }

    res.json(parsed);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Server error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`Backend çalıştı: http://localhost:${port}`)
);
