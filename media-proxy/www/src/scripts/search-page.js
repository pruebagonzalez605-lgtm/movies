import { initKickAuthUI } from "./shared/kick-auth-ui.js";
import { searchSite } from "./shared/catalog-data.js";

const params = new URLSearchParams(window.location.search);
const query = (params.get("q") || "").trim();
const titleNode = document.getElementById("searchTitle");
const introNode = document.getElementById("searchIntro");
const countNode = document.getElementById("searchCount");
const resultsNode = document.getElementById("searchResults");

function renderResultCard(result) {
  const card = document.createElement("a");
  card.className = "search-result-card";
  card.href = result.href;
  card.innerHTML = `
    <div class="search-result-art"></div>
    <div class="search-result-copy">
      <span class="catalog-card-code">${result.code}</span>
      <h3>${result.title}</h3>
      <div class="search-result-subtitle">${result.subtitle}</div>
      <p>${result.description}</p>
    </div>
  `;

  const art = card.querySelector(".search-result-art");
  if (result.poster) {
    art.style.backgroundImage = `linear-gradient(180deg, rgba(8,8,12,0.08), rgba(8,8,12,0.78)), url('${result.poster}')`;
    art.style.backgroundSize = "cover";
    art.style.backgroundPosition = "center";
  } else {
    art.style.background = `linear-gradient(160deg, ${result.gradient[0]}, ${result.gradient[1]})`;
  }

  return card;
}

async function init() {
  initKickAuthUI();

  document.querySelectorAll(".site-search-input").forEach((input) => {
    input.value = query;
  });

  if (!query) {
    titleNode.textContent = "Busca en tu cartelera";
    introNode.textContent = "Encuentra peliculas, series, sagas o capitulos desde un solo lugar.";
    countNode.textContent = "Escribe algo en la barra para empezar.";
    resultsNode.innerHTML = "";
    return;
  }

  titleNode.textContent = `Resultados para "${query}"`;
  introNode.textContent = "Tu buscador revisa peliculas, series, sagas y episodios disponibles dentro del sitio.";
  countNode.textContent = "Buscando...";

  const results = await searchSite(query);
  countNode.textContent = results.length
    ? `${results.length} resultados encontrados`
    : "No se encontraron coincidencias.";

  resultsNode.innerHTML = "";
  results.forEach((result) => {
    resultsNode.appendChild(renderResultCard(result));
  });
}

init();
