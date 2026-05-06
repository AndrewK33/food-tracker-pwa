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
let photoImageDataUrls = [];
let photoInputMode = "new";
let localImageModel = null;
let localFood101Classifier = null;
let localFood101ModulePromise = null;
let recognitionProgressValue = 0;
let recognitionProgressTimer = null;
let foodDialogBase100 = { kcal100: 0, protein100: 0, fat100: 0, carbs100: 0 };
let foodDialogUpdating = false;

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
function round1(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}
function round(n) { return round1(n); }
function format1(n) {
  const value = round1(n);
  return Number.isInteger(value) ? String(value) : String(value);
}
function todayISO() { return new Date().toISOString().slice(0,10); }
function normalizeFoodRecord(e) {
  return {
    ...e,
    grams: round1(e.grams ?? 100),
    kcal100: round1(e.kcal100),
    protein100: round1(e.protein100),
    fat100: round1(e.fat100),
    carbs100: round1(e.carbs100)
  };
}

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
  state.entries = state.entries.map(normalizeFoodRecord);
  state.favorites = state.favorites.map(normalizeFoodRecord);
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
  renderAnalytics();
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
    return `<div class="item" onclick="selectHistoryDate('${date}')">
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

function analyticsDates(days = 14) {
  const end = new Date(state.selectedDate || todayISO());
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(end);
    d.setDate(end.getDate() - (days - 1 - i));
    return d.toISOString().slice(0, 10);
  });
}

function chartX(index, count, left, width) {
  if (count <= 1) return left + width / 2;
  return left + (index * width) / (count - 1);
}

function chartY(value, max, top, height) {
  return top + height - ((Number(value) || 0) / max) * height;
}

function renderAnalytics() {
  const calorieChart = $("calorieChart");
  const macroChart = $("macroChart");
  const summary = $("analyticsSummary");
  if (!calorieChart || !macroChart || !summary) return;

  const dates = analyticsDates(14);
  const data = dates.map(date => ({ date, ...totalsForDate(date) }));
  const hasEntries = data.some(x => x.kcal || x.protein || x.fat || x.carbs);
  if (!hasEntries) {
    calorieChart.innerHTML = `<p class="muted">Пока нет данных для графика. Добавьте продукты в дневник.</p>`;
    macroChart.innerHTML = "";
    summary.innerHTML = "";
    return;
  }

  const w = 360;
  const h = 210;
  const left = 38;
  const right = 12;
  const top = 18;
  const bottom = 36;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const kcalGoal = Math.max(1, Number(state.goals.kcal) || 1);
  const maxKcal = Math.max(kcalGoal * 1.15, ...data.map(x => x.kcal));
  const goalY = chartY(kcalGoal, maxKcal, top, plotH);
  const barGap = 4;
  const barW = Math.max(10, plotW / data.length - barGap);

  const calorieBars = data.map((x, i) => {
    const xPos = left + i * (plotW / data.length) + barGap / 2;
    const y = chartY(x.kcal, maxKcal, top, plotH);
    const height = top + plotH - y;
    const cls = x.kcal > kcalGoal ? "over" : x.kcal >= kcalGoal * 0.9 ? "good" : "under";
    return `<rect class="bar ${cls}" x="${round1(xPos)}" y="${round1(y)}" width="${round1(barW)}" height="${round1(height)}" rx="4"><title>${dateLabelShort(x.date)}: ${Math.round(x.kcal)} ккал</title></rect>`;
  }).join("");

  const calorieLabels = data.map((x, i) => {
    if (i % 2 !== 0 && data.length > 8) return "";
    const xPos = left + i * (plotW / data.length) + barW / 2;
    return `<text class="axisText" x="${round1(xPos)}" y="${h - 10}" text-anchor="middle">${dateLabelTiny(x.date)}</text>`;
  }).join("");

  calorieChart.innerHTML = `<h3>Калории по дням</h3>
    <svg class="chartSvg" viewBox="0 0 ${w} ${h}" role="img" aria-label="График калорий за 14 дней">
      <line class="axisLine" x1="${left}" y1="${top + plotH}" x2="${w - right}" y2="${top + plotH}" />
      <line class="goalLine" x1="${left}" y1="${round1(goalY)}" x2="${w - right}" y2="${round1(goalY)}" />
      <text class="goalText" x="${left}" y="${Math.max(12, round1(goalY - 5))}">цель ${Math.round(kcalGoal)}</text>
      ${calorieBars}
      ${calorieLabels}
    </svg>
    <div class="chartLegend"><span class="dot good"></span> цель почти выполнена <span class="dot under"></span> недобор <span class="dot over"></span> превышение</div>`;

  const maxMacro = Math.max(1, ...data.map(x => x.protein + x.fat + x.carbs));
  const macroBars = data.map((x, i) => {
    const xPos = left + i * (plotW / data.length) + barGap / 2;
    let yBase = top + plotH;
    const carbsH = (x.carbs / maxMacro) * plotH;
    const fatH = (x.fat / maxMacro) * plotH;
    const proteinH = (x.protein / maxMacro) * plotH;
    const carbsY = yBase - carbsH;
    const fatY = carbsY - fatH;
    const proteinY = fatY - proteinH;
    return `
      <rect class="macro carbs" x="${round1(xPos)}" y="${round1(carbsY)}" width="${round1(barW)}" height="${round1(carbsH)}" rx="3"><title>${dateLabelShort(x.date)}: У ${round1(x.carbs)} г</title></rect>
      <rect class="macro fat" x="${round1(xPos)}" y="${round1(fatY)}" width="${round1(barW)}" height="${round1(fatH)}"><title>${dateLabelShort(x.date)}: Ж ${round1(x.fat)} г</title></rect>
      <rect class="macro protein" x="${round1(xPos)}" y="${round1(proteinY)}" width="${round1(barW)}" height="${round1(proteinH)}" rx="3"><title>${dateLabelShort(x.date)}: Б ${round1(x.protein)} г</title></rect>`;
  }).join("");

  macroChart.innerHTML = `<h3>БЖУ по дням</h3>
    <svg class="chartSvg" viewBox="0 0 ${w} ${h}" role="img" aria-label="График БЖУ за 14 дней">
      <line class="axisLine" x1="${left}" y1="${top + plotH}" x2="${w - right}" y2="${top + plotH}" />
      ${macroBars}
      ${calorieLabels}
    </svg>
    <div class="chartLegend"><span class="dot protein"></span> белки <span class="dot fat"></span> жиры <span class="dot carbs"></span> углеводы</div>`;

  const avg = data.reduce((a, x) => {
    a.kcal += x.kcal;
    a.protein += x.protein;
    a.fat += x.fat;
    a.carbs += x.carbs;
    return a;
  }, { kcal: 0, protein: 0, fat: 0, carbs: 0 });
  const nonEmptyDays = Math.max(1, data.filter(x => x.kcal || x.protein || x.fat || x.carbs).length);
  const overDays = data.filter(x => x.kcal > kcalGoal).length;
  const closeDays = data.filter(x => x.kcal >= kcalGoal * 0.9 && x.kcal <= kcalGoal).length;
  const underDays = data.filter(x => x.kcal > 0 && x.kcal < kcalGoal * 0.9).length;

  summary.innerHTML = `<div class="item">
    <div class="title">Итоги за период</div>
    <div class="meta">Среднее: ${Math.round(avg.kcal / nonEmptyDays)} ккал · Б ${round1(avg.protein / nonEmptyDays)} · Ж ${round1(avg.fat / nonEmptyDays)} · У ${round1(avg.carbs / nonEmptyDays)}</div>
    <div class="meta">Дней с превышением: ${overDays} · около цели: ${closeDays} · недобор: ${underDays}</div>
  </div>`;
}

function dateLabelTiny(date) {
  const d = new Date(date);
  return `${d.getDate()}.${d.getMonth() + 1}`;
}

function dateLabelShort(date) {
  return new Date(date).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
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
    kcal100: round1(kcal),
    protein100: round1(protein),
    fat100: round1(fat),
    carbs100: round1(carbs),
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
        kcal100: round1(kcal),
        protein100: round1(protein),
        fat100: round1(fat),
        carbs100: round1(carbs),
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
  { keys: ["banana"], name: "банан", state: "raw", searchName: "banana" },
  { keys: ["apple", "granny smith"], name: "яблоко", state: "raw", searchName: "apple" },
  { keys: ["pear"], name: "груша", state: "raw", searchName: "pear" },
  { keys: ["orange"], name: "апельсин", state: "raw", searchName: "orange" },
  { keys: ["lemon"], name: "лимон", state: "raw", searchName: "lemon" },
  { keys: ["pineapple"], name: "ананас", state: "raw", searchName: "pineapple" },
  { keys: ["strawberry"], name: "клубника", state: "raw", searchName: "strawberry" },
  { keys: ["fig"], name: "инжир", state: "raw", searchName: "fig" },
  { keys: ["pomegranate"], name: "гранат", state: "raw", searchName: "pomegranate" },
  { keys: ["cucumber"], name: "огурец", state: "raw", searchName: "cucumber" },
  { keys: ["zucchini", "courgette"], name: "кабачок", state: "raw", searchName: "zucchini" },
  { keys: ["bell pepper"], name: "сладкий перец", state: "raw", searchName: "bell pepper" },
  { keys: ["broccoli"], name: "брокколи", state: "raw", searchName: "broccoli" },
  { keys: ["cauliflower"], name: "цветная капуста", state: "raw", searchName: "cauliflower" },
  { keys: ["artichoke"], name: "артишок", state: "raw", searchName: "artichoke" },
  { keys: ["cabbage"], name: "капуста", state: "raw", searchName: "cabbage" },
  { keys: ["carrot"], name: "морковь", state: "raw", searchName: "carrot" },
  { keys: ["mushroom"], name: "грибы", state: "raw", searchName: "mushroom" },
  { keys: ["egg"], name: "яйцо", state: "raw", searchName: "egg" },
  { keys: ["omelet", "omelette"], name: "омлет", state: "dish", searchName: "omelet" },
  { keys: ["salad"], name: "салат", state: "dish", searchName: "salad" },
  { keys: ["spaghetti", "carbonara", "noodle"], name: "паста", state: "cooked", searchName: "spaghetti" },
  { keys: ["pizza"], name: "пицца", state: "dish", searchName: "pizza" },
  { keys: ["cheeseburger", "hamburger"], name: "бургер", state: "dish", searchName: "burger" },
  { keys: ["hotdog", "hot dog"], name: "хот-дог", state: "dish", searchName: "hot dog" },
  { keys: ["burrito"], name: "буррито", state: "dish", searchName: "burrito" },
  { keys: ["taco"], name: "тако", state: "dish", searchName: "taco" },
  { keys: ["guacamole"], name: "гуакамоле", state: "dish", searchName: "guacamole" },
  { keys: ["ice cream"], name: "мороженое", state: "dish", searchName: "ice cream" },
  { keys: ["bagel"], name: "бейгл", state: "baked", searchName: "bagel" },
  { keys: ["pretzel"], name: "крендель", state: "baked", searchName: "pretzel" },
  { keys: ["baguette", "french loaf", "loaf"], name: "хлеб", state: "baked", searchName: "bread" },
  { keys: ["croissant"], name: "круассан", state: "baked", searchName: "croissant" },
  { keys: ["coffee", "espresso"], name: "кофе", state: "dish", searchName: "coffee" },
  { keys: ["tea"], name: "чай", state: "dish", searchName: "tea" },
  { keys: ["soup", "consomme"], name: "суп", state: "dish", searchName: "soup" },
  { keys: ["sushi"], name: "суши", state: "dish", searchName: "sushi" },
  { keys: ["rice"], name: "рис", state: "cooked", searchName: "rice" },
  { keys: ["meat loaf"], name: "мясной рулет", state: "dish", searchName: "meat loaf" },
  { keys: ["potpie", "pot pie"], name: "пирог", state: "baked", searchName: "pot pie" }
];

const LABEL_TRANSLATION_MAP = [
  ["granny smith", "яблоко"],
  ["bell pepper", "сладкий перец"],
  ["hot dog", "хот-дог"],
  ["ice cream", "мороженое"],
  ["french loaf", "хлеб"],
  ["meat loaf", "мясной рулет"],
  ["pot pie", "пирог"],
  ["potpie", "пирог"],
  ["omelette", "омлет"],
  ["omelet", "омлет"],
  ["spaghetti", "паста"],
  ["noodle", "лапша"],
  ["zucchini", "кабачок"],
  ["courgette", "кабачок"],
  ["strawberry", "клубника"],
  ["pineapple", "ананас"],
  ["pomegranate", "гранат"],
  ["cauliflower", "цветная капуста"],
  ["broccoli", "брокколи"],
  ["cucumber", "огурец"],
  ["carrot", "морковь"],
  ["cabbage", "капуста"],
  ["mushroom", "грибы"],
  ["artichoke", "артишок"],
  ["banana", "банан"],
  ["apple", "яблоко"],
  ["pear", "груша"],
  ["orange", "апельсин"],
  ["lemon", "лимон"],
  ["fig", "инжир"],
  ["pizza", "пицца"],
  ["cheeseburger", "чизбургер"],
  ["hamburger", "бургер"],
  ["burrito", "буррито"],
  ["taco", "тако"],
  ["guacamole", "гуакамоле"],
  ["bagel", "бейгл"],
  ["pretzel", "крендель"],
  ["croissant", "круассан"],
  ["coffee", "кофе"],
  ["espresso", "эспрессо"],
  ["tea", "чай"],
  ["soup", "суп"],
  ["consomme", "суп"],
  ["sushi", "суши"],
  ["rice", "рис"],
  ["egg", "яйцо"],
  ["salad", "салат"],
  ["bread", "хлеб"],
  ["loaf", "хлеб"],
  ["plate", "тарелка"],
  ["dish", "блюдо"]
];


const FOOD101_RU_MAP = {
  apple_pie: "яблочный пирог",
  baby_back_ribs: "свиные рёбрышки",
  baklava: "пахлава",
  beef_carpaccio: "карпаччо из говядины",
  beef_tartare: "тартар из говядины",
  beet_salad: "салат из свёклы",
  beignets: "пончики бейнье",
  bibimbap: "пибимпап",
  bread_pudding: "хлебный пудинг",
  breakfast_burrito: "буррито на завтрак",
  bruschetta: "брускетта",
  caesar_salad: "салат цезарь",
  cannoli: "канноли",
  caprese_salad: "салат капрезе",
  carrot_cake: "морковный торт",
  ceviche: "севиче",
  cheesecake: "чизкейк",
  cheese_plate: "сырная тарелка",
  chicken_curry: "курица карри",
  chicken_quesadilla: "кесадилья с курицей",
  chicken_wings: "куриные крылышки",
  chocolate_cake: "шоколадный торт",
  chocolate_mousse: "шоколадный мусс",
  churros: "чуррос",
  clam_chowder: "клэм-чаудер",
  club_sandwich: "клаб-сэндвич",
  crab_cakes: "крабовые котлеты",
  creme_brulee: "крем-брюле",
  croque_madame: "крок-мадам",
  cup_cakes: "капкейки",
  deviled_eggs: "фаршированные яйца",
  donuts: "пончики",
  dumplings: "пельмени или дамплинги",
  edamame: "эдамаме",
  eggs_benedict: "яйца бенедикт",
  escargots: "улитки эскарго",
  falafel: "фалафель",
  filet_mignon: "филе миньон",
  fish_and_chips: "рыба с картофелем фри",
  foie_gras: "фуа-гра",
  french_fries: "картофель фри",
  french_onion_soup: "французский луковый суп",
  french_toast: "французский тост",
  fried_calamari: "жареные кальмары",
  fried_rice: "жареный рис",
  frozen_yogurt: "замороженный йогурт",
  garlic_bread: "чесночный хлеб",
  gnocchi: "ньокки",
  greek_salad: "греческий салат",
  grilled_cheese_sandwich: "сэндвич с сыром",
  grilled_salmon: "лосось на гриле",
  guacamole: "гуакамоле",
  gyoza: "гёдза",
  hamburger: "бургер",
  hot_and_sour_soup: "остро-кислый суп",
  hot_dog: "хот-дог",
  huevos_rancheros: "уэвос ранчерос",
  hummus: "хумус",
  ice_cream: "мороженое",
  lasagna: "лазанья",
  lobster_bisque: "суп из лобстера",
  lobster_roll_sandwich: "сэндвич с лобстером",
  macaroni_and_cheese: "макароны с сыром",
  macarons: "макарон",
  miso_soup: "мисо-суп",
  mussels: "мидии",
  nachos: "начос",
  omelette: "омлет",
  onion_rings: "луковые кольца",
  oysters: "устрицы",
  pad_thai: "пад-тай",
  paella: "паэлья",
  pancakes: "панкейки",
  panna_cotta: "панна-котта",
  peking_duck: "утка по-пекински",
  pho: "фо",
  pizza: "пицца",
  pork_chop: "свиная отбивная",
  poutine: "путин",
  prime_rib: "стейк прайм-риб",
  pulled_pork_sandwich: "сэндвич со свининой",
  ramen: "рамен",
  ravioli: "равиоли",
  red_velvet_cake: "торт красный бархат",
  risotto: "ризотто",
  samosa: "самоса",
  sashimi: "сашими",
  scallops: "морские гребешки",
  seaweed_salad: "салат из морских водорослей",
  shrimp_and_grits: "креветки с кукурузной кашей",
  spaghetti_bolognese: "спагетти болоньезе",
  spaghetti_carbonara: "спагетти карбонара",
  spring_rolls: "спринг-роллы",
  steak: "стейк",
  strawberry_shortcake: "клубничный торт",
  sushi: "суши",
  tacos: "тако",
  takoyaki: "такояки",
  tiramisu: "тирамису",
  tuna_tartare: "тартар из тунца",
  waffles: "вафли"
};

const SMART_FOOD_DICTIONARY = [
  {
    triggers: ["omelette", "eggs_benedict", "deviled_eggs", "egg", "яйцо", "омлет"],
    suggestions: [
      { name: "омлет", searchName: "omelet", state: "dish" },
      { name: "яйцо", searchName: "egg", state: "raw" }
    ]
  },
  {
    triggers: ["chicken", "курица", "quesadilla", "wings", "curry"],
    suggestions: [
      { name: "курица", searchName: "chicken", state: "cooked" },
      { name: "куриная грудка", searchName: "chicken breast", state: "cooked" }
    ]
  },
  {
    triggers: ["beef", "steak", "filet_mignon", "prime_rib", "carpaccio", "tartare", "говядина", "стейк"],
    suggestions: [
      { name: "говядина", searchName: "beef", state: "cooked" },
      { name: "стейк", searchName: "steak", state: "dish" }
    ]
  },
  {
    triggers: ["pork", "pulled_pork", "pork_chop", "ribs", "свинина"],
    suggestions: [
      { name: "свинина", searchName: "pork", state: "cooked" },
      { name: "свиная отбивная", searchName: "pork chop", state: "dish" }
    ]
  },
  {
    triggers: ["salmon", "sashimi", "tuna", "fish", "seafood", "shrimp", "scallops", "mussels", "oysters", "лосось", "рыба"],
    suggestions: [
      { name: "рыба", searchName: "fish", state: "cooked" },
      { name: "лосось", searchName: "salmon", state: "cooked" },
      { name: "тунец", searchName: "tuna", state: "raw" }
    ]
  },
  {
    triggers: ["rice", "risotto", "fried_rice", "paella", "bibimbap", "рис"],
    suggestions: [
      { name: "рис", searchName: "rice", state: "cooked" },
      { name: "жареный рис", searchName: "fried rice", state: "dish" }
    ]
  },
  {
    triggers: ["spaghetti", "pasta", "ravioli", "lasagna", "macaroni", "gnocchi", "carbonara", "bolognese", "паста", "макароны"],
    suggestions: [
      { name: "паста", searchName: "pasta", state: "cooked" },
      { name: "макароны", searchName: "macaroni", state: "cooked" }
    ]
  },
  {
    triggers: ["french_fries", "poutine", "potato", "картофель", "картошка"],
    suggestions: [
      { name: "картофель", searchName: "potato", state: "cooked" },
      { name: "картофель фри", searchName: "french fries", state: "dish" }
    ]
  },
  {
    triggers: ["salad", "caesar_salad", "greek_salad", "beet_salad", "caprese_salad", "seaweed_salad", "салат"],
    suggestions: [
      { name: "салат", searchName: "salad", state: "dish" },
      { name: "овощной салат", searchName: "vegetable salad", state: "dish" }
    ]
  },
  {
    triggers: ["soup", "chowder", "bisque", "pho", "ramen", "miso", "суп"],
    suggestions: [
      { name: "суп", searchName: "soup", state: "dish" },
      { name: "рамен", searchName: "ramen", state: "dish" }
    ]
  },
  {
    triggers: ["bread", "toast", "sandwich", "bagel", "bruschetta", "хлеб", "бутерброд"],
    suggestions: [
      { name: "хлеб", searchName: "bread", state: "baked" },
      { name: "бутерброд", searchName: "sandwich", state: "dish" }
    ]
  },
  {
    triggers: ["cheese", "cheesecake", "cheese_plate", "grilled_cheese", "сыр"],
    suggestions: [
      { name: "сыр", searchName: "cheese", state: "packaged" },
      { name: "творог", searchName: "cottage cheese", state: "packaged" }
    ]
  },
  {
    triggers: ["yogurt", "frozen_yogurt", "йогурт"],
    suggestions: [
      { name: "йогурт", searchName: "yogurt", state: "packaged" },
      { name: "творог", searchName: "cottage cheese", state: "packaged" }
    ]
  },
  {
    triggers: ["pancakes", "waffles", "french_toast", "breakfast", "панкейки", "вафли"],
    suggestions: [
      { name: "панкейки", searchName: "pancakes", state: "dish" },
      { name: "овсянка", searchName: "oatmeal", state: "cooked" }
    ]
  },
  {
    triggers: ["pizza", "пицца"],
    suggestions: [
      { name: "пицца", searchName: "pizza", state: "dish" }
    ]
  },
  {
    triggers: ["hamburger", "burger", "sandwich", "бургер"],
    suggestions: [
      { name: "бургер", searchName: "burger", state: "dish" },
      { name: "сэндвич", searchName: "sandwich", state: "dish" }
    ]
  },
  {
    triggers: ["sushi", "sashimi", "rolls", "суши", "роллы"],
    suggestions: [
      { name: "суши", searchName: "sushi", state: "dish" },
      { name: "роллы", searchName: "sushi rolls", state: "dish" }
    ]
  },
  {
    triggers: ["dumplings", "gyoza", "ravioli", "пельмени", "вареники"],
    suggestions: [
      { name: "пельмени", searchName: "dumplings", state: "dish" },
      { name: "вареники", searchName: "dumplings", state: "dish" }
    ]
  },
  {
    triggers: ["cake", "pie", "donuts", "churros", "tiramisu", "baklava", "dessert", "торт", "пирог"],
    suggestions: [
      { name: "десерт", searchName: "dessert", state: "dish" },
      { name: "торт", searchName: "cake", state: "dish" }
    ]
  },
  {
    triggers: ["banana", "apple", "orange", "pear", "lemon", "strawberry", "pineapple", "fruit", "фрукт", "яблоко", "банан"],
    suggestions: [
      { name: "банан", searchName: "banana", state: "raw" },
      { name: "яблоко", searchName: "apple", state: "raw" },
      { name: "апельсин", searchName: "orange", state: "raw" }
    ]
  },
  {
    triggers: ["cucumber", "tomato", "carrot", "broccoli", "cauliflower", "cabbage", "vegetable", "овощ", "огурец", "морковь"],
    suggestions: [
      { name: "огурец", searchName: "cucumber", state: "raw" },
      { name: "помидор", searchName: "tomato", state: "raw" },
      { name: "морковь", searchName: "carrot", state: "raw" }
    ]
  }
];

function containsCyrillic(text) {
  return /[А-Яа-яЁё]/.test(String(text || ""));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function translateLabelToRussian(label) {
  const lower = String(label || "").toLowerCase().trim();
  if (!lower) return "неизвестный продукт";
  if (containsCyrillic(lower)) return lower;

  let translated = lower;
  for (const [en, ru] of [...LABEL_TRANSLATION_MAP].sort((a, b) => b[0].length - a[0].length)) {
    translated = translated.replace(new RegExp(escapeRegExp(en), "g"), ru);
  }

  const cleanedParts = translated
    .split(/\s*,\s*/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => /[a-z]/i.test(part) ? "" : part)
    .filter(Boolean);

  const unique = [...new Set(cleanedParts)];
  return unique.length ? unique.join(" / ") : "неизвестный продукт";
}

function mapImageLabel(label) {
  const lower = String(label || "").toLowerCase();
  const match = FOOD_LABEL_MAP.find(x => x.keys.some(k => lower.includes(k)));
  if (match) {
    return {
      name: match.name,
      normalizedName: match.name,
      searchName: match.searchName || match.keys[0],
      state: match.state,
      isFood: true
    };
  }

  const translated = translateLabelToRussian(label);
  return {
    name: translated,
    normalizedName: translated,
    searchName: label || "",
    state: "unknown",
    isFood: translated !== "неизвестный продукт"
  };
}

function russianizeCandidate(candidate = {}) {
  const currentName = String(candidate.normalizedName || candidate.name || "").trim();
  if (containsCyrillic(currentName)) {
    return {
      ...candidate,
      name: currentName,
      normalizedName: currentName,
      searchName: candidate.searchName || currentName,
      isFood: true
    };
  }

  const mapped = mapImageLabel(currentName);
  return {
    ...candidate,
    name: mapped.name,
    normalizedName: mapped.normalizedName,
    searchName: candidate.searchName || mapped.searchName || currentName,
    isFood: mapped.isFood || candidate.state !== "unknown"
  };
}

function asImageArray(imageDataUrls) {
  return Array.isArray(imageDataUrls) ? imageDataUrls : [imageDataUrls];
}


function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function setRecognitionLoader(visible, title = "Распознаю продукт", hint = "") {
  const loader = $("recognitionLoader");
  if (!loader) return;
  loader.hidden = !visible;
  if (visible) {
    recognitionProgressValue = 0;
    $("recognitionLoaderBar").style.width = "0%";
    $("recognitionLoaderPercent").textContent = "0%";
    $("recognitionLoaderTitle").textContent = title;
    $("recognitionLoaderHint").textContent = hint || "Первый запуск может занять дольше, потому что загружается локальная модель еды.";
  }
}

function updateRecognitionProgress(percent, title = "", hint = "") {
  const loader = $("recognitionLoader");
  if (!loader) return;
  const nextProgress = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  recognitionProgressValue = Math.max(recognitionProgressValue, nextProgress);
  loader.hidden = false;
  $("recognitionLoaderBar").style.width = `${recognitionProgressValue}%`;
  $("recognitionLoaderPercent").textContent = `${recognitionProgressValue}%`;
  if (title) $("recognitionLoaderTitle").textContent = title;
  if (hint) $("recognitionLoaderHint").textContent = hint;
}

function startSoftRecognitionProgress(start = 8, end = 88) {
  clearInterval(recognitionProgressTimer);
  updateRecognitionProgress(start);
  recognitionProgressTimer = setInterval(() => {
    const gap = end - recognitionProgressValue;
    if (gap <= 1) return;
    updateRecognitionProgress(recognitionProgressValue + Math.max(1, Math.round(gap * 0.08)));
  }, 550);
}

function stopSoftRecognitionProgress() {
  clearInterval(recognitionProgressTimer);
  recognitionProgressTimer = null;
}

function hideRecognitionLoader() {
  stopSoftRecognitionProgress();
  const loader = $("recognitionLoader");
  if (loader) loader.hidden = true;
}

function food101Key(label) {
  return String(label || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/-+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function mapFood101Label(label) {
  const key = food101Key(label);
  const name = FOOD101_RU_MAP[key] || translateLabelToRussian(String(label || "").replace(/_/g, " "));
  return {
    name,
    normalizedName: name,
    searchName: String(label || "").replace(/_/g, " ").trim(),
    state: "dish",
    isFood: true,
    rawLabel: String(label || ""),
    labelKey: key
  };
}

function textForSmartDictionary(candidate = {}) {
  return [candidate.labelKey, candidate.rawLabel, candidate.searchName, candidate.normalizedName, candidate.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function smartDictionaryCandidatesFor(candidate = {}) {
  const text = textForSmartDictionary(candidate);
  if (!text) return [];

  const result = [];
  const baseConfidence = Math.max(0.28, Math.min(0.72, (Number(candidate.confidence) || 0.35) * 0.82));

  for (const group of SMART_FOOD_DICTIONARY) {
    const isMatch = group.triggers.some(trigger => {
      const normalizedTrigger = food101Key(trigger).replace(/_/g, " ");
      return text.includes(String(trigger).toLowerCase()) || text.includes(normalizedTrigger);
    });

    if (!isMatch) continue;

    for (const suggestion of group.suggestions) {
      result.push({
        name: suggestion.name,
        normalizedName: suggestion.name,
        searchName: suggestion.searchName || suggestion.name,
        state: suggestion.state || "unknown",
        confidence: baseConfidence,
        isFood: true,
        source: "smart_dictionary",
        notes: `Подсказка из словаря популярных продуктов на основе варианта «${candidate.name || candidate.normalizedName || "еда"}». Проверьте перед сохранением.`
      });
    }
  }

  return result;
}

function addSmartDictionaryCandidates(candidates = []) {
  const generated = [];
  for (const candidate of candidates) {
    generated.push(...smartDictionaryCandidatesFor(candidate));
  }
  return [...candidates, ...generated];
}

async function loadTransformersModule() {
  if (!localFood101ModulePromise) {
    localFood101ModulePromise = import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
  }
  return localFood101ModulePromise;
}

function handleFood101Progress(data = {}) {
  if (!$("recognitionLoader")) return;

  if (data.status === "initiate") {
    updateRecognitionProgress(Math.max(recognitionProgressValue, 12), "Загружаю модель еды", "Первый запуск загружает Food-101 модель. Потом браузер обычно берёт её из кэша.");
  }

  if (data.status === "download" || data.status === "progress") {
    const loaded = Number(data.loaded || 0);
    const total = Number(data.total || 0);
    if (total > 0) {
      const fileProgress = Math.min(1, loaded / total);
      updateRecognitionProgress(15 + fileProgress * 50, "Загружаю модель еды", "Идёт загрузка локальной Food-101 модели для распознавания блюд.");
    } else {
      updateRecognitionProgress(Math.min(65, recognitionProgressValue + 1), "Загружаю модель еды");
    }
  }

  if (data.status === "ready" || data.status === "done") {
    updateRecognitionProgress(Math.max(recognitionProgressValue, 66), "Модель готова", "Анализирую фото на устройстве.");
  }
}

async function loadFood101Classifier() {
  if (localFood101Classifier) return localFood101Classifier;

  const transformers = await loadTransformersModule();
  if (transformers.env) {
    transformers.env.allowLocalModels = false;
    transformers.env.allowRemoteModels = true;
  }

  localFood101Classifier = await transformers.pipeline(
    "image-classification",
    "onnx-community/swin-finetuned-food101-ONNX",
    { progress_callback: handleFood101Progress }
  );

  return localFood101Classifier;
}

async function recognizeFoodWithFood101(imageDataUrls) {
  const images = asImageArray(imageDataUrls);
  updateRecognitionProgress(10, "Готовлю локальную модель еды", "Используется Food-101 и русский словарь популярных продуктов. Фото остаётся на устройстве.");
  const classifier = await loadFood101Classifier();

  const allCandidates = [];
  for (let i = 0; i < images.length; i++) {
    updateRecognitionProgress(68 + (i / Math.max(1, images.length)) * 20, "Анализирую фото", `Фото ${i + 1} из ${images.length}.`);
    const predictions = await classifier(images[i], { topk: 5 });
    for (const prediction of predictions || []) {
      const mapped = mapFood101Label(prediction.label);
      allCandidates.push({
        ...mapped,
        confidence: Number(prediction.score || 0),
        notes: "Food-101 нашла похожее блюдо. Словарь добавит более привычные варианты продуктов.",
        source: "food101"
      });
    }
  }

  const enrichedCandidates = addSmartDictionaryCandidates(allCandidates);
  const candidates = mergePhotoCandidates(enrichedCandidates, 7).map(candidate => ({
    ...candidate,
    notes: images.length > 1
      ? `${candidate.notes} Учтено фото: ${images.length}.`
      : candidate.notes
  }));

  updateRecognitionProgress(90, "Готовлю варианты", "Сверяю результат с русским словарём популярных продуктов.");
  return { candidates, provider: "food101" };
}

function mergePhotoCandidates(allCandidates, limit = 5) {
  const byName = new Map();

  for (const candidate of allCandidates) {
    const key = normalizeFoodName(candidate.normalizedName || candidate.name);
    if (!key) continue;

    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...candidate, seenCount: 1, bestConfidence: candidate.confidence || 0 });
      continue;
    }

    existing.seenCount += 1;
    existing.bestConfidence = Math.max(existing.bestConfidence || 0, candidate.confidence || 0);
    existing.confidence = Math.max(existing.confidence || 0, candidate.confidence || 0);
    existing.isFood = existing.isFood || candidate.isFood;
  }

  return [...byName.values()]
    .map(candidate => {
      const boost = candidate.seenCount > 1 ? Math.min(0.12, 0.06 * (candidate.seenCount - 1)) : 0;
      const confidence = Math.min(0.99, (candidate.bestConfidence || candidate.confidence || 0) + boost);
      return { ...candidate, confidence };
    })
    .sort((a, b) => Number(b.isFood) - Number(a.isFood) || b.confidence - a.confidence)
    .slice(0, limit);
}

async function recognizeFoodWithMobileNet(imageDataUrls) {
  updateRecognitionProgress(Math.max(recognitionProgressValue, 20), "Запускаю быстрый локальный режим", "Если Food-101 не загрузилась, приложение использует запасную модель MobileNet.");
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js");
  await loadScriptOnce("https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1");

  if (!localImageModel) {
    localImageModel = await mobilenet.load({ version: 2, alpha: 0.5 });
  }

  const images = asImageArray(imageDataUrls);
  const allCandidates = [];

  for (let i = 0; i < images.length; i++) {
    updateRecognitionProgress(55 + (i / Math.max(1, images.length)) * 30, "Анализирую фото", `Быстрый режим: фото ${i + 1} из ${images.length}.`);
    const img = await loadImage(images[i]);
    const predictions = await localImageModel.classify(img, 5);
    for (const p of predictions) {
      const mapped = mapImageLabel(p.className);
      allCandidates.push({
        ...mapped,
        confidence: Number(p.probability || 0),
        notes: mapped.isFood ? "Быстрая локальная модель нашла похожий вариант. Проверьте перед сохранением." : "Быстрая локальная модель не уверена. Проверьте вручную.",
        source: "mobilenet"
      });
    }
  }

  const candidates = mergePhotoCandidates(allCandidates).map(candidate => ({
    ...candidate,
    notes: images.length > 1
      ? `${candidate.notes} Учтено фото: ${images.length}.`
      : candidate.notes
  }));

  return { candidates, provider: "mobilenet" };
}

async function recognizeFoodWithHybridLocal(imageDataUrls) {
  const images = asImageArray(imageDataUrls);
  const food101Result = await recognizeFoodWithFood101(images);
  let allCandidates = [...(food101Result.candidates || [])];

  try {
    updateRecognitionProgress(92, "Проверяю популярные продукты", "Дополняю Food-101 быстрым локальным распознаванием и словарём продуктов.");
    const mobileNetResult = await recognizeFoodWithMobileNet(images);
    allCandidates.push(...(mobileNetResult.candidates || []));
  } catch (e) {
    console.warn("MobileNet extra check failed", e);
  }

  const candidates = mergePhotoCandidates(addSmartDictionaryCandidates(allCandidates), 7).map(candidate => ({
    ...candidate,
    notes: candidate.source === "smart_dictionary"
      ? candidate.notes
      : `${candidate.notes || "Проверьте вариант перед сохранением."} Результат улучшен словарём популярных продуктов.`
  }));

  updateRecognitionProgress(97, "Собираю итог", "Показываю лучшие варианты из модели и словаря.");
  return { candidates, provider: "hybrid" };
}

async function recognizeFoodLocally(imageDataUrls) {
  try {
    return await recognizeFoodWithHybridLocal(imageDataUrls);
  } catch (e) {
    console.warn("Hybrid local recognition failed, falling back to MobileNet", e);
    const fallback = await recognizeFoodWithMobileNet(imageDataUrls);
    fallback.warning = `Улучшенная локальная модель не загрузилась: ${e.message}. Использую быстрый локальный режим.`;
    return fallback;
  }
}

async function recognizeFoodWithOpenAI(imageDataUrls) {
  const apiKey = state.ai?.openAiApiKey?.trim();
  if (!apiKey) throw new Error("OpenAI API-ключ не указан");

  const images = asImageArray(imageDataUrls);

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
            text: `Определи еду или продукт на фото. Если фото несколько, считай, что это один и тот же продукт/блюдо с разных ракурсов. Не рассчитывай КБЖУ. Верни 1-5 кандидатов. Если это готовое блюдо, укажи state=dish. Если не уверен, снизь confidence. Названия обязательно верни на русском. Фото: ${images.length}.`
          },
          ...images.map(imageDataUrl => ({ type: "input_image", image_url: imageDataUrl, detail: "low" }))
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
    candidates: (parsed.candidates || []).map(c => russianizeCandidate({ ...c, source: "openai", isFood: true })),
    provider: "openai"
  };
}

async function recognizeFoodPhoto(imageDataUrls) {
  if (state.ai?.useOpenAI && state.ai?.openAiApiKey?.trim()) {
    try {
      return await recognizeFoodWithOpenAI(imageDataUrls);
    } catch (e) {
      const localResult = await recognizeFoodLocally(imageDataUrls);
      localResult.warning = `OpenAI недоступен: ${e.message}. Использую локальную модель.`;
      return localResult;
    }
  }
  return recognizeFoodLocally(imageDataUrls);
}

function openPhotoPicker(mode = "new") {
  photoInputMode = mode;
  $("photoInput").click();
}

function renderPhotoPreviews() {
  const box = $("recognitionPreviews");
  if (!box) return;

  if (!photoImageDataUrls.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }

  box.hidden = false;
  box.innerHTML = `
    <div class="photoPreviewsHead">Участвуют ${photoImageDataUrls.length} из 3 фото</div>
    <div class="photoThumbsRow">
      ${photoImageDataUrls.map((src, index) => `
        <button class="photoThumb" type="button" onclick="zoomRecognitionPhoto(${index})" aria-label="Открыть фото ${index + 1}">
          <img src="${src}" alt="Фото ${index + 1}">
          <span>${index + 1}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function zoomRecognitionPhoto(index) {
  const src = photoImageDataUrls[index];
  if (!src) return;
  $("photoZoomImage").src = src;
  $("photoZoomDialog").showModal();
}

function closePhotoZoomDialog() {
  $("photoZoomDialog").close();
  $("photoZoomImage").src = "";
}

function setRecognitionSearchVisible(visible, value = "") {
  const form = $("recognitionSearchForm");
  if (!form) return;
  form.hidden = !visible;
  if (value) $("recognitionSearchInput").value = value;
}

function scrollRecognitionDialogTop() {
  const area = $("recognitionScrollArea");
  if (!area) return;
  area.scrollTo({ top: 0, behavior: "smooth" });
}

async function rerunPhotoRecognition() {
  renderPhotoPreviews();
  const count = photoImageDataUrls.length;
  const providerText = state.ai?.useOpenAI && state.ai?.openAiApiKey ? "через OpenAI" : "локально через Food-101 + словарь";
  $("recognitionStatus").textContent = `Распознаю ${providerText}. Фото: ${count}...`;
  $("recognitionList").innerHTML = "";
  setRecognitionSearchVisible(false);
  setRecognitionLoader(true, "Распознаю продукт", count > 1 ? `Анализирую ${count} фото одного продукта.` : "Первый запуск может занять дольше из-за загрузки локальной модели еды.");
  startSoftRecognitionProgress(7, 88);

  try {
    const result = await recognizeFoodPhoto(photoImageDataUrls);
    stopSoftRecognitionProgress();
    updateRecognitionProgress(100, "Готово", "Показываю варианты распознавания.");
    await sleep(180);
    hideRecognitionLoader();
    renderRecognitionCandidates(result.candidates || [], result.warning || "");
  } catch (e) {
    stopSoftRecognitionProgress();
    hideRecognitionLoader();
    throw e;
  }
}

async function handlePhotoSelected(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const modeAtSelect = photoInputMode;

  try {
    if (!$('recognitionDialog').open) $("recognitionDialog").showModal();
    scrollRecognitionDialogTop();
    setRecognitionSearchVisible(false);

    if (modeAtSelect === "new") {
      photoImageDataUrls = [];
      photoCandidates = [];
    }

    if (modeAtSelect === "add" && photoImageDataUrls.length >= 3) {
      $("recognitionStatus").textContent = "Уже участвуют 3 фото. Этого достаточно для распознавания.";
      renderPhotoPreviews();
      return;
    }

    $("recognitionStatus").textContent = modeAtSelect === "add"
      ? `Добавляю фото ${photoImageDataUrls.length + 1} из 3. Предыдущие фото сохраняются.`
      : "Готовлю новое фото...";
    $("recognitionList").innerHTML = "";

    const imageDataUrl = await resizeImageToDataUrl(file);
    photoImageDataUrls.push(imageDataUrl);
    renderPhotoPreviews();
    await rerunPhotoRecognition();
  } catch (e) {
    hideRecognitionLoader();
    setRecognitionSearchVisible(true);
    $("recognitionStatus").textContent = e.message || "Не удалось распознать фото. Можно ввести название вручную и выполнить поиск.";
    $("recognitionList").innerHTML = "";
  } finally {
    photoInputMode = "new";
    event.target.value = "";
  }
}

function renderRecognitionCandidates(candidates, warning = "") {
  photoCandidates = candidates;

  if (!candidates.length) {
    hideRecognitionLoader();
    setRecognitionSearchVisible(true);
    $("recognitionStatus").textContent = warning || "Не удалось определить продукт. Введите своё название и выполните поиск.";
    $("recognitionList").innerHTML = "";
    return;
  }

  setRecognitionSearchVisible(true);
  const photoCountText = photoImageDataUrls.length > 1 ? ` Участвуют ${photoImageDataUrls.length} фото.` : "";
  $("recognitionStatus").textContent = warning || `Все варианты показаны по-русски.${photoCountText} Можно выбрать вариант или ввести своё название выше.`;
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
  scrollRecognitionDialogTop();
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

  const queries = [candidate.normalizedName || candidate.name, candidate.searchName]
    .map(x => String(x || "").trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);

  let lastError = null;
  for (const query of queries) {
    try {
      return await fetchOpenFoodFactsByName(query);
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error("БЖУ не найдено");
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

function resetPhotoRecognitionState() {
  hideRecognitionLoader();
  photoCandidates = [];
  photoImageDataUrls = [];
  photoInputMode = "new";
  renderPhotoPreviews();
  setRecognitionSearchVisible(false);
  $("recognitionSearchInput").value = "";
  $("recognitionList").innerHTML = "";
}

function closeRecognitionDialog() {
  $("recognitionDialog").close();
  resetPhotoRecognitionState();
}

function openManualFromRecognition() {
  $("recognitionDialog").close();
  resetPhotoRecognitionState();
  openFoodDialog();
}

function retakeRecognitionPhoto() {
  $("recognitionStatus").textContent = "Сделайте новое фото. Старые фото заменятся только после выбора нового снимка.";
  openPhotoPicker("new");
}

function addRecognitionPhoto() {
  if (photoImageDataUrls.length >= 3) {
    $("recognitionStatus").textContent = "Уже участвуют 3 фото. Можно выбрать вариант или сделать новое фото с нуля.";
    renderPhotoPreviews();
    return;
  }
  $("recognitionStatus").textContent = `Добавьте ещё фото. Сейчас участвуют ${photoImageDataUrls.length} фото, они не удалятся.`;
  renderPhotoPreviews();
  openPhotoPicker("add");
}

async function searchNutritionByCustomRecognitionWord(event) {
  event.preventDefault();
  const query = $("recognitionSearchInput").value.trim();
  if (!query) {
    $("recognitionSearchInput").focus();
    return;
  }

  $("recognitionStatus").textContent = `Ищу КБЖУ по запросу «${query}»...`;
  $("recognitionList").innerHTML = "";
  setRecognitionLoader(true, "Ищу продукт", "Пробую найти КБЖУ по вашему названию.");
  updateRecognitionProgress(35, "Ищу продукт", "Запрос к базе продуктов...");

  try {
    const product = await fetchOpenFoodFactsByName(query);
    hideRecognitionLoader();
    $("recognitionDialog").close();
    resetPhotoRecognitionState();
    product.name = product.name || query;
    product.source = `${product.source}; найдено по вашему запросу «${query}»`;
    openFoodDialog(product);
  } catch (e) {
    hideRecognitionLoader();
    $("recognitionDialog").close();
    resetPhotoRecognitionState();
    openFoodDialog({
      id: uid(),
      date: state.selectedDate,
      barcode: "",
      name: query,
      grams: 100,
      kcal100: 0,
      protein100: 0,
      fat100: 0,
      carbs100: 0,
      meal: "Перекус",
      source: `По запросу «${query}» КБЖУ не найдено. Введите значения вручную.`
    });
  }
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

function portionFactor() {
  const grams = Math.max(0, Number($("gramsInput").value) || 0);
  return grams / 100 || 1;
}

function nutrientInputIds() {
  return [
    ["kcal100", "kcalInput"],
    ["protein100", "proteinInput"],
    ["fat100", "fatInput"],
    ["carbs100", "carbsInput"]
  ];
}

function setPortionNutrientInputsFromBase() {
  if (foodDialogUpdating) return;
  foodDialogUpdating = true;
  const factor = portionFactor();
  for (const [key, inputId] of nutrientInputIds()) {
    $(inputId).value = format1((foodDialogBase100[key] || 0) * factor);
  }
  foodDialogUpdating = false;
}

function setBaseNutrientsFromPortionInputs() {
  if (foodDialogUpdating) return;
  const factor = portionFactor();
  for (const [key, inputId] of nutrientInputIds()) {
    foodDialogBase100[key] = round1((Number($(inputId).value) || 0) / factor);
  }
}

function openFoodDialog(entry = null) {
  $("foodDialogTitle").textContent = entry?.id && state.entries.some(x => x.id === entry.id) ? "Редактировать продукт" : "Добавить продукт";
  $("entryId").value = entry?.id || "";
  $("nameInput").value = entry?.name || "";
  $("barcodeInput").value = entry?.barcode || "";
  $("mealInput").value = entry?.meal || "Перекус";
  $("gramsInput").value = entry?.grams ?? 100;
  foodDialogBase100 = {
    kcal100: round1(entry?.kcal100 ?? 0),
    protein100: round1(entry?.protein100 ?? 0),
    fat100: round1(entry?.fat100 ?? 0),
    carbs100: round1(entry?.carbs100 ?? 0)
  };
  setPortionNutrientInputsFromBase();
  $("sourceInfo").textContent = entry?.source || "Ручной ввод";
  $("foodDialog").showModal();
}

function closeFoodDialogWithoutSaving() {
  $("foodDialog").close();
}

function readFoodForm() {
  setBaseNutrientsFromPortionInputs();
  return {
    id: $("entryId").value || uid(),
    date: state.selectedDate,
    barcode: $("barcodeInput").value.trim(),
    name: $("nameInput").value.trim(),
    meal: $("mealInput").value,
    grams: round1($("gramsInput").value),
    kcal100: round1(foodDialogBase100.kcal100),
    protein100: round1(foodDialogBase100.protein100),
    fat100: round1(foodDialogBase100.fat100),
    carbs100: round1(foodDialogBase100.carbs100),
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

$("closeFoodDialog").addEventListener("click", closeFoodDialogWithoutSaving);

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
  $("analyticsTab").classList.toggle("hidden", tab !== "analytics");

  const targetId = ({
    diary: "diaryTab",
    history: "historyTab",
    weight: "weightTab",
    export: "exportTab",
    analytics: "analyticsTab"
  })[tab] || "diaryTab";

  requestAnimationFrame(() => {
    const target = $(targetId);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => target.focus({ preventScroll: true }), 250);
  });
}

function selectHistoryDate(date) {
  state.selectedDate = date;
  render();
  switchTab("diary");
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

let modalScrollY = 0;
function updateDialogBodyLock() {
  const hasOpenDialog = [...document.querySelectorAll("dialog")].some(dialog => dialog.open);
  if (hasOpenDialog && !document.body.classList.contains("modalOpen")) {
    modalScrollY = window.scrollY || 0;
    document.body.style.top = `-${modalScrollY}px`;
    document.body.classList.add("modalOpen");
  } else if (!hasOpenDialog && document.body.classList.contains("modalOpen")) {
    document.body.classList.remove("modalOpen");
    document.body.style.top = "";
    window.scrollTo(0, modalScrollY);
  }
}

function setupDialogBodyLock() {
  const nativeShowModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function(...args) {
    const result = nativeShowModal.apply(this, args);
    updateDialogBodyLock();
    return result;
  };
  document.querySelectorAll("dialog").forEach(dialog => {
    dialog.addEventListener("close", updateDialogBodyLock);
    dialog.addEventListener("cancel", () => setTimeout(updateDialogBodyLock, 0));
  });
}

setupDialogBodyLock();

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
$("closePhotoZoom").addEventListener("click", closePhotoZoomDialog);
$("photoZoomDialog").addEventListener("click", e => {
  if (e.target.id === "photoZoomDialog") closePhotoZoomDialog();
});
$("recognitionSearchForm").addEventListener("submit", searchNutritionByCustomRecognitionWord);
$("toggleAiKeyBtn").addEventListener("click", () => {
  const input = $("openAiKeyInput");
  const button = $("toggleAiKeyBtn");
  const shouldShow = input.type === "password";
  input.type = shouldShow ? "text" : "password";
  button.textContent = shouldShow ? "Скрыть" : "Показать";
});

$("scanBtn").addEventListener("click", openScanner);
$("photoBtn").addEventListener("click", () => openPhotoPicker("new"));
$("photoInput").addEventListener("change", handlePhotoSelected);
$("closeRecognition").addEventListener("click", closeRecognitionDialog);
$("recognitionBackBtn").addEventListener("click", closeRecognitionDialog);
$("recognitionRetakeBtn").addEventListener("click", retakeRecognitionPhoto);
$("recognitionAddPhotoBtn").addEventListener("click", addRecognitionPhoto);
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
$("closeSettingsDialog").addEventListener("click", () => $("settingsDialog").close());
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


$("gramsInput").addEventListener("input", setPortionNutrientInputsFromBase);
["kcalInput", "proteinInput", "fatInput", "carbsInput"].forEach(id => {
  $(id).addEventListener("input", setBaseNutrientsFromPortionInputs);
});
$("calorieCard").addEventListener("click", () => switchTab("analytics"));
$("calorieCard").addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    switchTab("analytics");
  }
});
$("analyticsTodayBtn").addEventListener("click", () => {
  state.selectedDate = todayISO();
  render();
  switchTab("analytics");
});

document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

render();
