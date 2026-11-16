// API_URL нь config.js-ээс ирнэ

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");

const form = document.getElementById("login-form");
const messageEl = document.getElementById("message");
const submitBtn = document.getElementById("submit-btn");

const PAGE_TITLES = {
  dashboard: "Хяналт",
  tours: "Аялал",
  bookings: "Захиалга",
  customers: "Үйлчлүүлэгч",
  guides: "Хөтөч",
  forecast: "Эрэлт таамаглах",
  facebook: "Facebook",
};

// ---------- Токен ----------
function getToken() {
  return sessionStorage.getItem("token");
}

function logout() {
  sessionStorage.removeItem("token");
  location.hash = "";
  showLogin();
}

// ---------- Нэвтрэх ----------
function showMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = "message " + type;
}

function showLogin() {
  appView.hidden = true;
  loginView.hidden = false;
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
  route();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = form.email.value.trim();
  const password = form.password.value;

  if (!email || !password) {
    showMessage("Имэйл болон нууц үгээ оруулна уу.", "error");
    return;
  }

  submitBtn.disabled = true;
  showMessage("Шалгаж байна...", "");

  try {
    const response = await fetch(`${API_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (response.status === 401) {
      showMessage("Имэйл эсвэл нууц үг буруу байна.", "error");
      return;
    }
    if (!response.ok) {
      showMessage("Серверт алдаа гарлаа. Дахин оролдоно уу.", "error");
      return;
    }

    const data = await response.json();
    sessionStorage.setItem("token", data.access_token);
    form.reset();
    showMessage("", "");
    location.hash = "#dashboard";
    showApp();
  } catch (err) {
    showMessage("Сервертэй холбогдож чадсангүй.", "error");
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("logout-btn").addEventListener("click", logout);

// ---------- Цэс солих ----------
function route() {
  const page = location.hash.slice(1) || "dashboard";
  const name = PAGE_TITLES[page] ? page : "dashboard";

  document.querySelectorAll("#menu a").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === name);
  });

  // Өөрийн гэсэн хуудастай цэсүүд
  const ownPages = ["dashboard", "tours", "bookings", "customers", "guides", "forecast", "facebook"];
  for (const p of ownPages) {
    document.getElementById(`page-${p}`).hidden = name !== p;
  }

  const isSoon = !ownPages.includes(name);
  document.getElementById("page-soon").hidden = !isSoon;
  if (isSoon) document.getElementById("soon-title").textContent = PAGE_TITLES[name];

  if (name === "dashboard") {
    loadStats();
    loadTopDemand();
  }
  if (name === "forecast") loadDemandTable();
  if (name === "tours") getToursPage().load();
  if (name === "bookings") getBookingsPage().load();
  if (name === "customers") getCustomersPage().load();
  if (name === "guides") getGuidesPage().load();
}

// Сонголтын жагсаалтыг нэрээр нь цагаан толгойн дарааллаар эрэмбэлнэ
const byLabel = (a, b) => a.label.localeCompare(b.label, "mn");

// ---------- Үйлчлүүлэгч (ерөнхий CRUD функцээр) ----------
let customersPage = null;

function getCustomersPage() {
  if (!customersPage) {
    customersPage = createCrudPage({
      container: document.getElementById("customers-crud"),
      endpoint: "/customers",
      idKey: "customer_id",
      itemName: "үйлчлүүлэгч",
      describe: (c) => c.full_name,
      searchKeys: ["full_name", "country", "email"],
      columns: [
        { key: "full_name", label: "Нэр" },
        { key: "country", label: "Улс" },
        { key: "email", label: "И-мэйл" },
        { key: "booking_count", label: "Захиалга", align: "right" },
      ],
      fields: [
        { name: "full_name", label: "Нэр", type: "text", required: true, maxLength: 100 },
        { name: "country", label: "Улс", type: "text", maxLength: 50 },
        { name: "email", label: "И-мэйл", type: "email", maxLength: 100 },
      ],
    });
  }
  return customersPage;
}

// ---------- Хөтөч (ерөнхий CRUD функцээр) ----------
let guidesPage = null;

function getGuidesPage() {
  if (!guidesPage) {
    guidesPage = createCrudPage({
      container: document.getElementById("guides-crud"),
      endpoint: "/guides",
      idKey: "guide_id",
      itemName: "хөтөч",
      describe: (g) => g.full_name,
      searchKeys: ["full_name", "language"],
      columns: [
        { key: "full_name", label: "Нэр" },
        { key: "language", label: "Хэл" },
        {
          key: "experience_years",
          label: "Туршлага",
          align: "right",
          format: (v) => (v == null ? "—" : `${v} жил`),
        },
        { key: "tour_count", label: "Хариуцсан аялал", align: "right" },
      ],
      fields: [
        { name: "full_name", label: "Нэр", type: "text", required: true, maxLength: 100 },
        { name: "language", label: "Хэл", type: "text", maxLength: 30 },
        { name: "experience_years", label: "Туршлага (жил)", type: "number", min: 0, max: 80, step: 1 },
      ],
    });
  }
  return guidesPage;
}

// ---------- Захиалга (ерөнхий CRUD функцээр) ----------
const BOOKING_STATUS = {
  pending: "Хүлээгдэж буй",
  confirmed: "Батлагдсан",
  cancelled: "Цуцлагдсан",
};
const statusOptions = Object.entries(BOOKING_STATUS).map(([value, label]) => ({ value, label }));

function setBookingStatus(row, status) {
  return apiFetch(`/bookings/${row.booking_id}/status`, { method: "PATCH", body: { status } });
}

let bookingsPage = null;

function getBookingsPage() {
  if (!bookingsPage) {
    bookingsPage = createCrudPage({
      container: document.getElementById("bookings-crud"),
      endpoint: "/bookings",
      idKey: "booking_id",
      itemName: "захиалга",
      describe: (b) => `№${b.booking_id} – ${b.customer_name}`,
      searchKeys: ["customer_name", "tour_name", "booking_id"],
      countLabel: (n) => `Сүүлийн ${n}`,
      filters: [{ name: "status", label: "Бүх төлөв", options: statusOptions }],
      columns: [
        { key: "booking_id", label: "№" },
        { key: "booked_at", label: "Огноо" },
        { key: "customer_name", label: "Үйлчлүүлэгч" },
        { key: "tour_name", label: "Аялал" },
        { key: "people", label: "Хүн", align: "right" },
        {
          key: "paid_amount",
          label: "Төлсөн",
          align: "right",
          format: (v) => (v > 0 ? numberFmt.format(v) + " ₮" : "—"),
        },
        {
          key: "status",
          label: "Төлөв",
          format: (v) => BOOKING_STATUS[v] || v,
          cellClass: (v) => `status status-${v}`,
        },
      ],
      fields: [
        {
          name: "tour_id",
          label: "Аялал",
          type: "select",
          required: true,
          numeric: true,
          options: async () =>
            (await apiFetch("/tours")).map((t) => ({
              value: t.tour_id,
              label: t.start_date ? `${t.name} (${t.start_date})` : t.name,
            })),
        },
        {
          name: "customer_id",
          label: "Үйлчлүүлэгч",
          type: "select",
          required: true,
          numeric: true,
          options: async () =>
            (await apiFetch("/customers")).map((c) => ({
              value: c.customer_id,
              label: c.country ? `${c.full_name} (${c.country})` : c.full_name,
            })).sort(byLabel),
        },
        { name: "people", label: "Хүний тоо", type: "number", required: true, min: 1, step: 1, default: 1 },
        {
          name: "status",
          label: "Төлөв",
          type: "select",
          required: true,
          default: "pending",
          options: async () => statusOptions,
        },
      ],
      // Зөвхөн хүлээгдэж буй захиалгад Батлах / Цуцлах
      rowActions: [
        {
          label: "Батлах",
          className: "success",
          show: (b) => b.status === "pending",
          run: (b) => setBookingStatus(b, "confirmed"),
          success: "Захиалга батлагдлаа",
        },
        {
          label: "Цуцлах",
          className: "warning",
          show: (b) => b.status === "pending",
          run: (b) => setBookingStatus(b, "cancelled"),
          success: "Захиалга цуцлагдлаа",
        },
      ],
      // Төлбөртэй захиалгыг устгаж болохгүй → цуцлахыг санал болгоно
      deleteFallback: {
        label: "Цуцлах",
        show: (b) => b.status !== "cancelled",
        run: (b) => setBookingStatus(b, "cancelled"),
        success: "Захиалга цуцлагдлаа",
      },
    });
  }
  return bookingsPage;
}

// ---------- Аялал (ерөнхий CRUD функцээр) ----------
let toursPage = null;

function getToursPage() {
  if (!toursPage) {
    toursPage = createCrudPage({
      container: document.getElementById("tours-crud"),
      endpoint: "/tours",
      idKey: "tour_id",
      itemName: "аялал",
      describe: (t) => t.name,
      searchKeys: ["name", "destination", "guide_name"],
      columns: [
        { key: "name", label: "Нэр" },
        { key: "destination", label: "Чиглэл" },
        { key: "days", label: "Хоног", align: "right" },
        { key: "price", label: "Үнэ", align: "right", format: (v) => numberFmt.format(v) + " ₮" },
        { key: "guide_name", label: "Хөтөч" },
        { key: "booking_count", label: "Захиалга", align: "right" },
      ],
      fields: [
        { name: "name", label: "Нэр", type: "text", required: true, maxLength: 100 },
        { name: "destination", label: "Чиглэл", type: "text", maxLength: 50 },
        { name: "days", label: "Хоног", type: "number", required: true, min: 1, step: 1 },
        { name: "price", label: "Үнэ (₮)", type: "number", required: true, min: 1, step: "any" },
        { name: "start_date", label: "Эхлэх огноо", type: "date" },
        {
          name: "guide_id",
          label: "Хөтөч",
          type: "select",
          numeric: true,
          options: async () =>
            (await apiFetch("/guides")).map((g) => ({ value: g.guide_id, label: g.full_name })).sort(byLabel),
        },
      ],
    });
  }
  return toursPage;
}

// crud.js-ийн apiFetch 401 авбал үүнийг дуудна
function onSessionExpired() {
  logout();
  showMessage("Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.", "error");
}

window.addEventListener("hashchange", () => {
  if (getToken()) route();
});

// ---------- Хяналт ----------
const numberFmt = new Intl.NumberFormat("mn-MN");

async function loadStats() {
  const errorEl = document.getElementById("stats-error");
  errorEl.textContent = "";

  try {
    const response = await fetch(`${API_URL}/admin/stats`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });

    // Токены хугацаа дууссан бол дахин нэвтрүүлнэ
    if (response.status === 401) {
      logout();
      showMessage("Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.", "error");
      return;
    }
    if (!response.ok) throw new Error("HTTP " + response.status);

    const s = await response.json();
    document.getElementById("stat-tours").textContent = numberFmt.format(s.tours);
    document.getElementById("stat-bookings").textContent = numberFmt.format(s.bookings);
    document.getElementById("stat-pending").textContent = numberFmt.format(s.pending);
    document.getElementById("stat-revenue").textContent = numberFmt.format(s.revenue) + " ₮";

    renderPending(s.pending_bookings);
  } catch (err) {
    errorEl.textContent = "Мэдээлэл ачаалж чадсангүй. Сервер ажиллаж байгаа эсэхийг шалгана уу.";
  }
}

function renderPending(rows) {
  const tbody = document.getElementById("pending-body");
  tbody.replaceChildren();

  if (!rows.length) {
    const tr = tbody.insertRow();
    const td = tr.insertCell();
    td.colSpan = 5;
    td.className = "empty";
    td.textContent = "Батлагдаагүй захиалга алга";
    return;
  }

  for (const b of rows) {
    const tr = tbody.insertRow();
    // textContent ашигладаг тул нэр дотор HTML байсан ч аюулгүй
    tr.insertCell().textContent = b.booking_id;
    tr.insertCell().textContent = b.customer;
    tr.insertCell().textContent = b.tour;
    const people = tr.insertCell();
    people.textContent = b.people;
    people.className = "num";
    tr.insertCell().textContent = b.booked_at;
  }
}

// ---------- Эхлэх ----------
if (getToken()) {
  showApp();
} else {
  showLogin();
}


// =====================================================================
//  Эрэлт таамаглах
// =====================================================================
const decimalFmt = new Intl.NumberFormat("mn-MN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtPred = (v) => (v == null ? "—" : decimalFmt.format(v));

// Хүснэгтийн мөрүүдийг зурах жижиг туслах: cells = [{ text, cls? }]
function fillTable(tbody, rows, colCount, toCells, emptyText) {
  tbody.replaceChildren();
  if (!rows.length) {
    const td = tbody.insertRow().insertCell();
    td.colSpan = colCount;
    td.className = "empty";
    td.textContent = emptyText;
    return;
  }
  for (const row of rows) {
    const tr = tbody.insertRow();
    for (const c of toCells(row)) {
      const td = tr.insertCell();
      td.textContent = c.text;
      if (c.cls) td.className = c.cls;
    }
  }
}

// ---------- Хяналт: эрэлттэй 5 аялал ----------
async function loadTopDemand() {
  const errorEl = document.getElementById("top-demand-error");
  const tbody = document.getElementById("top-demand-body");
  errorEl.textContent = "";
  try {
    const rows = await apiFetch("/demand/tours?limit=5");
    fillTable(tbody, rows, 4, (t) => [
      { text: t.name },
      { text: t.destination ?? "—" },
      { text: numberFmt.format(t.actual_bookings), cls: "num" },
      { text: fmtPred(t.predicted_bookings), cls: "num" },
    ], "Мэдээлэл алга");
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

// ---------- Эрэлт таамаглах: 10 аяллын хүснэгт ----------
async function loadDemandTable() {
  const errorEl = document.getElementById("demand-error");
  const tbody = document.getElementById("demand-body");
  errorEl.textContent = "";
  try {
    const rows = await apiFetch("/demand/tours?limit=10");
    fillTable(tbody, rows, 7, (t) => {
      const diff = t.predicted_bookings == null ? null : t.predicted_bookings - t.actual_bookings;
      return [
        { text: t.name },
        { text: t.days, cls: "num" },
        { text: t.price_per_day == null ? "—" : numberFmt.format(Math.round(t.price_per_day)) + " ₮", cls: "num" },
        { text: t.guide_name ? `${t.guide_name} (${t.guide_experience ?? "?"} жил)` : "—" },
        { text: numberFmt.format(t.actual_bookings), cls: "num" },
        { text: fmtPred(t.predicted_bookings), cls: "num" },
        {
          text: diff == null ? "—" : (diff > 0 ? "+" : "") + decimalFmt.format(diff),
          cls: "num " + (diff == null ? "" : diff < 0 ? "diff-neg" : "diff-pos"),
        },
      ];
    }, "Мэдээлэл алга");
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

// ---------- Эрэлт таамаглах: форм ----------
const predictForm = document.getElementById("predict-form");
const predictBtn = document.getElementById("predict-btn");
const predictValue = document.getElementById("predict-value");
const predictNote = document.getElementById("predict-note");

predictForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!predictForm.reportValidity()) return;

  const params = new URLSearchParams({
    price_per_day: predictForm.price_per_day.value,
    guide_experience: predictForm.guide_experience.value,
    days: predictForm.days.value,
  });

  predictBtn.disabled = true;
  predictNote.className = "muted";
  predictNote.textContent = "Тооцоолж байна...";
  try {
    const r = await apiFetch(`/predict-demand?${params}`);
    predictValue.textContent = fmtPred(r.predicted_bookings);
    predictNote.textContent =
      `Өдрийн үнэ ${numberFmt.format(r.price_per_day)} ₮, ${r.guide_experience} жил туршлагатай хөтөч, ` +
      `${r.days} хоногийн аялалд ойролцоогоор ${fmtPred(r.predicted_bookings)} захиалга ирнэ.`;
  } catch (err) {
    predictValue.textContent = "–";
    predictNote.className = "message error";
    predictNote.textContent = err.message;
  } finally {
    predictBtn.disabled = false;
  }
});
