// =====================================================================
//  Ерөнхий CRUD функц: хүснэгт + хайлт + Нэмэх / Засах / Устгах
//  Аялал, Захиалга, Үйлчлүүлэгч, Хөтөч ... аль ч цэсэнд дахин ашиглана.
// =====================================================================

// ---------- API туслах ----------
// Токеныг автоматаар нэмж, 401 ирвэл гаргана. Алдааны мессежийг серверээс уншина.
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = sessionStorage.getItem("token");
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error("Сервертэй холбогдож чадсангүй.");
  }

  if (response.status === 401) {
    if (typeof onSessionExpired === "function") onSessionExpired();
    throw new Error("Нэвтрэх хугацаа дууссан.");
  }
  if (response.status === 204) return null;

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    let msg = "Алдаа гарлаа. Дахин оролдоно уу.";
    if (data && typeof data.detail === "string") msg = data.detail;
    else if (data && Array.isArray(data.detail)) msg = "Оруулсан мэдээлэл буруу байна. Талбаруудаа шалгана уу.";
    throw new Error(msg);
  }
  return data;
}

// ---------- Жижиг мэдэгдэл (toast) ----------
function showToast(text, type = "success") {
  let box = document.getElementById("toast");
  if (!box) {
    box = document.createElement("div");
    box.id = "toast";
    box.setAttribute("role", "status");
    document.body.appendChild(box);
  }
  box.textContent = text;
  box.className = `toast show ${type}`;
  clearTimeout(box._timer);
  box._timer = setTimeout(() => (box.className = "toast"), 3000);
}

// ---------- Элемент үүсгэх товч функц ----------
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) {
    if (child != null) node.append(child);
  }
  return node;
}

/**
 * CRUD хуудас үүсгэнэ.
 *
 * cfg = {
 *   container:  HTMLElement            // хуудас зурах газар
 *   endpoint:   "/tours"               // API зам
 *   idKey:      "tour_id"              // мөрийн ID талбар
 *   itemName:   "аялал"                // мессежид ашиглах нэр
 *   describe:   row => row.name        // устгахаас өмнө асуухад харуулах нэр
 *   searchKeys: ["name", ...]          // хайлт хийх талбарууд
 *   columns:    [{ key, label, format?(value,row), align?: "right", cellClass?(value,row) }]
 *   fields:     [{ name, label, type: "text"|"number"|"date"|"select",
 *                  required?, min?, max?, step?, maxLength?,
 *                  numeric?: true,  // select-ийн утгыг тоо болгож илгээх
 *                  default?: утга   // шинээр нэмэх үеийн анхдагч утга
 *                  options?: async () => [{ value, label }] }]
 *
 *   --- Сонголттой ---
 *   filters:    [{ name, label, options: [{ value, label }] }]   // серверт ?name=value болж очно
 *   rowActions: [{ label, className?, show?(row), run: async row => шинэчлэгдсэн row, success? }]
 *   deleteFallback: { label, show?(row), run: async row => row, success? }
 *               // устгах боломжгүй үед (409) dialog дотор санал болгох өөр үйлдэл
 *   countLabel: n => "..."                                        // мөрийн тоог харуулах текст
 * }
 */
