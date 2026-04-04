require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

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

app.post("/parse-email", async (req, res) => {
  try {
    // const { body } = req.body;
    const activity = req.body.data?.FIELDS;

    if (!activity || activity.TYPE_ID !== "4") {
      return res.json({ skip: true }); // nie mail
    }

    const body = activity.DESCRIPTION || "";

    if (!body) {
      return res.status(400).json({ error: "Brak body maila" });
    }

    // 🔥 PROSTY PARSER
    const emailMatch = body.match(/[\w.-]+@[\w.-]+\.\w+/);
    const phoneMatch = body.match(/(\+?\d[\d\s-]{7,})/);

    const nameMatch = body.split("\n")[0]; // pierwsza linia jako imię

    const email = emailMatch ? emailMatch[0] : "";
    const phone = phoneMatch ? phoneMatch[0] : "";
    const name = nameMatch || "Nowy kontakt";

    // 🔥 TWORZENIE KONTAKTU
    const response = await fetch(
      `${process.env.BITRIX_WEBHOOK}crm.contact.add`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            NAME: name,
            PHONE: [{ VALUE: phone, VALUE_TYPE: "WORK" }],
            EMAIL: [{ VALUE: email, VALUE_TYPE: "WORK" }],
            COMMENTS: body,
          },
        }),
      },
    );

    const data = await response.json();

    res.json({ success: true, contactId: data.result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Błąd parsera maila" });
  }
});
