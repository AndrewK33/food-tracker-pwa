const LS_KEY = "foodTrackerPWA.v1";

const defaultState = {
  goals: { kcal: 2200, protein: 160, fat: 70, carbs: 220 },
  entries: [],
  favorites: [],
  body: [],
  selectedDate: new Date().toISOString().slice(0,10)
};

let state = loadState();
let scannerControls = null;

function loadState() {
  try {
    return { ...defaultState, ...(JSON.parse(localStorage.getItem(LS_KEY)) || {}) };
  } catch {
    return structuredClone(defaultState);
  }
}
function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}
function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}
function $(id) { return document.getElementById(id); }
function round(n) { return Math.round((Number(n) || 0) * 10) / 10; }
function todayISO() { return new Date().toISOString().slice(0,10); }

function totalsForDate(date) {
  const items = state.entries.filter(e => e.date === date);
  return items.reduce((a, e) => {
    const factor = (Number(e.grams) || 0) / 100;
    a.kcal += (Number(e.kcal100) || 0) * factor;
    a.protein += (Number(e.protein100) || 0) * factor;
    a.fat += (Number(e.fat100) || 0) * factor;
    a.carbs += (Number(e.carbs100) || 0) * factor;
    return a;
  }, { kcal: 0, protein: 0, fat: 0, carbs: 0 });
}

function render() {
  $("todayLabel").textContent = new Date(state.selectedDate).toLocaleDateString("ru-RU", { weekday:"long", day:"numeric", month:"long" });
  $("datePicker").value = state.selectedDate;

  const t = totalsForDate(state.selectedDate);
  const g = state.goals;

  $("caloriesToday").textContent = Math.round(t.kcal);
  $("caloriesGoal").textContent = Math.round(g.kcal);
  $("proteinToday").textContent = Math.round(t.protein);
  $("fatToday").textContent = Math.round(t.fat);
  $("carbsToday").textContent = Math.round(t.carbs);
  $("proteinGoal").textContent = Math.round(g.protein);
  $("fatGoal").textContent = Math.round(g.fat);
  $("carbsGoal").textContent = Math.round(g.carbs);

  const left = g.kcal - t.kcal;
  const status = $("calorieStatus");
  status.textContent = left >= 0 ? `Осталось ${Math.round(left)}` : `Превышение ${Math.round(Math.abs(left))}`;
  status.classList.toggle("bad", left < 0);

  const progress = $("calorieProgress");
  progress.style.width = `${Math.min(100, (t.kcal / g.kcal) * 100)}%`;
  progress.classList.toggle("bad", left < 0);

  renderEntries();
  renderHistory();
  renderBody();
  saveState();
}

function renderEntries() {
  const box = $("entriesList");
  const items = state.entries.filter(e => e.date === state.selectedDate);
  if (!items.length) {
    box.innerHTML = `<p class="muted">Нет записей за выбранный день</p>`;
    return;
  }
  const mealOrder = ["Завтрак","Обед","Ужин","Перекус"];
  items.sort((a,b) => mealOrder.indexOf(a.meal) - mealOrder.indexOf(b.meal));
  box.innerHTML = items.map(e => {
    const factor = e.grams / 100;
    return `<div class="item">
      <div class="title">${escapeHtml(e.name)}</div>
      <div class="meta">${e.meal || "Прием пищи"} · ${round(e.grams)} г · ${Math.round(e.kcal100 * factor)} ккал</div>
      <div class="meta">Б ${round(e.protein100*factor)} · Ж ${round(e.fat100*factor)} · У ${round(e.carbs100*factor)}</div>
      <div class="meta">${e.source ? escapeHtml(e.source) : ""}</div>
      <div class="itemActions">
        <button onclick="editEntry('${e.id}')">Редактировать</button>
        <button onclick="duplicateEntry('${e.id}')">Копия</button>
        <button class="danger" onclick="deleteEntry('${e.id}')">Удалить</button>
      </div>
    </div>`;
  }).join("");
}

function renderHistory() {
  const box = $("historyList");
  const dates = [...new Set(state.entries.map(e => e.date))].sort().reverse();
  if (!dates.length) {
    box.innerHTML = `<p class="muted">Истории пока нет</p>`;
    return;
  }
  box.innerHTML = dates.map(date => {
    const t = totalsForDate(date);
    const diff = state.goals.kcal - t.kcal;
    return `<div class="item" onclick="state.selectedDate='${date}'; switchTab('diary'); render();">
      <div class="title">${new Date(date).toLocaleDateString("ru-RU")}</div>
      <div class="meta">${Math.round(t.kcal)} ккал · Б ${Math.round(t.protein)} · Ж ${Math.round(t.fat)} · У ${Math.round(t.carbs)}</div>
      <div class="meta">${diff >= 0 ? "Недобор" : "Превышение"} ${Math.round(Math.abs(diff))} ккал</div>
    </div>`;
  }).join("");
}