function createCrudPage(cfg) {
  let rows = [];
  let editingId = null; // null = шинээр нэмж байна

  // ----- Хэрэгслийн мөр: хайлт + Нэмэх -----
  const searchInput = el("input", {
    type: "search",
    placeholder: "Хайх...",
    className: "search",
  });
  searchInput.setAttribute("aria-label", "Хайх");
  const addBtn = el("button", { type: "button", textContent: "+ Нэмэх" });
  const countEl = el("span", { className: "count" });

  const filterSelects = {};
  for (const f of cfg.filters || []) {
    const select = el("select", { className: "filter" }, [
      el("option", { value: "", textContent: f.label }),
      ...f.options.map((o) => el("option", { value: o.value, textContent: o.label })),
    ]);
    select.setAttribute("aria-label", f.label);
    select.addEventListener("change", load);
    filterSelects[f.name] = select;
  }

  const toolbar = el("div", { className: "toolbar" }, [
    searchInput,
    ...Object.values(filterSelects),
    countEl,
    addBtn,
  ]);

  // Сонгосон шүүлтүүрүүдээс ?status=pending гэх мэт үүсгэнэ
  function filterQuery() {
    const params = new URLSearchParams();
    for (const [name, select] of Object.entries(filterSelects)) {
      if (select.value) params.set(name, select.value);
    }
    const q = params.toString();
    return q ? `?${q}` : "";
  }

  // Мөр одоогийн шүүлтүүрт таарч байна уу (жишээ нь батлагдсан бол "Хүлээгдэж буй" жагсаалтаас гарна)
  function fitsFilters(row) {
    return Object.entries(filterSelects).every(([name, select]) => !select.value || String(row[name]) === select.value);
  }

  // Нэг мөрийг шинэчлэх: шүүлтүүрт таарахгүй болсон бол жагсаалтаас хасна
  function replaceRow(updated) {
    const id = updated[cfg.idKey];
    rows = fitsFilters(updated)
      ? rows.map((r) => (r[cfg.idKey] === id ? updated : r))
      : rows.filter((r) => r[cfg.idKey] !== id);
  }

  // ----- Хүснэгт -----
  const headRow = el(
    "tr",
    {},
    cfg.columns
      .map((c) => el("th", { textContent: c.label, className: c.align === "right" ? "num" : "" }))
      .concat(el("th", { textContent: "", className: "actions" }))
  );
  const tbody = el("tbody");
  const table = el("div", { className: "table-wrap" }, el("table", {}, [el("thead", {}, headRow), tbody]));

  // ----- Нэмэх / Засах форм (dialog) -----
  const formTitle = el("h3");
  const formError = el("p", { className: "message error" });
  const form = el("form", { className: "crud-form", noValidate: false });
  const inputs = {};

  for (const f of cfg.fields) {
    const id = `${cfg.idKey}-${f.name}`;
    let input;
    if (f.type === "select") {
      input = el("select", { id, name: f.name, required: !!f.required });
    } else {
      input = el("input", { id, name: f.name, type: f.type || "text", required: !!f.required });
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
      if (f.step !== undefined) input.step = f.step;
      if (f.maxLength !== undefined) input.maxLength = f.maxLength;
    }
    inputs[f.name] = input;
    form.append(el("label", { htmlFor: id, textContent: f.label + (f.required ? " *" : "") }), input);
  }

  const cancelBtn = el("button", { type: "button", className: "secondary", textContent: "Болих" });
  const saveBtn = el("button", { type: "submit", textContent: "Хадгалах" });
  form.append(formError, el("div", { className: "dialog-actions" }, [cancelBtn, saveBtn]));

  const formDialog = el("dialog", { className: "dialog" }, [formTitle, form]);

  // ----- Устгахаас өмнө асуух dialog -----
  const confirmText = el("p");
  const confirmError = el("p", { className: "message error" });
  const confirmCancel = el("button", { type: "button", className: "secondary", textContent: "Болих" });
  const confirmOk = el("button", { type: "button", className: "danger", textContent: "Устгах" });
  const fallbackBtn = el("button", { type: "button", textContent: cfg.deleteFallback?.label || "", hidden: true });
  const confirmDialog = el("dialog", { className: "dialog" }, [
    el("h3", { textContent: "Устгах уу?" }),
    confirmText,
    confirmError,
    el("div", { className: "dialog-actions" }, [confirmCancel, fallbackBtn, confirmOk]),
  ]);
  let deletingRow = null;

  cfg.container.append(toolbar, table, formDialog, confirmDialog);

  // ----- Хүснэгт зурах -----
  function render() {
    const q = searchInput.value.trim().toLowerCase();
    const visible = q
      ? rows.filter((r) => cfg.searchKeys.some((k) => String(r[k] ?? "").toLowerCase().includes(q)))
      : rows;

    const total = cfg.countLabel ? cfg.countLabel(rows.length) : `Нийт ${rows.length}`;
    countEl.textContent = q ? `${visible.length} / ${total}` : total;
    tbody.replaceChildren();

    if (!visible.length) {
      tbody.append(
        el("tr", {}, el("td", {
          colSpan: cfg.columns.length + 1,
          className: "empty",
          textContent: q ? "Хайлтад тохирох мөр олдсонгүй" : "Мэдээлэл алга",
        }))
      );
      return;
    }

    for (const row of visible) {
      const tr = el("tr");
      for (const c of cfg.columns) {
        const value = row[c.key];
        const text = c.format ? c.format(value, row) : value ?? "—";
        const cls = [c.align === "right" ? "num" : "", c.cellClass ? c.cellClass(value, row) : ""].join(" ").trim();
        tr.append(el("td", { textContent: text, className: cls }));
      }
      const extraBtns = [];
      for (const action of cfg.rowActions || []) {
        if (action.show && !action.show(row)) continue;
        const btn = el("button", { type: "button", className: `small ${action.className || ""}`, textContent: action.label });
        btn.addEventListener("click", () => runRowAction(action, row, btn));
        extraBtns.push(btn);
      }
      const editBtn = el("button", { type: "button", className: "small secondary", textContent: "Засах" });
      const delBtn = el("button", { type: "button", className: "small danger", textContent: "Устгах" });
      editBtn.addEventListener("click", () => openForm(row));
      delBtn.addEventListener("click", () => askDelete(row));
      tr.append(el("td", { className: "actions" }, el("div", { className: "row-btns" }, [...extraBtns, editBtn, delBtn])));
      tbody.append(tr);
    }
  }

  async function runRowAction(action, row, btn) {
    btn.disabled = true;
    try {
      const updated = await action.run(row);
      replaceRow(updated);
      render();
      showToast(action.success || "Амжилттай");
    } catch (err) {
      btn.disabled = false;
      showToast(err.message, "error");
    }
  }

  // ----- Ачаалах -----
  async function load() {
    tbody.replaceChildren(
      el("tr", {}, el("td", { colSpan: cfg.columns.length + 1, className: "empty", textContent: "Ачаалж байна..." }))
    );
    try {
      rows = await apiFetch(cfg.endpoint + filterQuery());
      render();
    } catch (err) {
      tbody.replaceChildren(
        el("tr", {}, el("td", { colSpan: cfg.columns.length + 1, className: "empty error", textContent: err.message }))
      );
    }
  }

  // ----- Форм нээх -----
  async function openForm(row = null) {
    editingId = row ? row[cfg.idKey] : null;
    formTitle.textContent = row ? `${capitalize(cfg.itemName)} засах` : `Шинэ ${cfg.itemName} нэмэх`;
    formError.textContent = "";
    form.reset();

    // select-ийн сонголтуудыг ачаална
    for (const f of cfg.fields) {
      if (f.type !== "select") continue;
      const select = inputs[f.name];
      select.replaceChildren(el("option", { value: "", textContent: f.required ? "Сонгоно уу" : "— Сонгоогүй —" }));
      try {
        const options = f.options ? await f.options() : [];
        for (const o of options) select.append(el("option", { value: o.value, textContent: o.label }));
      } catch (err) {
        formError.textContent = err.message;
      }
    }

    // Засах үед одоогийн утгууд, нэмэх үед анхдагч утгуудыг бөглөнө
    for (const f of cfg.fields) {
      const v = row ? row[f.name] : f.default;
      inputs[f.name].value = v == null ? "" : String(v);
    }

    formDialog.showModal();
    inputs[cfg.fields[0].name].focus();
  }

  function readForm() {
    const data = {};
    for (const f of cfg.fields) {
      const raw = inputs[f.name].value.trim();
      if (raw === "") data[f.name] = null;
      else if (f.type === "number" || (f.type === "select" && f.numeric)) data[f.name] = Number(raw);
      else data[f.name] = raw;
    }
    return data;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    saveBtn.disabled = true;
    formError.textContent = "";
    try {
      const body = readForm();
      if (editingId == null) {
        const created = await apiFetch(cfg.endpoint, { method: "POST", body });
        if (fitsFilters(created)) rows.unshift(created); // шинэ нь хамгийн дээр
        showToast(`${capitalize(cfg.itemName)} нэмэгдлээ`);
      } else {
        const updated = await apiFetch(`${cfg.endpoint}/${editingId}`, { method: "PUT", body });
        replaceRow(updated);
        showToast("Өөрчлөлт хадгалагдлаа");
      }
      formDialog.close();
      render();
    } catch (err) {
      formError.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  });

  cancelBtn.addEventListener("click", () => formDialog.close());

  // ----- Устгах -----
  function askDelete(row) {
    deletingRow = row;
    confirmText.textContent = `«${cfg.describe(row)}»-г устгах уу? Энэ үйлдлийг буцаах боломжгүй.`;
    confirmError.textContent = "";
    confirmOk.hidden = false;
    fallbackBtn.hidden = true;
    confirmDialog.showModal();
  }

  confirmOk.addEventListener("click", async () => {
    if (!deletingRow) return;
    confirmOk.disabled = true;
    try {
      const id = deletingRow[cfg.idKey];
      await apiFetch(`${cfg.endpoint}/${id}`, { method: "DELETE" });
      rows = rows.filter((r) => r[cfg.idKey] !== id);
      confirmDialog.close();
      render();
      showToast(`${capitalize(cfg.itemName)} устгагдлаа`);
    } catch (err) {
      // Жишээ нь: захиалгатай аялал (409)
      confirmError.textContent = err.message;
      confirmOk.hidden = true;
      // Устгаж болохгүй бол өөр үйлдэл санал болгоно (жишээ нь «Цуцлах»)
      const fb = cfg.deleteFallback;
      if (fb && (!fb.show || fb.show(deletingRow))) fallbackBtn.hidden = false;
    } finally {
      confirmOk.disabled = false;
    }
  });

  confirmCancel.addEventListener("click", () => confirmDialog.close());

  fallbackBtn.addEventListener("click", async () => {
    if (!deletingRow) return;
    fallbackBtn.disabled = true;
    try {
      replaceRow(await cfg.deleteFallback.run(deletingRow));
      confirmDialog.close();
      render();
      showToast(cfg.deleteFallback.success || "Амжилттай");
    } catch (err) {
      confirmError.textContent = err.message;
    } finally {
      fallbackBtn.disabled = false;
    }
  });

  // ----- Үйл явдлууд -----
  searchInput.addEventListener("input", render);
  addBtn.addEventListener("click", () => openForm());

  return { load };
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
