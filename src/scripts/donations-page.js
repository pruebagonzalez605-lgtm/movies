import { DONORS } from "./data/donors.js";

const tableBody = document.getElementById("donorTableBody");
const emptyState = document.getElementById("donorEmptyState");

function formatDate(value) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("es-CO", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatAmount(amount, currency = "COP") {
  try {
    return new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString("es-CO")}`;
  }
}

function addCell(row, value, className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  cell.textContent = value;
  row.appendChild(cell);
}

function renderDonors() {
  if (!tableBody || !emptyState) return;

  const recentDonors = DONORS
    .filter((donor) => donor && typeof donor.name === "string" && donor.name.trim()
      && Number.isFinite(Number(donor.amount)) && Number(donor.amount) >= 0)
    .slice()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 10)
    .sort((a, b) => Number(b.amount) - Number(a.amount)
      || new Date(b.date).getTime() - new Date(a.date).getTime());

  tableBody.replaceChildren();
  emptyState.hidden = recentDonors.length > 0;

  recentDonors.forEach((donor, index) => {
    const row = document.createElement("tr");
    if (index < 3) row.classList.add(`donor-row-rank-${index + 1}`);
    addCell(row, String(index + 1), "donor-rank");
    addCell(row, donor.name.trim(), "donor-name");
    addCell(row, formatDate(donor.date), "donor-date");
    addCell(row, formatAmount(Number(donor.amount), donor.currency || "COP"), "donor-amount");
    tableBody.appendChild(row);
  });
}

renderDonors();