function renderBody() {
  const box = $("bodyList");
  const items = [...state.body].sort((a,b) => b.date.localeCompare(a.date));
  if (!items.length) {
    box.innerHTML = `<p class="muted">Пока нет замеров</p>`;
    return;
  }
  box.innerHTML = items.map(x => `<div class="item">
    <div class="title">${new Date(x.date).toLocaleDateString("ru-RU")}</div>
    <div class="meta">Вес: ${x.weight || "—"} кг · Талия: ${x.waist || "—"} см</div>
    <div class="itemActions"><button class="danger" onclick="deleteBody('${x.id}')">Удалить</button></div>
  </div>`).join("");
}

async function fetchOpenFoodFacts(barcode) {
  const fields = "product_name,nutriments,brands,quantity";
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${fields}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" }});
  if (!res.ok) throw new Error("Ошибка сети при запросе Open Food Facts");
  const data = await res.json();
  if (data.status !== 1 || !data.product) throw new Error("Продукт не найден в Open Food Facts");

  const p = data.product;
  const n = p.nutriments || {};
  const kcal = n["energy-kcal_100g"];
  const protein = n["proteins_100g"];
  const fat = n["fat_100g"];
  const carbs = n["carbohydrates_100g"];

  if ([kcal, protein, fat, carbs].some(v => v === undefined || v === null || Number.isNaN(Number(v)))) {
    throw new Error("У продукта нет полного БЖУ. Введите данные вручную с этикетки.");
  }

  return {
    id: uid(),
    date: state.selectedDate,
    barcode,
    name: p.product_name || `Продукт ${barcode}`,
    grams: 100,
    kcal100: Number(kcal),
    protein100: Number(protein),
    fat100: Number(fat),
    carbs100: Number(carbs),
    meal: "Перекус",
    source: "Источник: Open Food Facts"
  };
}

async function openScanner() {
  $("scannerDialog").showModal();
  $("scannerStatus").textContent = "Наведите камеру на штрихкод";

  try {
    const codeReader = new ZXingBrowser.BrowserMultiFormatReader();
    scannerControls = await codeReader.decodeFromVideoDevice(undefined, "video", async (result, err, controls) => {
      if (result) {
        controls.stop();
        scannerControls = null;
        $("scannerDialog").close();
        const barcode = result.getText();
        await loadByBarcode(barcode);
      }
    });
  } catch (e) {
    $("scannerStatus").textContent = "Не удалось включить камеру. Проверьте доступ к камере и откройте приложение через HTTPS.";
  }
}

async function loadByBarcode(barcode) {
  try {
    const product = await fetchOpenFoodFacts(barcode);
    openFoodDialog(product);
  } catch (e) {
    openFoodDialog({
      id: uid(),
      date: state.selectedDate,
      barcode,
      name: "",
      grams: 100,
      kcal100: 0,
      protein100: 0,
      fat100: 0,
      carbs100: 0,
      meal: "Перекус",
      source: e.message
    });
  }
}

function openFoodDialog(entry = null) {
  $("foodDialogTitle").textContent = entry?.id && state.entries.some(x => x.id === entry.id) ? "Редактировать продукт" : "Добавить продукт";
  $("entryId").value = entry?.id || "";
  $("nameInput").value = entry?.name || "";
  $("barcodeInput").value = entry?.barcode || "";
  $("mealInput").value = entry?.meal || "Перекус";
  $("gramsInput").value = entry?.grams ?? 100;
  $("kcalInput").value = entry?.kcal100 ?? 0;
  $("proteinInput").value = entry?.protein100 ?? 0;
  $("fatInput").value = entry?.fat100 ?? 0;
  $("carbsInput").value = entry?.carbs100 ?? 0;
  $("sourceInfo").textContent = entry?.source || "Ручной ввод";
  $("foodDialog").showModal();
}

function readFoodForm() {
  return {
    id: $("entryId").value || uid(),
    date: state.selectedDate,
    barcode: $("barcodeInput").value.trim(),
    name: $("nameInput").value.trim(),
    meal: $("mealInput").value,
    grams: Number($("gramsInput").value),
    kcal100: Number($("kcalInput").value),
    protein100: Number($("proteinInput").value),
    fat100: Number($("fatInput").value),
    carbs100: Number($("carbsInput").value),
    source: $("sourceInfo").textContent || "Ручной ввод"
  };
}

$("foodForm").addEventListener("submit", e => {
  e.preventDefault();
  const item = readFoodForm();
  if (!item.name || item.grams <= 0) return alert("Введите название и порцию");
  const index = state.entries.findIndex(x => x.id === item.id);
  if (index >= 0) state.entries[index] = item;
  else state.entries.push(item);
  $("foodDialog").close();
  render();
});

