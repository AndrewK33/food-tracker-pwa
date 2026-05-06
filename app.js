const LS_KEY = "foodTrackerPWA.v1";

const defaultState = {
  goals: { kcal: 2200, protein: 160, fat: 70, carbs: 220 },
  entries: [],
  favorites: [],
  body: [],
  ai: {
    useOpenAI: false,
    openAiApiKey: "",
    openAiModel: "gpt-4.1-mini"
  },
  selectedDate: new Date().toISOString().slice(0,10)
};

let state = loadState();
let scannerControls = null;
let photoCandidates = [];
let localImageModel = null;

function loadState() {
  try {
    const loaded = JSON.parse(localStorage.getItem(LS_KEY)) || {};
    return {
      ...structuredClone(defaultState),
      ...loaded,
      goals: { ...defaultState.goals, ...(loaded.goals || {}) },
      ai: { ...defaultState.ai, ...(loaded.ai || {}) }
    };
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


async function fetchOpenFoodFactsByName(searchTerm) {
  const fields = "product_name,nutriments,brands,code";
  const url = `https://world.openfoodfacts.org/api/v2/search?search_terms=${encodeURIComponent(searchTerm)}&fields=${fields}&page_size=10`;
  const res = await fetch(url, { headers: { "Accept": "application/json" }});
  if (!res.ok) throw new Error("Ошибка поиска Open Food Facts");
  const data = await res.json();
  const products = data.products || [];

  for (const p of products) {
    const n = p.nutriments || {};
    const kcal = n["energy-kcal_100g"];
    const protein = n["proteins_100g"];
    const fat = n["fat_100g"];
    const carbs = n["carbohydrates_100g"];

    if ([kcal, protein, fat, carbs].every(v => v !== undefined && v !== null && !Number.isNaN(Number(v)))) {
      return {
        id: uid(),
        date: state.selectedDate,
        barcode: p.code || "",
        name: p.product_name || searchTerm,
        grams: 100,
        kcal100: Number(kcal),
        protein100: Number(protein),
        fat100: Number(fat),
        carbs100: Number(carbs),
        meal: "Перекус",
        source: `Источник: Open Food Facts, поиск по названию «${searchTerm}»`
      };
    }
  }

  throw new Error("БЖУ не найдено в Open Food Facts");
}

function resizeImageToDataUrl(file, maxSize = 1024, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      const scale = Math.min(1, maxSize / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };

    img.onerror = () => reject(new Error("Не удалось прочитать изображение"));
    img.src = url;
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Не удалось загрузить изображение"));
    img.src = dataUrl;
  });
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) return resolve();

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Не удалось загрузить ${src}`));
    document.head.appendChild(script);
  });
}

const FOOD_LABEL_MAP = [
  { keys: ["banana"], name: "банан", state: "raw" },
  { keys: ["apple", "granny smith"], name: "яблоко", state: "raw" },
  { keys: ["orange"], name: "апельсин", state: "raw" },
  { keys: ["lemon"], name: "лимон", state: "raw" },
  { keys: ["pineapple"], name: "ананас", state: "raw" },
  { keys: ["strawberry"], name: "клубника", state: "raw" },
  { keys: ["fig"], name: "инжир", state: "raw" },
  { keys: ["pomegranate"], name: "гранат", state: "raw" },
  { keys: ["cucumber"], name: "огурец", state: "raw" },
  { keys: ["bell pepper"], name: "перец сладкий", state: "raw" },
  { keys: ["broccoli"], name: "брокколи", state: "raw" },
  { keys: ["cauliflower"], name: "цветная капуста", state: "raw" },
  { keys: ["spaghetti", "carbonara"], name: "паста", state: "cooked" },
  { keys: ["pizza"], name: "пицца", state: "dish" },
  { keys: ["cheeseburger", "hamburger"], name: "бургер", state: "dish" },
  { keys: ["hotdog", "hot dog"], name: "хот-дог", state: "dish" },
  { keys: ["burrito"], name: "буррито", state: "dish" },
  { keys: ["guacamole"], name: "гуакамоле", state: "dish" },
  { keys: ["ice cream"], name: "мороженое", state: "dish" },
  { keys: ["bagel"], name: "бейгл", state: "baked" },
  { keys: ["pretzel"], name: "крендель", state: "baked" },
  { keys: ["baguette", "french loaf"], name: "хлеб", state: "baked" },
  { keys: ["espresso", "coffee"], name: "кофе", state: "dish" }
];

function mapImageLabel(label) {
  const lower = String(label || "").toLowerCase();
  const match = FOOD_LABEL_MAP.find(x => x.keys.some(k => lower.includes(k)));
  if (match) return { name: match.name, normalizedName: match.name, state: match.state, isFood: true };
  return { name: label || "неизвестный продукт", normalizedName: label || "неизвестный продукт", state: "unknown", isFood: false };
}

async function recognizeFoodLocally(imageDataUrl) {
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js");
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1");

  if (!localImageModel) {
    localImageModel = await mobilenet.load({ version: 2, alpha: 0.5 });
  }

  const img = await loadImage(imageDataUrl);
  const predictions = await localImageModel.classify(img, 5);
  const candidates = predictions.map(p => {
    const mapped = mapImageLabel(p.className);
    return {
      ...mapped,
      confidence: Number(p.probability || 0),
      notes: mapped.isFood ? "Локальная модель распознала похожий продукт" : `Локальная модель распознала: ${p.className}. Проверьте вручную`,
      source: "local"
    };
  });

  const foodFirst = [...candidates].sort((a, b) => Number(b.isFood) - Number(a.isFood) || b.confidence - a.confidence);
  return { candidates: foodFirst, provider: "local" };
}

async function recognizeFoodWithOpenAI(imageDataUrl) {
  const apiKey = state.ai?.openAiApiKey?.trim();
  if (!apiKey) throw new Error("OpenAI API-ключ не указан");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      candidates: {
        type: "array",
        minItems: 0,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            normalizedName: { type: "string" },
            state: { type: "string", enum: ["raw", "cooked", "fried", "baked", "packaged", "dish", "unknown"] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            notes: { type: "string" }
          },
          required: ["name", "normalizedName", "state", "confidence", "notes"]
        }
      }
    },
    required: ["candidates"]
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: state.ai?.openAiModel?.trim() || "gpt-4.1-mini",
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Определи еду или продукт на фото. Не рассчитывай КБЖУ. Верни 1-5 кандидатов. Если это готовое блюдо, укажи state=dish. Если не уверен, снизь confidence. Названия верни на русском."
          },
          { type: "input_image", image_url: imageDataUrl, detail: "low" }
        ]
      }],
      text: {
        format: {
          type: "json_schema",
          name: "food_photo_recognition",
          strict: true,
          schema
        }
      }
    })
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || "OpenAI не смог распознать фото");
  }

  const outputText = data.output_text || (data.output || [])
    .flatMap(x => x.content || [])
    .map(x => x.text || "")
    .find(Boolean);

  if (!outputText) throw new Error("OpenAI вернул пустой ответ");
  const parsed = JSON.parse(outputText);
  return {
    candidates: (parsed.candidates || []).map(c => ({ ...c, source: "openai", isFood: true })),
    provider: "openai"
  };
}

async function recognizeFoodPhoto(imageDataUrl) {
  if (state.ai?.useOpenAI && state.ai?.openAiApiKey?.trim()) {
    try {
      return await recognizeFoodWithOpenAI(imageDataUrl);
    } catch (e) {
      const localResult = await recognizeFoodLocally(imageDataUrl);
      localResult.warning = `OpenAI недоступен: ${e.message}. Использую локальную модель.`;
      return localResult;
    }
  }
  return recognizeFoodLocally(imageDataUrl);
}

async function handlePhotoSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    $("recognitionDialog").showModal();
    $("recognitionStatus").textContent = "Готовлю фото...";
    $("recognitionList").innerHTML = "";

    const imageDataUrl = await resizeImageToDataUrl(file);
    $("recognitionPreview").src = imageDataUrl;
    $("recognitionPreview").hidden = false;

    $("recognitionStatus").textContent = state.ai?.useOpenAI && state.ai?.openAiApiKey ? "Распознаю через OpenAI..." : "Распознаю локально на устройстве...";
    const result = await recognizeFoodPhoto(imageDataUrl);
    renderRecognitionCandidates(result.candidates || [], result.warning || "");
  } catch (e) {
    $("recognitionStatus").textContent = e.message || "Не удалось распознать фото";
    $("recognitionList").innerHTML = "";
  } finally {
    event.target.value = "";
  }
}

function renderRecognitionCandidates(candidates, warning = "") {
  photoCandidates = candidates;

  if (!candidates.length) {
    $("recognitionStatus").textContent = warning || "Не удалось определить продукт. Введите вручную.";
    $("recognitionList").innerHTML = "";
    return;
  }

  $("recognitionStatus").textContent = warning || "Проверьте вариант. После выбора нужно будет указать вес.";
  $("recognitionList").innerHTML = candidates.map((c, i) => `
    <div class="item">
      <div class="title">${escapeHtml(c.name)}</div>
      <div class="meta">${stateLabel(c.state)} · уверенность ${Math.round((c.confidence || 0) * 100)}%</div>
      <div class="meta">${escapeHtml(c.notes || "Проверьте перед сохранением")}</div>
      <div class="itemActions">
        <button onclick="selectRecognizedFood(${i})">Выбрать</button>
      </div>
    </div>
  `).join("");
}

function stateLabel(state) {
  return ({
    raw: "сырой продукт",
    cooked: "готовый продукт",
    fried: "жареное",
    baked: "выпечка",
    packaged: "упаковка",
    dish: "готовое блюдо",
    unknown: "не определено"
  })[state] || "не определено";
}

function normalizeFoodName(s) {
  return String(s || "").trim().toLowerCase();
}

async function findNutritionForRecognizedFood(candidate) {
  const normalized = normalizeFoodName(candidate.normalizedName || candidate.name);
  const favorite = state.favorites.find(f => {
    const fav = normalizeFoodName(f.name);
    return fav && normalized && (fav.includes(normalized) || normalized.includes(fav));
  });

  if (favorite) {
    return {
      ...favorite,
      id: uid(),
      date: state.selectedDate,
      grams: favorite.grams || 100,
      source: `Источник: избранное, продукт выбран по фото (${Math.round((candidate.confidence || 0) * 100)}%)`
    };
  }

  return fetchOpenFoodFactsByName(candidate.normalizedName || candidate.name);
}

async function selectRecognizedFood(index) {
  const candidate = photoCandidates[index];
  if (!candidate) return;

  $("recognitionStatus").textContent = "Ищу КБЖУ по названию...";
  $("recognitionList").innerHTML = "";

  try {
    const product = await findNutritionForRecognizedFood(candidate);
    product.source = `${product.source}; распознано по фото: ${candidate.name}`;
    $("recognitionDialog").close();
    openFoodDialog(product);
  } catch (e) {
    $("recognitionDialog").close();
    openFoodDialog({
      id: uid(),
      date: state.selectedDate,
      barcode: "",
      name: candidate.normalizedName || candidate.name || "",
      grams: 100,
      kcal100: 0,
      protein100: 0,
      fat100: 0,
      carbs100: 0,
      meal: "Перекус",
      source: `Распознано по фото: ${candidate.name}. ${e.message}. Введите КБЖУ вручную.`
    });
  }
}

function closeRecognitionDialog() {
  $("recognitionDialog").close();
}

function openManualFromRecognition() {
  $("recognitionDialog").close();
  openFoodDialog();
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

function closeDialogIfOpen(id) {
  const dialog = $(id);
  if (dialog?.open) dialog.close();
}

function openApiKeyHelp() {
  closeDialogIfOpen("helpMenuDialog");
  $("apiKeyHelpDialog").showModal();
}

function openPhotoHelp() {
  closeDialogIfOpen("helpMenuDialog");
  $("photoHelpDialog").showModal();
}

function openSettingsAndFocusApiKey() {
  closeDialogIfOpen("apiKeyHelpDialog");
  if (!$('settingsDialog').open) {
    $("settingsBtn").click();
  }
  setTimeout(() => $("openAiKeyInput")?.focus(), 80);
}

function openExternalUrl(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

$("helpBtn").addEventListener("click", () => $("helpMenuDialog").showModal());
$("closeHelpMenu").addEventListener("click", () => $("helpMenuDialog").close());
$("apiKeyHelpFromMenu").addEventListener("click", openApiKeyHelp);
$("photoHelpFromMenu").addEventListener("click", openPhotoHelp);
$("apiKeyHelpBtn").addEventListener("click", openApiKeyHelp);
$("apiKeyHelpInlineBtn").addEventListener("click", openApiKeyHelp);
$("closeApiKeyHelp").addEventListener("click", () => $("apiKeyHelpDialog").close());
$("closeApiKeyHelpBottom").addEventListener("click", () => $("apiKeyHelpDialog").close());
$("goToKeySettingsBtn").addEventListener("click", openSettingsAndFocusApiKey);
$("openApiKeysBtn").addEventListener("click", () => openExternalUrl("https://platform.openai.com/api-keys"));
$("closePhotoHelp").addEventListener("click", () => $("photoHelpDialog").close());
$("toggleAiKeyBtn").addEventListener("click", () => {
  const input = $("openAiKeyInput");
  const button = $("toggleAiKeyBtn");
  const shouldShow = input.type === "password";
  input.type = shouldShow ? "text" : "password";
  button.textContent = shouldShow ? "Скрыть" : "Показать";
});

$("scanBtn").addEventListener("click", openScanner);
$("photoBtn").addEventListener("click", () => $("photoInput").click());
$("photoInput").addEventListener("change", handlePhotoSelected);
$("closeRecognition").addEventListener("click", closeRecognitionDialog);
$("recognitionManualBtn").addEventListener("click", openManualFromRecognition);
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
  $("useOpenAiInput").checked = Boolean(state.ai?.useOpenAI);
  $("openAiKeyInput").value = state.ai?.openAiApiKey || "";
  $("openAiModelInput").value = state.ai?.openAiModel || "gpt-4.1-mini";
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
  state.ai = {
    useOpenAI: $("useOpenAiInput").checked,
    openAiApiKey: $("openAiKeyInput").value.trim(),
    openAiModel: $("openAiModelInput").value.trim() || "gpt-4.1-mini"
  };
  $("settingsDialog").close();
  render();
});

$("clearAiKeyBtn").addEventListener("click", () => {
  state.ai.openAiApiKey = "";
  $("openAiKeyInput").value = "";
  saveState();
  alert("API-ключ удалён с этого устройства");
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
