require("dotenv").config();

const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/**
 * Prosty helper:
 * usuwa wszystko poza cyframi z NIP-u
 */
function cleanNip(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * UWAGA:
 * API REGON działa specyficznie i oficjalnie wymaga klucza + obsługi ich sposobu autoryzacji.
 * Ten kod poniżej ma przygotowaną strukturę endpointu backendowego.
 *
 * W miejscu getCompanyFromRegon() finalnie podłączysz prawdziwe wywołanie REGON.
 * Na start daję tryb DEMO, żebyś mógł uruchomić całość i zobaczyć integrację z Bitrix.
 */
async function getCompanyFromRegon(nip) {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const url = `https://wl-api.mf.gov.pl/api/search/nip/${nip}?date=${today}`;

    const response = await axios.get(url);

    const result = response.data?.result?.subject;

    if (!result) {
      throw new Error("Nie znaleziono firmy dla tego NIP.");
    }

    return {
      source: "mf",
      nip: result.nip,
      name: result.name,
      regon: result.regon,
      krs: result.krs,
      street: result.workingAddress,
      zip: "", // MF nie zawsze rozdziela
      city: "",
      voivodeship: "",
      country: "Polska",
      vatStatus: result.statusVat
    };

  } catch (error) {
    console.error("Błąd MF API:", error.message);

    throw new Error("Nie udało się pobrać danych z Ministerstwa Finansów.");
  }
}

/**
 * Strona instalacyjna aplikacji Bitrix
 */
app.get("/install", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "install.html"));
});

/**
 * Strona zakładki w karcie firmy
 */
app.all("/company-tab", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "company-tab.html"));
});

/**
 * Endpoint backendowy:
 * frontend z Bitrixa poda NIP,
 * backend zwróci dane firmy
 */
app.post("/api/company-by-nip", async (req, res) => {
  try {
    const nip = cleanNip(req.body.nip);

    if (!nip || nip.length !== 10) {
      return res.status(400).json({
        ok: false,
        message: "NIP musi mieć dokładnie 10 cyfr."
      });
    }

    const data = await getCompanyFromRegon(nip);

    return res.json({
      ok: true,
      data
    });
  } catch (error) {
    console.error("Błąd /api/company-by-nip:", error.message);

    return res.status(500).json({
      ok: false,
      message: error.message || "Wewnętrzny błąd serwera."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});