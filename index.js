// 🚀 ARAÇ ÖNERİ ENDPOINTİ (TOKEN ZORUNLU)
app.post(
  "/api/cars/recommend",
  rateLimit,
  requireFirebaseAuth,
  async (req, res) => {
    try {
      const prefs = req.body;
      const userId = req.user.uid; // ✅ TOKEN'DAN

      // ✅ Önce kredi düş (OpenAI çağrısından önce)
      const creditResult = decreaseCredit(userId);
      if (!creditResult.ok) {
        return res.status(403).json({
          error: creditResult.code,
          message: creditResult.message,
        });
      }

      const prompt = `
Sen bir araç danışmanısın...
( BURASI AYNI – DOKUNMA )
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

      const content = openaiRes.data.choices[0].message.content.trim();

      let jsonText = content;
      const firstBracket = content.indexOf("[");
      const lastBracket = content.lastIndexOf("]");

      if (firstBracket !== -1 && lastBracket !== -1) {
        jsonText = content.slice(firstBracket, lastBracket + 1);
      }

      let parsed;
      try {
        parsed = JSON.parse(jsonText);
      } catch (e) {
        // ❗ JSON bozulursa krediyi geri ver
        addCredits(userId, 1);
        return res.status(500).json({ error: "Invalid JSON from OpenAI" });
      }

      console.log(
        `Kullanıcı ${userId} öneri aldı. Kalan hak: ${creditResult.remaining}`
      );

      res.json(parsed);
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: "Server error" });
    }
  }
);
