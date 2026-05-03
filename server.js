require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));


const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function cleanNip(value) {
  return String(value || "").replace(/\D/g, "");
}

function extractPostalCode(address) {
  if (!address) return "";
  const match = String(address).match(/\b\d{2}-\d{3}\b/);
  return match ? match[0] : "";
}

function getVoivodeshipFromPostalCode(postalCode) {
  const firstDigit = String(postalCode || "").trim()[0];

  const map = {
    0: "mazowieckie",
    1: "mazowieckie",
    2: "lubelskie",
    3: "małopolskie",
    4: "śląskie",
    5: "dolnośląskie",
    6: "wielkopolskie",
    7: "zachodniopomorskie",
    8: "pomorskie",
    9: "łódzkie",
  };

  return map[firstDigit] || "";
}

async function getCompanyByNip(nip) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const url = `https://wl-api.mf.gov.pl/api/search/nip/${nip}?date=${today}`;

    const response = await axios.get(url, {
      timeout: 15000,
    });

    const subject = response.data?.result?.subject;

    if (!subject) {
      throw new Error("Nie znaleziono firmy dla tego NIP.");
    }

    const fullAddress =
      subject.workingAddress || subject.residenceAddress || "";
    const postalCode = extractPostalCode(fullAddress);
    const voivodeship = getVoivodeshipFromPostalCode(postalCode);

    return {
      source: "mf",
      nip: subject.nip || nip,
      name: subject.name || "",
      regon: subject.regon || "",
      krs: subject.krs || "",
      street: fullAddress,
      zip: postalCode,
      city: "",
      voivodeship,
      country: "Polska",
      vatStatus: subject.statusVat || "",
    };
  } catch (error) {
    console.error("Błąd MF API:", error.response?.data || error.message);
    throw new Error("Nie udało się pobrać danych z Ministerstwa Finansów.");
  }
}

app.get("/", (req, res) => {
  res.send(`
    <h1>Serwer działa</h1>
    <p>Wejdź na:</p>
    <ul>
      <li><a href="/install">/install</a></li>
      <li><a href="/company-tab">/company-tab</a></li>
    </ul>
  `);
});

app.all("/install", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "install.html"));
});

app.all("/company-tab", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "company-tab.html"));
});

