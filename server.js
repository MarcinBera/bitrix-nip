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

app.post("/parse-email", async (req, res) => {
  console.log("=== /parse-email HIT ===");
  console.log("BODY:", JSON.stringify(req.body, null, 2));

  try {
    const activityId = req.body?.data?.FIELDS?.ID;
    console.log("BITRIX_WEBHOOK =", process.env.BITRIX_WEBHOOK);
    console.log("activityId =", activityId);
    console.log(
      "crm.activity.get URL =",
      `${process.env.BITRIX_WEBHOOK}crm.activity.get.json`,
    );
    if (!activityId) {
      return res.json({ ok: true, skipped: "no activity id" });
    }

    // 1. Pobierz pełną aktywność z Bitrix
    const activityResponse = await axios.post(
      `${process.env.BITRIX_WEBHOOK}crm.activity.get.json`,
      {
        id: activityId,
      },
    );

    const activity = activityResponse.data?.result;

    console.log("=== ACTIVITY ===");
    console.log(JSON.stringify(activity, null, 2));

    if (!activity) {
      return res.json({ ok: true, skipped: "activity not found" });
    }

    // 2. Bierzemy tylko e-mail
    if (String(activity.TYPE_ID) !== "4") {
      return res.json({ ok: true, skipped: "not email activity" });
    }

    const body = activity.DESCRIPTION || activity.DESCRIPTION_HTML || "";

    if (!body) {
      return res.json({ ok: true, skipped: "empty email body" });
    }

    // 3. Parser stopki — wersja oparta o kotwice (email/phone/www)
    const plainText = body
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/\r/g, "")
      .split("\n")
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    // odfiltrowanie śmieci
    const cleanedLines = plainText.filter((line) => {
      const lower = line.toLowerCase();

      if (!line) return false;
      if (lower.includes("nie zawiera wirusów")) return false;
      if (lower.includes("www.avast.com")) return false;
      if (lower.includes("polityka-prywatnosci")) return false;
      if (lower.includes("zasady przetwarzania danych")) return false;
      if (lower.includes("spółka zarejestrowana")) return false;
      if (lower.includes("kapitał zakładowy")) return false;
      if (lower.includes("obowiązkowe przeglądy")) return false;
      if (lower.includes("confidentiality notice")) return false;
      if (lower.includes("this email and any attachments")) return false;
      if (lower.includes("please consider the environment")) return false;

      return true;
    });

    function isEmailLine(line) {
      return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(line);
    }

    function isPhoneLine(line) {
      return /(\+?\d[\d\s().-]{7,}\d)/.test(line);
    }

    function isWebsiteLine(line) {
      return /\b(?:https?:\/\/)?(?:www\.)[a-z0-9.-]+\.[a-z]{2,}\b/i.test(line);
    }

    function looksLikeName(line) {
      if (!line) return false;
      if (isEmailLine(line)) return false;
      if (isPhoneLine(line)) return false;
      if (isWebsiteLine(line)) return false;
      if (/\d/.test(line)) return false;
      if (line.length < 4) return false;
      if (line.length > 80) return false;
      if (/[.,;:]/.test(line)) return false;

      const words = line.split(/\s+/).filter(Boolean);
      if (words.length < 2 || words.length > 5) return false;

      return words.every((w) =>
        /^[A-ZĄĆĘŁŃÓŚŹŻ][A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż'-]+$/.test(w),
      );
    }

    function looksLikeJobTitle(line) {
      if (!line) return false;
      if (isEmailLine(line)) return false;
      if (isPhoneLine(line)) return false;
      if (isWebsiteLine(line)) return false;
      if (/\b\d{2}-\d{3}\b/.test(line)) return false;
      if (line.length > 100) return false;

      const lower = line.toLowerCase();

      return (
        lower.includes("manager") ||
        lower.includes("director") ||
        lower.includes("specialist") ||
        lower.includes("sales") ||
        lower.includes("marketing") ||
        lower.includes("operations") ||
        lower.includes("procurement") ||
        lower.includes("strategic sourcing") ||
        lower.includes("dyrektor") ||
        lower.includes("kierownik") ||
        lower.includes("specjalista") ||
        lower.includes("menedżer") ||
        lower.includes("managerka") ||
        lower.includes("prezes") ||
        lower.includes("ceo") ||
        lower.includes("coo") ||
        lower.includes("cto")
      );
    }

    function looksLikeCompany(line) {
      if (!line) return false;
      if (isEmailLine(line)) return false;
      if (isPhoneLine(line)) return false;
      if (isWebsiteLine(line)) return false;
      if (/\b\d{2}-\d{3}\b/.test(line)) return false;
      if (line.length > 120) return false;

      const lower = line.toLowerCase();

      return (
        lower.includes("sp. z o.o") ||
        lower.includes("s.a.") ||
        lower.includes("llc") ||
        lower.includes("ltd") ||
        lower.includes("inc") ||
        lower.includes("gmbh") ||
        lower.includes("corp") ||
        lower.includes("company") ||
        lower.includes("robotics") ||
        lower.includes("logistics") ||
        lower.includes("solutions") ||
        lower.includes("systems") ||
        /^[A-Z0-9& .,'()/-]{4,}$/.test(line)
      );
    }

    // 1. znajdź kotwicę: email / phone / website
    let anchorIndex = -1;

    for (let i = cleanedLines.length - 1; i >= 0; i--) {
      const line = cleanedLines[i];
      if (isEmailLine(line) || isPhoneLine(line) || isWebsiteLine(line)) {
        anchorIndex = i;
        break;
      }
    }

    // jeśli nie ma kotwicy, bierz ostatnie linie
    const signatureLines =
      anchorIndex >= 0
        ? cleanedLines.slice(
            Math.max(0, anchorIndex - 4),
            Math.min(cleanedLines.length, anchorIndex + 4),
          )
        : cleanedLines.slice(-8);

    const signatureText = signatureLines.join("\n");

    // 2. pola kontaktowe
    const emailMatch = signatureText.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    );
    const phoneMatch = signatureText.match(/(\+?\d[\d\s().-]{7,}\d)/);
    const websiteMatch = signatureText.match(
      /\b(?:https?:\/\/)?(?:www\.)[a-z0-9.-]+\.[a-z]{2,}\b/i,
    );
    const postalCodeMatch = signatureText.match(/\b\d{2}-\d{3}\b/);

    const email = emailMatch ? emailMatch[0] : "";
    const phone = phoneMatch ? phoneMatch[0] : "";
    const website = websiteMatch ? websiteMatch[0] : "";

    // 3. imię i nazwisko: szukaj NAJBLIŻEJ NAD kotwicą
    let nameLine = "";
    for (let i = 0; i < signatureLines.length; i++) {
      if (looksLikeName(signatureLines[i])) {
        nameLine = signatureLines[i];
        break;
      }
    }

    const nameParts = nameLine.split(/\s+/).filter(Boolean);
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    // 4. stanowisko: linia po imieniu
    let jobTitle = "";
    if (nameLine) {
      const nameIndex = signatureLines.indexOf(nameLine);
      const nextLine = signatureLines[nameIndex + 1] || "";

      if (looksLikeJobTitle(nextLine)) {
        jobTitle = nextLine;
      }
    }

    // 5. firma: pierwsza sensowna linia po stanowisku albo po imieniu
    let companyName = "";
    if (nameLine) {
      const nameIndex = signatureLines.indexOf(nameLine);

      for (let i = nameIndex + 1; i < signatureLines.length; i++) {
        const line = signatureLines[i];

        if (!line) continue;
        if (line === jobTitle) continue;
        if (isEmailLine(line)) continue;
        if (isPhoneLine(line)) continue;
        if (isWebsiteLine(line)) continue;
        if (/\b\d{2}-\d{3}\b/.test(line)) continue;

        if (looksLikeCompany(line)) {
          companyName = line;
          break;
        }
      }
    }

    // 6. adres i miasto
    let address = "";
    let city = "";

    if (postalCodeMatch) {
      const postalCode = postalCodeMatch[0];

      for (const line of signatureLines) {
        if (line.includes(postalCode)) {
          address = line;

          const cityMatch = line.match(/\b\d{2}-\d{3}\s+(.+)$/);
          city = cityMatch ? cityMatch[1].trim() : "";
          break;
        }
      }
    }

    console.log("=== PARSED SIGNATURE ===");
    console.log({
      firstName,
      lastName,
      jobTitle,
      companyName,
      address,
      city,
      email,
      phone,
      website,
      signatureText,
    });

    // 4. Jeśli nie ma nawet maila i telefonu, to pomijamy
    if (!email && !phone) {
      return res.json({ ok: true, skipped: "no useful contact data" });
    }

    // 5. Sprawdzenie duplikatu po emailu
    let existingContacts = [];

    if (email) {
      const contactListResponse = await axios.post(
        `${process.env.BITRIX_WEBHOOK}crm.contact.list.json`,
        {
          filter: {
            EMAIL: email,
          },
          select: ["ID", "NAME", "LAST_NAME"],
        },
      );

      existingContacts = contactListResponse.data?.result || [];
    }

    if (existingContacts.length > 0) {
      return res.json({
        ok: true,
        duplicate: true,
        contactId: existingContacts[0].ID,
      });
    }

    // 6. Tworzenie kontaktu
    const addContactResponse = await axios.post(
      `${process.env.BITRIX_WEBHOOK}crm.contact.add.json`,
      {
        fields: {
          NAME: firstName || "Nieznane",
          LAST_NAME: lastName || "Kontakt z maila",
          POST: jobTitle || "",
          COMPANY_TITLE: companyName || "",
          ADDRESS: address || "",
          PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: "WORK" }] : [],
          EMAIL: email ? [{ VALUE: email, VALUE_TYPE: "WORK" }] : [],
          WEB: website ? [{ VALUE: website, VALUE_TYPE: "WORK" }] : [],
          COMMENTS:
            "Utworzone automatycznie ze stopki e-mail.\n\n" + signatureText,
        },
      },
    );

    const newContactId = addContactResponse.data?.result;

    return res.json({
      ok: true,
      created: true,
      contactId: newContactId,
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
