function setStatus(message, type = "") {
  const el = document.getElementById("status");
  el.className = type;
  el.textContent = message;
}

function setDebug(value) {
  const debug = document.getElementById("debug");
  debug.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function cleanNip(value) {
  return String(value || "").replace(/\D/g, "");
}

function bx24Call(method, params = {}) {
  return new Promise((resolve, reject) => {
    BX24.callMethod(method, params, function(result) {
      if (result.error()) {
        reject(new Error(result.error()));
      } else {
        resolve(result.data());
      }
    });
  });
}

async function getCurrentCompanyId() {
  const placementInfo = BX24.placement.info();
  const options = placementInfo.options || {};
  return options.ID || null;
}

async function getCompany(companyId) {
  return await bx24Call("crm.company.get", { id: companyId });
}

async function updateCompany(companyId, fields) {
  return await bx24Call("crm.company.update", {
    id: companyId,
    fields
  });
}

async function fetchCompanyByNip(nip) {
  const response = await fetch("/api/company-by-nip", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ nip })
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.message || "Nie udało się pobrać danych z backendu.");
  }

  return data.data;
}

async function run() {
  try {
    setStatus("Inicjalizacja...");
    const companyId = await getCurrentCompanyId();

    if (!companyId) {
      throw new Error("Nie udało się odczytać ID firmy z kontekstu Bitrix24.");
    }

    setStatus("Pobieram dane bieżącej firmy z Bitrix24...");
    const company = await getCompany(companyId);
    setDebug({ companyId, company });

    // Najczęściej NIP siedzi w polu UF_CRM_* albo w standardowym polu,
    // zależnie od konfiguracji portalu.
    // Na start sprawdzamy kilka typowych miejsc.
    const possibleNip =
      company.UF_CRM_NIP ||
      company.UF_CRM_1680000000 || // placeholder, jeśli kiedyś zrobisz własne pole
      company.REQUISITE_INN ||
      company.INN ||
      "";

    const nip = cleanNip(possibleNip);

    if (!nip) {
      throw new Error(
        "Ta firma nie ma odczytanego NIP-u w polu, które sprawdzamy. Najpierw upewnij się, gdzie dokładnie Bitrix przechowuje NIP."
      );
    }

    setStatus("Pobieram dane po NIP: " + nip + " ...");
    const regonData = await fetchCompanyByNip(nip);
    setDebug({ companyId, company, regonData });

    // Mapowanie danych do pól Bitrix
    const fieldsToUpdate = {
      TITLE: regonData.name || company.TITLE,
      ADDRESS: regonData.street || "",
      ADDRESS_CITY: regonData.city || "",
      ADDRESS_POSTAL_CODE: regonData.zip || "",
      ADDRESS_COUNTRY: regonData.country || "Polska",
      COMMENTS:
        "Dane uzupełnione z NIP.\n" +
        `REGON: ${regonData.regon || "-"}\n` +
        `KRS: ${regonData.krs || "-"}\n` +
        `Województwo: ${regonData.voivodeship || "-"}`
    };

    await updateCompany(companyId, fieldsToUpdate);

    setStatus("Gotowe. Dane firmy zostały zaktualizowane.", "success");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Wystąpił błąd.", "error");
  }
}

document.getElementById("fetchBtn").addEventListener("click", run);

BX24.init(function () {
  setStatus("Zakładka gotowa. Kliknij przycisk.");
});