app.post("/api/company-by-nip", async (req, res) => {
  try {
    const nip = cleanNip(req.body.nip);

    if (!nip || nip.length !== 10) {
      return res.status(400).json({
        ok: false,
        message: "NIP musi mieć dokładnie 10 cyfr.",
      });
    }

    const data = await getCompanyByNip(nip);

    return res.json({
      ok: true,
      data,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error.message || "Wewnętrzny błąd serwera.",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Serwer działa na porcie ${PORT}`);
});

function extractEmail(str = "") {
  const match = String(str).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : "";
}

async function parseSignatureWithAI({ text, senderEmail }) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "email_signature_parser",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            is_signature: { type: "boolean" },
            confidence: { type: "number" },
            firstName: { type: "string" },
            lastName: { type: "string" },
            jobTitle: { type: "string" },
            companyName: { type: "string" },
            address: { type: "string" },
            city: { type: "string" },
            regionBranch: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" },
            website: { type: "string" }
          },
          required: [
            "is_signature",
            "confidence",
            "firstName",
            "lastName",
            "jobTitle",
            "companyName",
            "address",
            "city",
            "regionBranch",
            "email",
            "phone",
            "website"
          ]
        }
      }
    },
    messages: [
      {
        role: "system",
        content:
          "Jesteś parserem stopek e-mail. Zwracasz wyłącznie dane kontaktowe nadawcy. Ignoruj treść wiadomości, cytaty, disclaimery, reklamy i stopki antywirusowe. Nie zgaduj pól, jeśli ich nie ma."
      },
      {
        role: "user",
        content:
          `Email nadawcy z systemu: ${senderEmail || ""}\n\n` +
          "Poniżej jest końcówka wiadomości e-mail. Znajdź stopkę nadawcy i wyodrębnij dane. Jeśli email nie występuje w stopce, użyj emaila nadawcy z systemu. Nie używaj emaili odbiorców.\n\n" +
          text
      }
    ]
  });

  return JSON.parse(response.choices[0].message.content);
}

async function bitrixPost(method, payload) {
  const response = await axios.post(
    `${process.env.BITRIX_WEBHOOK}${method}.json`,
    payload
  );

  return response.data?.result;
}

async function findOrCreateCompanyByName(companyName) {
  if (!companyName) return null;

  const existingCompanies = await bitrixPost("crm.company.list", {
    filter: {
      TITLE: companyName,
    },
    select: ["ID", "TITLE"],
  });

  if (existingCompanies && existingCompanies.length > 0) {
    return existingCompanies[0].ID;
  }

  const newCompanyId = await bitrixPost("crm.company.add", {
    fields: {
      TITLE: companyName,
    },
  });

  return newCompanyId;
}

app.post("/parse-email", async (req, res) => {
  console.log("=== /parse-email HIT ===");
  console.log("BODY:", JSON.stringify(req.body, null, 2));

  try {
    const activityId = req.body?.data?.FIELDS?.ID;

    console.log("BITRIX_WEBHOOK =", process.env.BITRIX_WEBHOOK);
    console.log("activityId =", activityId);

    if (!activityId) {
      return res.json({ ok: true, skipped: "no activity id" });
    }

    const activity = await bitrixPost("crm.activity.get", {
      id: activityId,
    });

    console.log("=== ACTIVITY ===");
    console.log(JSON.stringify(activity, null, 2));

    if (!activity) {
      return res.json({ ok: true, skipped: "activity not found" });
    }

    if (String(activity.TYPE_ID) !== "4") {
      return res.json({ ok: true, skipped: "not email activity" });
    }

    const body = activity.DESCRIPTION || activity.DESCRIPTION_HTML || "";

    if (!body) {
      return res.json({ ok: true, skipped: "empty email body" });
    }

    const emailMeta = activity.SETTINGS?.EMAIL_META || {};

    const senderEmail =
      extractEmail(emailMeta.replyTo || "") ||
      extractEmail(emailMeta.from || "") ||
      emailMeta.__email ||
      "";

    const plainText = body
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const textForAI = plainText.slice(-4000);

    const aiParsed = await parseSignatureWithAI({
      text: textForAI,
      senderEmail,
    });

    console.log("=== AI PARSED SIGNATURE ===");
    console.log(aiParsed);

    if (!aiParsed.is_signature || aiParsed.confidence < 0.55) {
      return res.json({
        ok: true,
        skipped: "low confidence",
        aiParsed,
      });
    }

    const finalEmail = aiParsed.email || senderEmail || "";

    if (!finalEmail && !aiParsed.phone) {
      return res.json({
        ok: true,
        skipped: "no useful contact data",
        aiParsed,
      });
    }

    let existingContacts = [];

    if (finalEmail) {
      existingContacts = await bitrixPost("crm.contact.list", {
        filter: {
          EMAIL: finalEmail,
        },
        select: ["ID", "NAME", "LAST_NAME"],
      });
    }

    if (existingContacts && existingContacts.length > 0) {
      return res.json({
        ok: true,
        duplicate: true,
        contactId: existingContacts[0].ID,
        aiParsed,
      });
    }

    let companyId = null;

    if (aiParsed.companyName) {
      companyId = await findOrCreateCompanyByName(aiParsed.companyName);
    }

    const newContactId = await bitrixPost("crm.contact.add", {
      fields: {
        NAME: aiParsed.firstName || "Nieznane",
        LAST_NAME: aiParsed.lastName || "Kontakt z maila",
        POST: aiParsed.jobTitle || "",
        COMPANY_ID: companyId || null,
        ADDRESS: aiParsed.address || "",
        ADDRESS_CITY: aiParsed.city || "",
        PHONE: aiParsed.phone
          ? [{ VALUE: aiParsed.phone, VALUE_TYPE: "WORK" }]
          : [],
        EMAIL: finalEmail
          ? [{ VALUE: finalEmail, VALUE_TYPE: "WORK" }]
          : [],
        WEB: aiParsed.website
          ? [{ VALUE: aiParsed.website, VALUE_TYPE: "WORK" }]
          : [],
        COMMENTS:
          "Utworzone automatycznie przez AI ze stopki e-mail.\n\n" +
          "Confidence: " +
          aiParsed.confidence +
          "\n\n" +
          textForAI,
      },
    });

    return res.json({
      ok: true,
      created: true,
      contactId: newContactId,
      aiParsed,
    });
  } catch (err) {
    console.error("parse-email error:", err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});

// app.post("/parse-email", async (req, res) => {
//   console.log("=== /parse-email HIT ===");
//   console.log("BODY:", JSON.stringify(req.body, null, 2));
//   try {
//     // const { body } = req.body;
//     const activity = req.body.data?.FIELDS;

//     if (!activity || activity.TYPE_ID !== "4") {
//       return res.json({ skip: true }); // nie mail
//     }

//     const body = activity.DESCRIPTION || "";

//     if (!body) {
//       return res.status(400).json({ error: "Brak body maila" });
//     }

//     // PROSTY PARSER
//     const emailMatch = body.match(/[\w.-]+@[\w.-]+\.\w+/);
//     const phoneMatch = body.match(/(\+?\d[\d\s-]{7,})/);

//     const nameMatch = body.split("\n")[0]; // pierwsza linia jako imię

//     const email = emailMatch ? emailMatch[0] : "";
//     const phone = phoneMatch ? phoneMatch[0] : "";
//     const name = nameMatch || "Nowy kontakt";

//     // TWORZENIE KONTAKTU
//     const response = await fetch(
//       `${process.env.BITRIX_WEBHOOK}crm.contact.add`,
//       {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({
//           fields: {
//             NAME: name,
//             PHONE: [{ VALUE: phone, VALUE_TYPE: "WORK" }],
//             EMAIL: [{ VALUE: email, VALUE_TYPE: "WORK" }],
//             COMMENTS: body,
//           },
//         }),
//       },
//     );

//     const data = await response.json();

//     res.json({ success: true, contactId: data.result });
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Błąd parsera maila" });
//   }
// });
