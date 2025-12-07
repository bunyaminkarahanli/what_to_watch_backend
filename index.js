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

// Rate limit (dakikada 20 istek)
const requests = {};
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();

  if (!requests[ip]) {
    requests[ip] = [];
  }

  requests[ip] = requests[ip].filter((t) => now - t < WINDOW_MS);

  if (requests[ip].length >= MAX_PER_WINDOW) {
    return res.status(429).json({ error: "Too many requests, please try again later." });
  }

  requests[ip].push(now);
  next();
}

app.post("/api/cars/recommend", rateLimit, async (req, res) => {
  try {
    const prefs = req.body;

    const prompt = `
Sen bir araç danışmanısın. Görevin, kullanıcının verdiği bilgilere göre ona uygun araç segmentini ve 3–5 adet model önerisini sunmaktır.

Kurallar:
- Türkiye’deki güncel fiyatları bilmiyorsun. Kesinlikle FİYAT bilgisi verme.
- Sadece genel tavsiye ver.
- Önerilerin JSON formatında olacak.

Kullanıcının cevapları:
${JSON.stringify(prefs, null, 2)}

JSON formatında şöyle dön:
[
  { "model": "Araç", "why": "Neden önerildi", "segment": "Segment" }
]
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
    const parsed = JSON.parse(content);

    res.json(parsed);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Server error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Backend çalıştı: http://localhost:${port}`));
