import { DONORS } from "../data/donors.js";

const DISMISSED_KEY = "colevana:donation-prompt-dismissed-at";
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;
const ROTATE_MS = 8000;

function readTimestamp(key) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeTimestamp(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // El aviso sigue siendo cerrable aunque el navegador bloquee el almacenamiento.
  }
}

const now = Date.now();
if (document.body?.dataset.page !== "aportes" && now - readTimestamp(DISMISSED_KEY) >= DISMISS_MS) {
  const prompt = document.createElement("aside");
  prompt.className = "donation-prompt";
  prompt.setAttribute("aria-label", "Apoya a Colevana y conoce los aportes recientes");
  prompt.innerHTML = `
    <button class="donation-prompt-close" type="button" aria-label="Cerrar aviso de donación">&times;</button>
    <div class="donation-prompt-view donation-prompt-qr-view">
      <img class="donation-prompt-qr" src="./assets/donations/donation-qr.jpg" alt="Código QR para realizar una donación voluntaria">
      <div class="donation-prompt-copy">
        <p class="donation-prompt-eyebrow">Apoya a Colevana</p>
        <h2>¿Te gusta la página?</h2>
        <p>Si quieres, puedes apoyarnos con una donación voluntaria. ¡Gracias por estar aquí!</p>
      </div>
    </div>
    <div class="donation-prompt-view donation-prompt-donor-view" role="status" aria-live="polite" aria-atomic="true" hidden>
      <span class="donation-prompt-donor-badge" aria-hidden="true">♥</span>
      <div class="donation-prompt-copy">
        <p class="donation-prompt-eyebrow">Aporte reciente</p>
        <h2 class="donation-prompt-donor-name"></h2>
        <p class="donation-prompt-donor-amount"></p>
        <p>¡Gracias por apoyar a Colevana!</p>
      </div>
    </div>
  `;

  const donorRecords = DONORS
    .filter((donor) => donor && typeof donor.name === "string" && donor.name.trim()
      && Number.isFinite(Number(donor.amount)) && Number(donor.amount) >= 0)
    .slice()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const qrView = prompt.querySelector(".donation-prompt-qr-view");
  const donorView = prompt.querySelector(".donation-prompt-donor-view");
  const donorName = prompt.querySelector(".donation-prompt-donor-name");
  const donorAmount = prompt.querySelector(".donation-prompt-donor-amount");
  let rotationTimer = null;

  const showDonor = (donor) => {
    let amount;
    try {
      amount = new Intl.NumberFormat("es-CO", {
        style: "currency",
        currency: donor.currency || "COP",
        maximumFractionDigits: 2,
      }).format(Number(donor.amount));
    } catch {
      amount = `${donor.currency || "COP"} ${Number(donor.amount).toLocaleString("es-CO")}`;
    }
    donorName.textContent = donor.name.trim();
    donorAmount.textContent = amount;
    qrView.hidden = true;
    donorView.hidden = false;
    prompt.classList.add("is-donor-notification");
  };

  const showQr = () => {
    donorView.hidden = true;
    qrView.hidden = false;
    prompt.classList.remove("is-donor-notification");
  };

  const close = () => {
    if (rotationTimer !== null) window.clearInterval(rotationTimer);
    prompt.remove();
    writeTimestamp(DISMISSED_KEY, Date.now());
  };
  prompt.querySelector(".donation-prompt-close").addEventListener("click", close);
  document.body.append(prompt);

  if (donorRecords.length) {
    let donorIndex = 0;
    let showingDonor = false;
    rotationTimer = window.setInterval(() => {
      if (prompt.isConnected === false || document.hidden) return;
      if (showingDonor) {
        showQr();
      } else {
        showDonor(donorRecords[donorIndex % donorRecords.length]);
        donorIndex += 1;
      }
      showingDonor = !showingDonor;
    }, ROTATE_MS);
  }
}
