import { getKickSession, initKickAuthUI, COMMUNITY_API, communityAuthHeaders } from "./shared/kick-auth-ui.js";

const suggestionForm = document.getElementById("suggestionForm");
const suggestionLoginHint = document.getElementById("suggestionLoginHint");
const suggestionInput = document.getElementById("suggestionInput");
const suggestionSubmitBtn = document.getElementById("suggestionSubmitBtn");
const suggestionList = document.getElementById("suggestionList");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : str;
  return div.innerHTML;
}

// Admins (ADMIN_USERS del Worker) ven botones para borrar sugerencias. El
// Worker vuelve a comprobar la sesion firmada en cada borrado.
let isAdmin = false;

async function refreshAdmin(session = getKickSession()) {
  isAdmin = false;
  if (session) {
    try {
      const res = await fetch(`${COMMUNITY_API}/community/me`, { headers: communityAuthHeaders(session) });
      if (res.ok) isAdmin = Boolean((await res.json()).admin);
    } catch { /* sin admin */ }
  }
  adminBar.hidden = !isAdmin;
}

const adminBar = document.createElement("div");
adminBar.className = "suggestion-admin-bar";
adminBar.hidden = true;
adminBar.innerHTML = '<span>Modo administrador</span><button type="button" class="suggestion-delete-all">Borrar todas</button>';
suggestionList.before(adminBar);

async function deleteSuggestions(query, question) {
  if (!window.confirm(question)) return;
  try {
    const res = await fetch(`${COMMUNITY_API}/community/suggestions?${query}`, {
      method: "DELETE",
      headers: communityAuthHeaders(),
    });
    if (!res.ok) throw new Error();
  } catch {
    window.alert("No se pudo borrar. Vuelve a iniciar sesión con Kick y prueba de nuevo.");
  }
  await loadSuggestions();
}

adminBar.querySelector("button").addEventListener("click", () => {
  deleteSuggestions("all=1", "¿Borrar TODAS las sugerencias? No se puede deshacer.");
});

suggestionList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-id]");
  if (button) deleteSuggestions(`id=${encodeURIComponent(button.dataset.deleteId)}`, "¿Borrar esta sugerencia?");
});

function refreshAuthDependentUI() {
  const session = getKickSession();
  suggestionForm.style.display = session ? "flex" : "none";
  suggestionLoginHint.style.display = session ? "none" : "block";
  refreshAdmin(session).then(loadSuggestions);
}

async function loadSuggestions() {
  suggestionList.innerHTML = '<div class="suggestion-empty">Cargando...</div>';
  try {
    const res = await fetch(`${COMMUNITY_API}/community/suggestions`);
    if (!res.ok) throw new Error("fetch_failed");
    const rows = await res.json();

    suggestionList.innerHTML = "";
    if (!rows.length) {
      suggestionList.innerHTML = '<div class="suggestion-empty">Todavia no hay sugerencias. Se el primero.</div>';
      return;
    }

    rows.forEach((row) => {
      const item = document.createElement("div");
      const date = new Date(row.created_at);
      const dateStr = Number.isNaN(date.getTime())
        ? ""
        : date.toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" });

      item.className = "suggestion-item";
      item.innerHTML = `
        <div class="suggestion-meta">
          <span class="suggestion-user">${escapeHtml(row.kick_username)}</span>
          <span class="suggestion-date">${dateStr}</span>
          ${isAdmin && Number.isSafeInteger(row.id) ? `<button type="button" class="suggestion-delete" data-delete-id="${row.id}" aria-label="Borrar sugerencia">Borrar</button>` : ""}
        </div>
        <div class="suggestion-text">${escapeHtml(row.message)}</div>
      `;
      suggestionList.appendChild(item);
    });
  } catch {
    suggestionList.innerHTML = '<div class="suggestion-empty">No se pudieron cargar las sugerencias.</div>';
  }
}

suggestionSubmitBtn?.addEventListener("click", async () => {
  const session = getKickSession();
  if (!session) return;
  const text = suggestionInput.value.trim();
  if (!text) return;

  suggestionSubmitBtn.disabled = true;
  suggestionSubmitBtn.textContent = "Enviando...";
  try {
    // El usuario lo pone el Worker a partir de la sesion firmada.
    const res = await fetch(`${COMMUNITY_API}/community/suggestions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...communityAuthHeaders(session) },
      body: JSON.stringify({ message: text }),
    });
    if (res.status === 429) throw new Error("Espera un minuto antes de enviar otra sugerencia (máximo 10 por día).");
    if (res.status === 401) throw new Error("Tu sesión de Kick venció. Vuelve a iniciar sesión.");
    if (!res.ok) throw new Error("No se pudo enviar la sugerencia.");
    suggestionInput.value = "";
    await loadSuggestions();
  } catch (error) {
    window.alert(error?.message || "No se pudo enviar la sugerencia.");
  } finally {
    suggestionSubmitBtn.disabled = false;
    suggestionSubmitBtn.textContent = "Enviar sugerencia";
  }
});

// initKickAuthUI avisa con onChange (con o sin sesion): eso carga la lista.
initKickAuthUI({ onChange: refreshAuthDependentUI });
