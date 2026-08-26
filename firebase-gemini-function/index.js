const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_TEST_ACCESS_TOKEN = defineSecret("GEMINI_TEST_ACCESS_TOKEN");

const MODEL = "gemini-3.5-flash-lite";
const DAILY_TEST_LIMIT = 20;
const ALLOWED_ORIGIN = "https://yutintinmarco.github.io";
const MAX_BASE64_CHARS = 3_500_000;

function hkDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function setCors(req, res) {
  const origin = req.get("origin");
  if (origin === ALLOWED_ORIGIN) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Price-Tracker-Test-Token");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function fail(res, status, error) {
  return res.status(status).json({ error });
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    product_name: { type: ["STRING", "NULL"] },
    brand: { type: ["STRING", "NULL"] },
    pack_size: { type: ["STRING", "NULL"] },
    current_price: { type: ["NUMBER", "NULL"] },
    original_price: { type: ["NUMBER", "NULL"] },
    member_price: { type: ["NUMBER", "NULL"] },
    multi_buy: { type: ["STRING", "NULL"] },
    promotion: { type: ["STRING", "NULL"] },
    confidence: { type: ["NUMBER", "NULL"] },
    notes: { type: ["STRING", "NULL"] },
  },
  required: [
    "product_name",
    "brand",
    "pack_size",
    "current_price",
    "original_price",
    "member_price",
    "multi_buy",
    "promotion",
    "confidence",
    "notes",
  ],
};

exports.geminiPriceTagTest = onRequest(
  {
    region: "asia-east2",
    timeoutSeconds: 60,
    memory: "256MiB",
    maxInstances: 1,
    secrets: [GEMINI_API_KEY, GEMINI_TEST_ACCESS_TOKEN],
  },
  async (req, res) => {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return fail(res, 405, "POST only");
    if (req.get("origin") !== ALLOWED_ORIGIN) return fail(res, 403, "Origin not allowed");

    const suppliedToken = req.get("X-Price-Tracker-Test-Token") || "";
    if (!suppliedToken || suppliedToken !== GEMINI_TEST_ACCESS_TOKEN.value()) {
      return fail(res, 401, "Invalid test access token");
    }

    const requestId = String(req.body?.requestId || "").trim();
    const mimeType = String(req.body?.image?.mimeType || "");
    const base64 = String(req.body?.image?.base64 || "");

    if (!/^[a-zA-Z0-9-]{16,100}$/.test(requestId)) return fail(res, 400, "Invalid requestId");
    if (!/^image\/(jpeg|png|webp)$/.test(mimeType)) return fail(res, 400, "Unsupported image type");
    if (!base64 || base64.length > MAX_BASE64_CHARS) return fail(res, 413, "Image too large");

    const dateKey = hkDateKey();
    const usageRef = db.collection("systemUsage").doc(`gemini-test-${dateKey}`);

    try {
      const reservation = await db.runTransaction(async (tx) => {
        const snap = await tx.get(usageRef);
        const data = snap.exists ? snap.data() : {};
        const count = Number(data.count || 0);
        const ids = data.requestIds || {};

        if (ids[requestId]) return { duplicate: true, count };
        if (count >= DAILY_TEST_LIMIT) return { capped: true, count };

        tx.set(
          usageRef,
          {
            date: dateKey,
            count: count + 1,
            requestIds: { ...ids, [requestId]: true },
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        return { reserved: true, count: count + 1 };
      });

      if (reservation.duplicate) return fail(res, 409, "Duplicate requestId rejected");
      if (reservation.capped) return fail(res, 429, `Daily test cap reached: ${DAILY_TEST_LIMIT}`);

      const prompt = [
        "Read this retail price tag carefully and return only structured data.",
        "Do not guess. If a field is not clearly supported by the image, return null.",
        "Pay special attention to typography where cents may be superscript, original prices may be struck through, and member or multi-buy prices may coexist.",
        "current_price means the ordinary current selling price for one purchasable unit unless the tag clearly shows only a member or multi-buy offer.",
        "Preserve product and promotion wording in the language shown on the tag.",
        "confidence must be between 0 and 1 and should reflect the weakest important extracted field, especially price.",
      ].join("\n");

      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY.value())}`;
      const geminiResponse = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                { inlineData: { mimeType, data: base64 } },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: RESPONSE_SCHEMA,
            maxOutputTokens: 400,
          },
        }),
      });

      const raw = await geminiResponse.json();
      if (!geminiResponse.ok) {
        console.error("Gemini API error", geminiResponse.status, raw?.error?.message || raw);
        return fail(res, 502, `Gemini API error: ${raw?.error?.message || geminiResponse.status}`);
      }

      const text = raw?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (!text) return fail(res, 502, "Gemini returned no structured text");

      let result;
      try {
        result = JSON.parse(text);
      } catch {
        console.error("Gemini returned invalid JSON", text);
        return fail(res, 502, "Gemini returned invalid JSON");
      }

      return res.status(200).json({
        model: MODEL,
        requestId,
        result,
        usage: { count: reservation.count, limit: DAILY_TEST_LIMIT, date: dateKey },
      });
    } catch (error) {
      console.error("geminiPriceTagTest failed", error);
      return fail(res, 500, "Server error. No automatic retry was attempted.");
    }
  },
);
