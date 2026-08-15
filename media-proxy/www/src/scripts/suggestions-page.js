import { createSupabaseService } from "./services/supabase.js";
import { getKickSession, initKickAuthUI } from "./shared/kick-auth-ui.js";

const supabase = createSupabaseService({
  url: "https://iqmxbmodzdtjdfepggae.supabase.co",
  anonKey: "sb_publishable_w2GCzCqZJcYMHi8yyCN23Q_IthBqvhF",
});
const supabaseRest = `${supabase.config.url}/rest/v1`;

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

function refreshAuthDependentUI() {
  const session = getKickSession();
  suggestionForm.style.display = session ? "flex" : "none";
  suggestionLoginHint.style.display = session ? "none" : "block";
}

async function loadSuggestions() {
  suggestionList.innerHTML = '<div class="suggestion-empty">Cargando...</div>';
  try {
    const url = `${supabaseRest}/suggestions?select=kick_username,message,created_at&order=created_at.desc&limit=200`;
    const res = await fetch(url, { headers: supabase.headers() });
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
    const res = await fetch(`${supabaseRest}/suggestions`, {
      method: "POST",
      headers: supabase.headers({
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      }),
      body: JSON.stringify({
        kick_username: session.username,
        message: text,
      }),
    });
    if (!res.ok) throw new Error("insert_failed");
    suggestionInput.value = "";
    await loadSuggestions();
  } finally {
    suggestionSubmitBtn.disabled = false;
    suggestionSubmitBtn.textContent = "Enviar sugerencia";
  }
});

initKickAuthUI({ onChange: refreshAuthDependentUI });
refreshAuthDependentUI();
loadSuggestions();
