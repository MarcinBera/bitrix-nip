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

async function createCompanyInBitrix(data) {
  return await bx24Call("crm.company.add", {
    fields: {
      TITLE: data.name || "Nowa firma",
      ADDRESS: data.street || "",
      ADDRESS_CITY: data.city || "",
      ADDRESS_POSTAL_CODE: data.zip || "",
      ADDRESS_PROVINCE: data.voivodeship || "",
      ADDRESS_COUNTRY: data.country || "Polska",

      UF_CRM_NIP_APP_1681381570080: data.nip || "",
      UF_CRM_1624525497: data.nip || "",

      COMMENTS:
        `NIP: ${data.nip || "-"}\n` +
        `REGON: ${data.regon || "-"}\n` +
        `KRS: ${data.krs || "-"}\n` +
        `VAT: ${data.vatStatus || "-"}`
    }
  });
}

async function handleFetch() {
  try {
    const nipInput = document.getElementById("nipInput");
    const createBtn = document.getElementById("createCompanyBtn");

    const nip = cleanNip(nipInput ? nipInput.value : "");

    if (!nip || nip.length !== 10) {
      throw new Error("Wpisz poprawny 10-cyfrowy NIP.");
    }

    setStatus("Pobieram dane po NIP...", "");
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

    setStatus("Tworzę firmę w Bitrix24...", "");

    const companyId = await createCompanyInBitrix(window.lastFetchedData);

    setStatus(`Firma została utworzona. ID: ${companyId}`, "success");
    setDebug({
      createdCompanyId: companyId,
      data: window.lastFetchedData
    });
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Nie udało się utworzyć firmy.", "error");
  }
}

BX24.init(function () {
  const fetchBtn = document.getElementById("fetchBtn");
  const createCompanyBtn = document.getElementById("createCompanyBtn");

  if (fetchBtn) {
    fetchBtn.addEventListener("click", handleFetch);
  }

  if (createCompanyBtn) {
    createCompanyBtn.addEventListener("click", handleCreateCompany);
  }

  setStatus("Wpisz NIP i pobierz dane.", "");
});