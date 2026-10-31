const DISMISSED_KEY = "colevana:donation-prompt-dismissed-at";
const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

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
  prompt.setAttribute("aria-labelledby", "donationPromptTitle");
  prompt.innerHTML = `
    <button class="donation-prompt-close" type="button" aria-label="Cerrar aviso de donación">&times;</button>
    <img class="donation-prompt-qr" src="./assets/donations/donation-qr.jpg" alt="Código QR para realizar una donación voluntaria">
    <div class="donation-prompt-copy">
      <p class="donation-prompt-eyebrow">Apoya a Colevana</p>
      <h2 id="donationPromptTitle">¿Te gusta la página?</h2>
      <p>Si quieres, puedes apoyarnos con una donación voluntaria. ¡Gracias por estar aquí!</p>
    </div>
  `;

  const close = () => {
    prompt.remove();
    writeTimestamp(DISMISSED_KEY, Date.now());
  };
  prompt.querySelector(".donation-prompt-close").addEventListener("click", close);
  document.body.append(prompt);
}
