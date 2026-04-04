function setStatus(message, type = "") {
  const el = document.getElementById("status");
  if (!el) return;
  el.className = type;
  el.textContent = message;
}

function setDebug(value) {
  const debug = document.getElementById("debug");
  if (!debug) return;
  debug.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function cleanNip(value) {
  return String(value || "").replace(/\D/g, "");
}

function bx24Call(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (typeof BX24 === "undefined" || !BX24.callMethod) {
      reject(new Error("BX24 nie jest dostępny."));
      return;
    }

    BX24.callMethod(method, params, function (result) {
      if (result.error()) {
        reject(new Error(result.error()));
      } else {
        resolve(result.data());
      }
    });
  });
}

async function fetchCompanyByNip(nip) {
  const response = await fetch("/api/company-by-nip", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ nip }),
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.message || "Nie udało się pobrać danych z backendu.");
  }

  return data.data;
}

function renderPreview(data) {
  const previewBox = document.getElementById("previewBox");
  const previewContent = document.getElementById("previewContent");

  if (!previewBox || !previewContent) return;

  previewContent.innerHTML = `
    <div class="preview-label">Nazwa firmy</div><div>${data.name || "-"}</div>
    <div class="preview-label">NIP</div><div>${data.nip || "-"}</div>
    <div class="preview-label">REGON</div><div>${data.regon || "-"}</div>
    <div class="preview-label">KRS</div><div>${data.krs || "-"}</div>
    <div class="preview-label">Adres</div><div>${data.street || "-"}</div>
    <div class="preview-label">Kod pocztowy</div><div>${data.zip || "-"}</div>
    <div class="preview-label">Miasto</div><div>${data.city || "-"}</div>
    <div class="preview-label">Województwo</div><div>${data.voivodeship || "-"}</div>
    <div class="preview-label">Kraj</div><div>${data.country || "-"}</div>
    <div class="preview-label">Status VAT</div><div>${data.vatStatus || "-"}</div>
  `;

  previewBox.style.display = "block";
}

function mapVoivodeshipToBitrixValue(name) {
  const map = {
    dolnośląskie: 398,
    "kujawsko-pomorskie": 418,
    lubelskie: 406,
    lubuskie: 396,
    łódzkie: 412,
    małopolskie: 408,
    mazowieckie: 414,
    opolskie: 400,
    podkarpackie: 410,
    podlaskie: 416,
    pomorskie: 420,
    śląskie: 402,
    świętokrzyskie: 404,
    "warmińsko-mazurskie": 392,
    wielkopolskie: 390,
    zachodniopomorskie: 394,
  };

  return map[String(name || "").toLowerCase()] || "";
}

async function findCompanyByNip(nip) {
  const result = await bx24Call("crm.company.list", {
    filter: {
      UF_CRM_NIP_APP_1681381570080: nip,
    },
    select: ["ID", "TITLE"],
  });

  return result && result.length > 0 ? result[0] : null;
}

async function createCompanyInBitrix(data) {
  // 🔍 sprawdź czy firma już istnieje
  let existing = await findCompanyByNip(data.nip);

  // fallback na drugie pole NIP (jeśli masz dwa)
  if (!existing) {
    const result = await bx24Call("crm.company.list", {
      filter: {
        UF_CRM_1624525497: data.nip,
      },
      select: ["ID", "TITLE"],
    });

    existing = result && result.length > 0 ? result[0] : null;
  }

  if (existing) {
    return {
      duplicate: true,
      companyId: existing.ID,
      name: existing.TITLE,
    };
  }

  // 🔥 mapowanie województwa (to co już masz)
  const voivodeshipValue = mapVoivodeshipToBitrixValue(data.voivodeship);

  // ➕ tworzenie firmy
  const newId = await bx24Call("crm.company.add", {
    fields: {
      TITLE: data.name || "Nowa firma",
      ADDRESS: data.street || "",
      ADDRESS_CITY: data.city || "",
      ADDRESS_POSTAL_CODE: data.zip || "",
      ADDRESS_COUNTRY: data.country || "Polska",

      UF_CRM_1643968306252: voivodeshipValue,

      UF_CRM_NIP_APP_1681381570080: data.nip || "",
      UF_CRM_1624525497: data.nip || "",

      COMMENTS:
        `NIP: ${data.nip || "-"}\n` +
        `REGON: ${data.regon || "-"}\n` +
        `KRS: ${data.krs || "-"}\n` +
        `VAT: ${data.vatStatus || "-"}`,
    },
  });

  return {
    duplicate: false,
    companyId: newId,
  };
}

async function handleFetch() {
  try {
    const nipInput = document.getElementById("nipInput");
    const createBtn = document.getElementById("createCompanyBtn");

    const nip = cleanNip(nipInput ? nipInput.value : "");

    if (!nip || nip.length !== 10) {
      throw new Error("Wpisz poprawny 10-cyfrowy NIP.");
    }

    setStatus("Pobieram dane po NIP...");
    setDebug("");

    const data = await fetchCompanyByNip(nip);

    window.lastFetchedData = data;

    renderPreview(data);
    setDebug(data);

    if (createBtn) {
      createBtn.disabled = false;
    }

    setStatus("Dane pobrane poprawnie.", "success");
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Wystąpił błąd.", "error");
  }
}

async function handleCreateCompany() {
  try {
    if (!window.lastFetchedData) {
      throw new Error("Najpierw pobierz dane z NIP.");
    }

    setStatus("Tworzę firmę w Bitrix24...");

    const result = await createCompanyInBitrix(window.lastFetchedData);

    if (result.duplicate) {
      setStatus(
        `Firma już istnieje: ${result.name} (ID: ${result.companyId})`,
        "error"
      );

      setDebug({
        duplicate: true,
        companyId: result.companyId,
        name: result.name,
        data: window.lastFetchedData
      });

      return;
    }

    setStatus(`Firma została utworzona. ID: ${result.companyId}`, "success");

    setDebug({
      duplicate: false,
      createdCompanyId: result.companyId,
      data: window.lastFetchedData
    });
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Nie udało się utworzyć firmy.", "error");
  }
}

function initApp() {
  const fetchBtn = document.getElementById("fetchBtn");
  const createCompanyBtn = document.getElementById("createCompanyBtn");

  if (fetchBtn) {
    fetchBtn.addEventListener("click", handleFetch);
  }

  if (createCompanyBtn) {
    createCompanyBtn.addEventListener("click", handleCreateCompany);
  }

  setStatus("Wpisz NIP i pobierz dane.");
}

// NA LOCALHOST uruchamiamy od razu.
// W BITRIXIE próbujemy przez BX24.init, ale z fallbackiem.
document.addEventListener("DOMContentLoaded", function () {
  initApp();

  if (typeof BX24 !== "undefined" && BX24.init) {
    try {
      BX24.init(function () {
        console.log("BX24.init OK");
      });
    } catch (e) {
      console.log("BX24.init pominięte:", e);
    }
  }
});