$("favoriteToggle").addEventListener("click", () => {
  const item = readFoodForm();
  if (!item.name) return alert("Сначала введите название");
  const fav = { ...item, id: uid(), date: undefined };
  state.favorites = state.favorites.filter(f => !(f.name === fav.name && f.barcode === fav.barcode));
  state.favorites.push(fav);
  render();
  alert("Добавлено в избранное");
});

function editEntry(id) {
  const e = state.entries.find(x => x.id === id);
  if (e) openFoodDialog(e);
}
function duplicateEntry(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  state.entries.push({ ...e, id: uid(), date: state.selectedDate });
  render();
}
function deleteEntry(id) {
  if (!confirm("Удалить запись?")) return;
  state.entries = state.entries.filter(e => e.id !== id);
  render();
}

function renderFavorites() {
  const box = $("favoritesList");
  if (!state.favorites.length) {
    box.innerHTML = `<p class="muted">Избранных продуктов пока нет</p>`;
    return;
  }
  box.innerHTML = state.favorites.map(f => `<div class="item">
    <div class="title">${escapeHtml(f.name)}</div>
    <div class="meta">${Math.round(f.kcal100)} ккал / 100 г · Б ${round(f.protein100)} · Ж ${round(f.fat100)} · У ${round(f.carbs100)}</div>
    <div class="itemActions">
      <button onclick="addFavorite('${f.id}')">Добавить</button>
      <button class="danger" onclick="deleteFavorite('${f.id}')">Удалить</button>
    </div>
  </div>`).join("");
}
function addFavorite(id) {
  const f = state.favorites.find(x => x.id === id);
  if (!f) return;
  openFoodDialog({ ...f, id: uid(), date: state.selectedDate, grams: f.grams || 100 });
  $("favoritesDialog").close();
}
function deleteFavorite(id) {
  state.favorites = state.favorites.filter(x => x.id !== id);
  renderFavorites();
  render();
}

function copyYesterday() {
  const d = new Date(state.selectedDate);
  d.setDate(d.getDate() - 1);
  const y = d.toISOString().slice(0,10);
  const items = state.entries.filter(e => e.date === y);
  if (!items.length) return alert("За вчера нет записей");
  state.entries.push(...items.map(e => ({ ...e, id: uid(), date: state.selectedDate })));
  render();
}

function saveBody() {
  const weight = Number($("weightInput").value);
  const waist = Number($("waistInput").value);
  if (!weight && !waist) return alert("Введите вес или талию");
  state.body.push({ id: uid(), date: todayISO(), weight: weight || null, waist: waist || null });
  $("weightInput").value = "";
  $("waistInput").value = "";
  render();
}
function deleteBody(id) {
  state.body = state.body.filter(x => x.id !== id);
  render();
}

function switchTab(tab) {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("historyTab").classList.toggle("hidden", tab !== "history");
  $("weightTab").classList.toggle("hidden", tab !== "weight");
  $("exportTab").classList.toggle("hidden", tab !== "export");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `food-tracker-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

$("scanBtn").addEventListener("click", openScanner);
$("manualBtn").addEventListener("click", () => openFoodDialog());
$("favoritesBtn").addEventListener("click", () => { renderFavorites(); $("favoritesDialog").showModal(); });
$("closeFavorites").addEventListener("click", () => $("favoritesDialog").close());
$("copyYesterdayBtn").addEventListener("click", copyYesterday);
$("datePicker").addEventListener("change", e => { state.selectedDate = e.target.value; render(); });

$("closeScanner").addEventListener("click", () => {
  if (scannerControls) scannerControls.stop();
  scannerControls = null;
  $("scannerDialog").close();
});

$("settingsBtn").addEventListener("click", () => {
  $("goalKcalInput").value = state.goals.kcal;
  $("goalProteinInput").value = state.goals.protein;
  $("goalFatInput").value = state.goals.fat;
  $("goalCarbsInput").value = state.goals.carbs;
  $("settingsDialog").showModal();
});
$("settingsForm").addEventListener("submit", e => {
  e.preventDefault();
  state.goals = {
    kcal: Number($("goalKcalInput").value),
    protein: Number($("goalProteinInput").value),
    fat: Number($("goalFatInput").value),
    carbs: Number($("goalCarbsInput").value)
  };
  $("settingsDialog").close();
  render();
});

$("saveBodyBtn").addEventListener("click", saveBody);
$("exportBtn").addEventListener("click", exportJson);
$("importFile").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const imported = JSON.parse(text);
    if (!confirm("Импорт заменит текущие данные. Продолжить?")) return;
    state = { ...defaultState, ...imported };
    render();
  } catch {
    alert("Не удалось прочитать JSON");
  }
});
$("clearBtn").addEventListener("click", () => {
  if (!confirm("Удалить все данные приложения?")) return;
  state = structuredClone(defaultState);
  render();
});

document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

render();
