(() => {
  "use strict";

  // ---- Constants ----
  const BARN_LAT = 37.784;
  const BARN_LON = -79.443;

  const STORAGE_KEY = "roo_pwa_data_v1";
  const WEATHER_REFRESH_MS = 30 * 60 * 1000;
  const OPEN_METEO_ENDPOINT = "https://api.open-meteo.com/v1/forecast";

  // ---- Tiny DOM helpers ----
  const $ = (selector, root = document) => root.querySelector(selector);
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      if (key === "class") node.className = value;
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2), value);
      } else if (key in node) node[key] = value;
      else node.setAttribute(key, String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined) continue;
      node.appendChild(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  };

  // ---- Storage ----
  const emptyData = () => ({
    version: 1,
    blankets: [],
    combos: [],
    rules: [],
    defaultComboId: "",
    lastForecast: null,
  });

  const safeJsonParse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const loadData = () => {
    const raw = safeJsonParse(localStorage.getItem(STORAGE_KEY) || "");
    if (!raw || typeof raw !== "object") return emptyData();

    const data = emptyData();
    data.blankets = Array.isArray(raw.blankets) ? raw.blankets : [];
    data.combos = Array.isArray(raw.combos) ? raw.combos : [];
    data.rules = Array.isArray(raw.rules) ? raw.rules : [];
    data.defaultComboId = typeof raw.defaultComboId === "string" ? raw.defaultComboId : "";
    data.lastForecast = raw.lastForecast && typeof raw.lastForecast === "object" ? raw.lastForecast : null;
    return data;
  };

  const saveData = (data) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  };

  const newId = () => {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  };

  // ---- Formatting ----
  const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const round1 = (value) => (isFiniteNumber(value) ? Math.round(value * 10) / 10 : NaN);

  const formatF = (value) => (isFiniteNumber(value) ? `${round1(value)}°F` : "—");
  const formatMph = (value) => (isFiniteNumber(value) ? `${round1(value)} mph` : "—");
  const formatPct = (value) =>
    isFiniteNumber(value) ? `${Math.round(value)}%` : "—";

  const pad2 = (n) => String(n).padStart(2, "0");
  const formatYmd = (date) =>
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

  const formatTime = (date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;

  // ---- Time window ----
  const getTonightWindow = (now = new Date()) => {
    const start = new Date(now);
    start.setHours(19, 0, 0, 0);

    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    end.setHours(9, 0, 0, 0);

    return {
      start,
      end,
      label: `${formatYmd(start)} ${formatTime(start)} → ${formatYmd(end)} ${formatTime(end)}`,
    };
  };

  const getLocalTimeZone = () => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return typeof tz === "string" && tz.trim() ? tz : "auto";
    } catch {
      return "auto";
    }
  };

  // ---- Weather ----
  const computeTonightMetricsFromHourly = (hourly, windowStart, windowEnd) => {
    const times = hourly?.time;
    const temps = hourly?.temperature_2m;
    const feels = hourly?.apparent_temperature;
    const precip = hourly?.precipitation_probability;
    const wind = hourly?.windspeed_10m;

    if (!Array.isArray(times) || !Array.isArray(temps) || !Array.isArray(feels) || !Array.isArray(precip) || !Array.isArray(wind)) {
      throw new Error("Unexpected Open‑Meteo response (missing hourly fields).");
    }

    const indices = [];
    for (let i = 0; i < times.length; i += 1) {
      const t = new Date(times[i]);
      const ms = t.getTime();
      if (Number.isNaN(ms)) continue;
      if (ms >= windowStart.getTime() && ms < windowEnd.getTime()) indices.push(i);
    }

    if (indices.length === 0) {
      throw new Error("No hourly data found for the tonight window.");
    }

    const pickMin = (arr) => {
      let best = null;
      for (const idx of indices) {
        const v = arr[idx];
        if (!isFiniteNumber(v)) continue;
        if (best === null || v < best) best = v;
      }
      return best;
    };

    const pickMax = (arr) => {
      let best = null;
      for (const idx of indices) {
        const v = arr[idx];
        if (!isFiniteNumber(v)) continue;
        if (best === null || v > best) best = v;
      }
      return best;
    };

    const minTempF = pickMin(temps);
    const minFeelsF = pickMin(feels);
    const maxPrecipProb = pickMax(precip);
    const maxWindMph = pickMax(wind);

    const wetRisk = isFiniteNumber(maxPrecipProb) ? maxPrecipProb >= 50 : false;

    return {
      minTempF,
      minFeelsF,
      maxPrecipProb,
      maxWindMph,
      wetRisk,
    };
  };

  const fetchOpenMeteo = async ({ startDate, endDate, timezone }) => {
    const params = new URLSearchParams({
      latitude: String(BARN_LAT),
      longitude: String(BARN_LON),
      hourly:
        "temperature_2m,apparent_temperature,precipitation_probability,windspeed_10m",
      temperature_unit: "fahrenheit",
      windspeed_unit: "mph",
      timezone,
      start_date: startDate,
      end_date: endDate,
    });

    const url = `${OPEN_METEO_ENDPOINT}?${params.toString()}`;
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    const json = safeJsonParse(text);

    if (!res.ok) {
      const serverMsg =
        json && typeof json.reason === "string"
          ? json.reason
          : `HTTP ${res.status}`;
      throw new Error(`Weather request failed: ${serverMsg}`);
    }

    if (!json) throw new Error("Weather request failed: invalid JSON.");
    return json;
  };

  const fetchTonightMetrics = async () => {
    const { start, end } = getTonightWindow(new Date());
    const startDate = formatYmd(start);
    const endDate = formatYmd(end);

    const localTz = getLocalTimeZone();
    try {
      const json = await fetchOpenMeteo({ startDate, endDate, timezone: localTz });
      const metrics = computeTonightMetricsFromHourly(json.hourly, start, end);
      return { metrics, timezone: localTz };
    } catch (err) {
      if (localTz !== "auto") {
        const json = await fetchOpenMeteo({ startDate, endDate, timezone: "auto" });
        const metrics = computeTonightMetricsFromHourly(json.hourly, start, end);
        return { metrics, timezone: "auto" };
      }
      throw err;
    }
  };

  // ---- Rules ----
  const ruleMatches = (rule, metrics) => {
    if (!rule || typeof rule !== "object") return false;
    const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];

    for (const cond of conditions) {
      if (!cond || typeof cond !== "object") return false;
      const field = cond.field;
      if (field === "wetRisk") {
        if (cond.op !== "is") return false;
        const want = Boolean(cond.value);
        if (Boolean(metrics.wetRisk) !== want) return false;
        continue;
      }

      const left = metrics[field];
      const right = Number(cond.value);
      if (!isFiniteNumber(left) || !isFiniteNumber(right)) return false;

      switch (cond.op) {
        case "<=":
          if (!(left <= right)) return false;
          break;
        case "<":
          if (!(left < right)) return false;
          break;
        case ">=":
          if (!(left >= right)) return false;
          break;
        case ">":
          if (!(left > right)) return false;
          break;
        default:
          return false;
      }
    }

    return true;
  };

  const pickRecommendation = (data, metrics) => {
    const combosById = new Map(data.combos.map((c) => [c.id, c]));
    for (const rule of data.rules) {
      if (!ruleMatches(rule, metrics)) continue;
      const combo = combosById.get(rule.comboId);
      return { kind: "rule", rule, combo };
    }

    const defaultCombo = data.defaultComboId
      ? combosById.get(data.defaultComboId)
      : null;
    if (defaultCombo) return { kind: "default", combo: defaultCombo };
    return { kind: "none" };
  };

  // ---- UI state ----
  const state = {
    data: loadData(),
    activeTab: "tonight",
    weather: {
      loading: false,
      error: "",
      metrics: null,
      fetchedAtIso: "",
      timezone: "",
    },
    weatherTimer: null,
  };

  // ---- Elements ----
  const tabs = [
    {
      name: "tonight",
      tab: $("#tab-tonight"),
      panel: $("#panel-tonight"),
    },
    {
      name: "blankets",
      tab: $("#tab-blankets"),
      panel: $("#panel-blankets"),
    },
    {
      name: "rules",
      tab: $("#tab-rules"),
      panel: $("#panel-rules"),
    },
  ];

  const ui = {
    tonightWindow: $("#tonightWindow"),
    weatherStatus: $("#weatherStatus"),
    refreshWeatherBtn: $("#refreshWeatherBtn"),
    minTemp: $("#minTemp"),
    minFeels: $("#minFeels"),
    maxPrecip: $("#maxPrecip"),
    maxWind: $("#maxWind"),
    wetRisk: $("#wetRisk"),
    recommendation: $("#recommendation"),

    blanketForm: $("#blanketForm"),
    blanketId: $("#blanketId"),
    blanketName: $("#blanketName"),
    blanketNotes: $("#blanketNotes"),
    blanketSubmitBtn: $("#blanketSubmitBtn"),
    blanketCancelBtn: $("#blanketCancelBtn"),
    blanketsList: $("#blanketsList"),

    comboForm: $("#comboForm"),
    comboId: $("#comboId"),
    comboName: $("#comboName"),
    comboBlanketChoices: $("#comboBlanketChoices"),
    comboSubmitBtn: $("#comboSubmitBtn"),
    comboCancelBtn: $("#comboCancelBtn"),
    combosList: $("#combosList"),

    defaultComboSelect: $("#defaultComboSelect"),
    ruleForm: $("#ruleForm"),
    ruleId: $("#ruleId"),
    ruleName: $("#ruleName"),
    conditionsList: $("#conditionsList"),
    addConditionBtn: $("#addConditionBtn"),
    ruleComboSelect: $("#ruleComboSelect"),
    ruleSubmitBtn: $("#ruleSubmitBtn"),
    ruleCancelBtn: $("#ruleCancelBtn"),
    rulesList: $("#rulesList"),

    exportBtn: $("#exportBtn"),
    importFile: $("#importFile"),
    importFromTextBtn: $("#importFromTextBtn"),
    backupText: $("#backupText"),
    backupStatus: $("#backupStatus"),
  };

  // ---- Rendering ----
  const setBackupStatus = (msg) => {
    ui.backupStatus.textContent = msg || "—";
  };

  const setWeatherStatus = (msg) => {
    ui.weatherStatus.textContent = msg || "—";
  };

  const renderTonightWindow = () => {
    const { label } = getTonightWindow(new Date());
    ui.tonightWindow.textContent = `Tonight window: ${label} (local time)`;
  };

  const renderWeather = () => {
    const m = state.weather.metrics;
    ui.minTemp.textContent = m ? formatF(m.minTempF) : "—";
    ui.minFeels.textContent = m ? formatF(m.minFeelsF) : "—";
    ui.maxPrecip.textContent = m ? formatPct(m.maxPrecipProb) : "—";
    ui.maxWind.textContent = m ? formatMph(m.maxWindMph) : "—";
    ui.wetRisk.textContent = m ? (m.wetRisk ? "Yes" : "No") : "—";
  };

  const blanketNameById = (id) => {
    const b = state.data.blankets.find((x) => x.id === id);
    return b ? b.name : "(missing blanket)";
  };

  const renderRecommendation = () => {
    const metrics = state.weather.metrics;
    const { combos, rules } = state.data;

    if (!metrics) {
      ui.recommendation.replaceChildren(
        el("p", { class: "muted" }, "Fetch weather to see a recommendation.")
      );
      return;
    }

    if (combos.length === 0) {
      ui.recommendation.replaceChildren(
        el("p", { class: "muted" }, "No combos yet. Add one in Blankets.")
      );
      return;
    }

    if (rules.length === 0 && !state.data.defaultComboId) {
      ui.recommendation.replaceChildren(
        el(
          "p",
          { class: "muted" },
          "No rules yet. Add rules in the Rules tab (or set a default combo)."
        )
      );
      return;
    }

    const pick = pickRecommendation(state.data, metrics);

    if (pick.kind === "none") {
      ui.recommendation.replaceChildren(
        el("p", {}, "No rule matched."),
        el("p", { class: "muted" }, "Set a default combo or add a catch-all rule.")
      );
      return;
    }

    const combo = pick.combo;
    if (!combo) {
      ui.recommendation.replaceChildren(
        el("p", {}, "A matching rule selected a missing combo."),
        el("p", { class: "muted" }, "Edit or delete the rule in the Rules tab.")
      );
      return;
    }

    const header =
      pick.kind === "default"
        ? el("p", { class: "muted" }, "No rule matched. Using default combo:")
        : el(
            "p",
            { class: "muted" },
            `Matched: ${pick.rule?.name?.trim() || "Rule"}`
          );

    const blanketList =
      Array.isArray(combo.blanketIds) && combo.blanketIds.length
        ? el(
            "ul",
            {},
            combo.blanketIds.map((id) => el("li", {}, blanketNameById(id)))
          )
        : el("p", { class: "muted" }, "No blankets in this combo.");

    ui.recommendation.replaceChildren(
      header,
      el("p", { class: "title" }, combo.name),
      blanketList
    );
  };

  const resetBlanketForm = () => {
    ui.blanketId.value = "";
    ui.blanketName.value = "";
    ui.blanketNotes.value = "";
    ui.blanketSubmitBtn.textContent = "Add blanket";
    ui.blanketCancelBtn.hidden = true;
  };

  const resetComboForm = () => {
    ui.comboId.value = "";
    ui.comboName.value = "";
    ui.comboSubmitBtn.textContent = "Add combo";
    ui.comboCancelBtn.hidden = true;
    for (const input of ui.comboBlanketChoices.querySelectorAll("input[type='checkbox']")) {
      input.checked = false;
    }
  };

  const resetRuleForm = () => {
    ui.ruleId.value = "";
    ui.ruleName.value = "";
    ui.ruleSubmitBtn.textContent = "Add rule";
    ui.ruleCancelBtn.hidden = true;
    ui.conditionsList.replaceChildren();
    addConditionRow();
  };

  const renderBlankets = () => {
    const items = state.data.blankets;
    if (items.length === 0) {
      ui.blanketsList.replaceChildren(
        el("p", { class: "muted" }, "No blankets yet.")
      );
      return;
    }

    ui.blanketsList.replaceChildren(
      ...items.map((b) => {
        const notes = (b.notes || "").trim();
        return el(
          "div",
          { class: "list-item" },
          el("div", { class: "title" }, b.name || "(untitled)"),
          notes ? el("div", { class: "muted" }, notes) : null,
          el(
            "div",
            { class: "actions" },
            el("button", { type: "button", onclick: () => startEditBlanket(b.id) }, "Edit"),
            el(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: () => deleteBlanket(b.id),
              },
              "Delete"
            )
          )
        );
      })
    );
  };

  const renderComboBlanketChoices = () => {
    const blankets = state.data.blankets;
    if (blankets.length === 0) {
      ui.comboBlanketChoices.textContent = "Add a blanket first.";
      return;
    }

    ui.comboBlanketChoices.replaceChildren(
      ...blankets.map((b) =>
        el(
          "label",
          { class: "choice" },
          el("input", { type: "checkbox", value: b.id }),
          el("span", {}, b.name)
        )
      )
    );
  };

  const renderCombos = () => {
    const combos = state.data.combos;
    if (combos.length === 0) {
      ui.combosList.replaceChildren(el("p", { class: "muted" }, "No combos yet."));
      return;
    }

    ui.combosList.replaceChildren(
      ...combos.map((c) => {
        const list =
          Array.isArray(c.blanketIds) && c.blanketIds.length
            ? el(
                "ul",
                {},
                c.blanketIds.map((id) => el("li", {}, blanketNameById(id)))
              )
            : el("p", { class: "muted" }, "No blankets selected.");

        return el(
          "div",
          { class: "list-item" },
          el("div", { class: "title" }, c.name || "(untitled)"),
          list,
          el(
            "div",
            { class: "actions" },
            el("button", { type: "button", onclick: () => startEditCombo(c.id) }, "Edit"),
            el(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: () => deleteCombo(c.id),
              },
              "Delete"
            )
          )
        );
      })
    );
  };

  const renderComboSelects = () => {
    const combos = state.data.combos;

    const makeOptions = (includeNoneLabel) => {
      const opts = [];
      if (includeNoneLabel) {
        opts.push(el("option", { value: "" }, includeNoneLabel));
      }
      for (const c of combos) {
        opts.push(el("option", { value: c.id }, c.name || "(untitled)"));
      }
      return opts;
    };

    ui.defaultComboSelect.replaceChildren(...makeOptions("No default"));
    ui.defaultComboSelect.value = state.data.defaultComboId || "";

    ui.ruleComboSelect.replaceChildren(...makeOptions("Select a combo…"));
    ui.ruleComboSelect.value = "";
    ui.ruleComboSelect.disabled = combos.length === 0;
    ui.ruleSubmitBtn.disabled = combos.length === 0;
  };

  const conditionFieldOptions = [
    { value: "minFeelsF", label: "minFeelsF" },
    { value: "minTempF", label: "minTempF" },
    { value: "maxWindMph", label: "maxWindMph" },
    { value: "maxPrecipProb", label: "maxPrecipProb" },
    { value: "wetRisk", label: "wetRisk" },
  ];

  const addConditionRow = (seed = null) => {
    const id = newId();

    const field = seed?.field || "minFeelsF";
    const op = seed?.op || "<=";
    const value = seed?.value ?? "";

    const fieldSelect = el(
      "select",
      { "data-role": "field" },
      conditionFieldOptions.map((o) =>
        el("option", { value: o.value, selected: o.value === field }, o.label)
      )
    );

    const opSelect = el(
      "select",
      { "data-role": "op" },
      ["<=", "<", ">=", ">"].map((o) =>
        el("option", { value: o, selected: o === op }, o)
      )
    );

    const boolSelect = el(
      "select",
      { "data-role": "bool" },
      el("option", { value: "true" }, "true"),
      el("option", { value: "false" }, "false")
    );
    if (field === "wetRisk") boolSelect.value = String(Boolean(value));

    const valueInput = el("input", {
      "data-role": "value",
      type: "number",
      step: "0.1",
      value: field === "wetRisk" ? "" : value,
      placeholder: "value",
    });

    const removeBtn = el(
      "button",
      {
        type: "button",
        class: "danger",
        title: "Remove condition",
        onclick: () => row.remove(),
      },
      "×"
    );

    const row = el(
      "div",
      { class: "condition-row", "data-id": id },
      fieldSelect,
      opSelect,
      valueInput,
      removeBtn
    );

    const syncRowUi = () => {
      const f = fieldSelect.value;
      if (f === "wetRisk") {
        // Replace operator + value input with a boolean selector.
        row.replaceChildren(fieldSelect, el("span", { class: "muted" }, "is"), boolSelect, removeBtn);
      } else {
        row.replaceChildren(fieldSelect, opSelect, valueInput, removeBtn);
        valueInput.step = f.includes("Precip") ? "1" : "0.1";
      }
    };

    fieldSelect.addEventListener("change", syncRowUi);
    syncRowUi();

    ui.conditionsList.appendChild(row);
  };

  const conditionToText = (cond) => {
    if (cond.field === "wetRisk") return `wetRisk is ${Boolean(cond.value)}`;
    return `${cond.field} ${cond.op} ${cond.value}`;
  };

  const renderRules = () => {
    const rules = state.data.rules;
    if (rules.length === 0) {
      ui.rulesList.replaceChildren(el("p", { class: "muted" }, "No rules yet."));
      return;
    }

    const combosById = new Map(state.data.combos.map((c) => [c.id, c]));

    ui.rulesList.replaceChildren(
      ...rules.map((r, idx) => {
        const conditions = Array.isArray(r.conditions) ? r.conditions : [];
        const conditionsText =
          conditions.length > 0
            ? conditions.map(conditionToText).join(" AND ")
            : "(no conditions) (always matches)";

        const combo = combosById.get(r.comboId);
        const comboLabel = combo ? combo.name : "(missing combo)";

        const title = r.name?.trim() ? r.name.trim() : `Rule ${idx + 1}`;

        return el(
          "div",
          { class: "list-item" },
          el("div", { class: "title" }, title),
          el("div", { class: "muted" }, conditionsText),
          el("div", {}, `→ ${comboLabel}`),
          el(
            "div",
            { class: "actions" },
            el(
              "button",
              { type: "button", onclick: () => moveRule(idx, -1), disabled: idx === 0 },
              "Up"
            ),
            el(
              "button",
              {
                type: "button",
                onclick: () => moveRule(idx, +1),
                disabled: idx === rules.length - 1,
              },
              "Down"
            ),
            el("button", { type: "button", onclick: () => startEditRule(r.id) }, "Edit"),
            el(
              "button",
              {
                type: "button",
                class: "danger",
                onclick: () => deleteRule(r.id),
              },
              "Delete"
            )
          )
        );
      })
    );
  };

  const renderAll = () => {
    renderTonightWindow();
    renderWeather();
    renderComboBlanketChoices();
    renderBlankets();
    renderCombos();
    renderComboSelects();
    renderRules();
    renderRecommendation();
  };

  // ---- Mutations: blankets ----
  const startEditBlanket = (id) => {
    const b = state.data.blankets.find((x) => x.id === id);
    if (!b) return;
    ui.blanketId.value = b.id;
    ui.blanketName.value = b.name || "";
    ui.blanketNotes.value = b.notes || "";
    ui.blanketSubmitBtn.textContent = "Save blanket";
    ui.blanketCancelBtn.hidden = false;
    ui.blanketName.focus();
  };

  const deleteBlanket = (id) => {
    const b = state.data.blankets.find((x) => x.id === id);
    if (!b) return;
    if (!confirm(`Delete blanket "${b.name}"?`)) return;

    state.data.blankets = state.data.blankets.filter((x) => x.id !== id);
    for (const combo of state.data.combos) {
      combo.blanketIds = Array.isArray(combo.blanketIds)
        ? combo.blanketIds.filter((bid) => bid !== id)
        : [];
    }
    saveData(state.data);
    resetBlanketForm();
    renderAll();
  };

  // ---- Mutations: combos ----
  const startEditCombo = (id) => {
    const c = state.data.combos.find((x) => x.id === id);
    if (!c) return;

    ui.comboId.value = c.id;
    ui.comboName.value = c.name || "";

    const selected = new Set(Array.isArray(c.blanketIds) ? c.blanketIds : []);
    for (const input of ui.comboBlanketChoices.querySelectorAll("input[type='checkbox']")) {
      input.checked = selected.has(input.value);
    }

    ui.comboSubmitBtn.textContent = "Save combo";
    ui.comboCancelBtn.hidden = false;
    ui.comboName.focus();
  };

  const deleteCombo = (id) => {
    const c = state.data.combos.find((x) => x.id === id);
    if (!c) return;
    if (!confirm(`Delete combo "${c.name}"?`)) return;

    state.data.combos = state.data.combos.filter((x) => x.id !== id);

    if (state.data.defaultComboId === id) state.data.defaultComboId = "";
    for (const rule of state.data.rules) {
      if (rule.comboId === id) rule.comboId = "";
    }

    saveData(state.data);
    resetComboForm();
    renderAll();
  };

  // ---- Mutations: rules ----
  const moveRule = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= state.data.rules.length) return;
    const rules = [...state.data.rules];
    const tmp = rules[index];
    rules[index] = rules[target];
    rules[target] = tmp;
    state.data.rules = rules;
    saveData(state.data);
    renderAll();
  };

  const startEditRule = (id) => {
    const r = state.data.rules.find((x) => x.id === id);
    if (!r) return;

    ui.ruleId.value = r.id;
    ui.ruleName.value = r.name || "";
    ui.ruleComboSelect.value = r.comboId || "";

    ui.conditionsList.replaceChildren();
    const conditions = Array.isArray(r.conditions) ? r.conditions : [];
    if (conditions.length === 0) addConditionRow();
    for (const c of conditions) addConditionRow(c);

    ui.ruleSubmitBtn.textContent = "Save rule";
    ui.ruleCancelBtn.hidden = false;
    ui.ruleName.focus();
  };

  const deleteRule = (id) => {
    const r = state.data.rules.find((x) => x.id === id);
    if (!r) return;
    if (!confirm("Delete this rule?")) return;
    state.data.rules = state.data.rules.filter((x) => x.id !== id);
    saveData(state.data);
    resetRuleForm();
    renderAll();
  };

  // ---- Backup ----
  const exportJson = () => {
    ui.backupText.value = JSON.stringify(state.data, null, 2);
    setBackupStatus(`Exported at ${new Date().toLocaleString()}.`);
  };

  const sanitizeImportedData = (raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid JSON object.");
    const data = emptyData();

    data.blankets = Array.isArray(raw.blankets) ? raw.blankets : [];
    data.combos = Array.isArray(raw.combos) ? raw.combos : [];
    data.rules = Array.isArray(raw.rules) ? raw.rules : [];
    data.defaultComboId = typeof raw.defaultComboId === "string" ? raw.defaultComboId : "";
    data.lastForecast = raw.lastForecast && typeof raw.lastForecast === "object" ? raw.lastForecast : null;

    // Basic cleanup
    data.blankets = data.blankets
      .filter((b) => b && typeof b === "object")
      .map((b) => ({
        id: typeof b.id === "string" && b.id ? b.id : newId(),
        name: String(b.name || "").trim() || "Untitled blanket",
        notes: String(b.notes || ""),
      }));

    data.combos = data.combos
      .filter((c) => c && typeof c === "object")
      .map((c) => ({
        id: typeof c.id === "string" && c.id ? c.id : newId(),
        name: String(c.name || "").trim() || "Untitled combo",
        blanketIds: Array.isArray(c.blanketIds)
          ? c.blanketIds.filter((id) => typeof id === "string")
          : [],
      }));

    data.rules = data.rules
      .filter((r) => r && typeof r === "object")
      .map((r) => ({
        id: typeof r.id === "string" && r.id ? r.id : newId(),
        name: String(r.name || ""),
        comboId: typeof r.comboId === "string" ? r.comboId : "",
        conditions: Array.isArray(r.conditions)
          ? r.conditions
              .filter((c) => c && typeof c === "object")
              .map((c) => ({
                field: String(c.field || ""),
                op: String(c.op || ""),
                value: c.value,
              }))
          : [],
      }));

    if (typeof data.defaultComboId !== "string") data.defaultComboId = "";

    return data;
  };

  const importData = (raw) => {
    const data = sanitizeImportedData(raw);
    state.data = data;
    saveData(state.data);
    resetBlanketForm();
    resetComboForm();
    resetRuleForm();
    renderAll();
    setBackupStatus(`Imported at ${new Date().toLocaleString()}.`);
  };

  // ---- Tabs ----
  const setActiveTab = (name) => {
    state.activeTab = name;
    for (const t of tabs) {
      const selected = t.name === name;
      t.tab.setAttribute("aria-selected", selected ? "true" : "false");
      t.panel.hidden = !selected;
    }

    if (name === "tonight") startWeatherAutoRefresh();
    else stopWeatherAutoRefresh();
  };

  const startWeatherAutoRefresh = () => {
    stopWeatherAutoRefresh();
    state.weatherTimer = setInterval(() => {
      refreshWeather({ quietIfFresh: true });
    }, WEATHER_REFRESH_MS);
  };

  const stopWeatherAutoRefresh = () => {
    if (state.weatherTimer) clearInterval(state.weatherTimer);
    state.weatherTimer = null;
  };

  // ---- Weather refresh orchestration ----
  const refreshWeather = async ({ quietIfFresh } = { quietIfFresh: false }) => {
    if (state.weather.loading) return;

    const lastMs = state.weather.fetchedAtIso ? Date.parse(state.weather.fetchedAtIso) : NaN;
    if (
      quietIfFresh &&
      Number.isFinite(lastMs) &&
      Date.now() - lastMs < WEATHER_REFRESH_MS - 5_000
    ) {
      return;
    }

    state.weather.loading = true;
    state.weather.error = "";
    ui.refreshWeatherBtn.disabled = true;
    setWeatherStatus("Fetching weather…");

    try {
      const { metrics, timezone } = await fetchTonightMetrics();
      state.weather.metrics = metrics;
      state.weather.fetchedAtIso = new Date().toISOString();
      state.weather.timezone = timezone;

      state.data.lastForecast = {
        fetchedAtIso: state.weather.fetchedAtIso,
        timezone,
        metrics,
      };
      saveData(state.data);

      const when = new Date(state.weather.fetchedAtIso).toLocaleString();
      setWeatherStatus(`Updated ${when}${timezone ? ` (tz: ${timezone})` : ""}.`);
      renderAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.weather.error = msg;
      setWeatherStatus(`Weather error: ${msg}`);
      renderWeather();
      renderRecommendation();
    } finally {
      state.weather.loading = false;
      ui.refreshWeatherBtn.disabled = false;
    }
  };

  const hydrateWeatherFromStorage = () => {
    const last = state.data.lastForecast;
    if (!last || typeof last !== "object") return;
    const metrics = last.metrics;
    if (!metrics || typeof metrics !== "object") return;
    state.weather.metrics = metrics;
    state.weather.fetchedAtIso = typeof last.fetchedAtIso === "string" ? last.fetchedAtIso : "";
    state.weather.timezone = typeof last.timezone === "string" ? last.timezone : "";

    if (state.weather.fetchedAtIso) {
      const when = new Date(state.weather.fetchedAtIso).toLocaleString();
      setWeatherStatus(`Last known weather: ${when}.`);
    }
  };

  // ---- Init ----
  const initServiceWorker = async () => {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch {
      // Offline-first still works without SW; ignore.
    }
  };

  const initEvents = () => {
    for (const t of tabs) t.tab.addEventListener("click", () => setActiveTab(t.name));

    ui.refreshWeatherBtn.addEventListener("click", () => refreshWeather());

    ui.blanketCancelBtn.addEventListener("click", () => resetBlanketForm());
    ui.comboCancelBtn.addEventListener("click", () => resetComboForm());
    ui.ruleCancelBtn.addEventListener("click", () => resetRuleForm());

    ui.blanketForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = ui.blanketName.value.trim();
      const notes = ui.blanketNotes.value;
      if (!name) return;

      const id = ui.blanketId.value || "";
      if (id) {
        const b = state.data.blankets.find((x) => x.id === id);
        if (b) {
          b.name = name;
          b.notes = notes;
        }
      } else {
        state.data.blankets.push({ id: newId(), name, notes });
      }

      saveData(state.data);
      resetBlanketForm();
      renderAll();
    });

    ui.comboForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = ui.comboName.value.trim();
      if (!name) return;

      const blanketIds = Array.from(
        ui.comboBlanketChoices.querySelectorAll("input[type='checkbox']:checked")
      ).map((i) => i.value);

      const id = ui.comboId.value || "";
      if (id) {
        const c = state.data.combos.find((x) => x.id === id);
        if (c) {
          c.name = name;
          c.blanketIds = blanketIds;
        }
      } else {
        state.data.combos.push({ id: newId(), name, blanketIds });
      }

      saveData(state.data);
      resetComboForm();
      renderAll();
    });

    ui.defaultComboSelect.addEventListener("change", () => {
      state.data.defaultComboId = ui.defaultComboSelect.value || "";
      saveData(state.data);
      renderRecommendation();
    });

    ui.addConditionBtn.addEventListener("click", () => addConditionRow());

    ui.ruleForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const comboId = ui.ruleComboSelect.value;
      if (!comboId) return;

      const name = ui.ruleName.value;

      const conditions = [];
      for (const row of ui.conditionsList.querySelectorAll(".condition-row")) {
        const fieldSel = row.querySelector("[data-role='field']");
        if (!fieldSel) continue;
        const field = fieldSel.value;
        if (field === "wetRisk") {
          const boolSel = row.querySelector("[data-role='bool']");
          if (!boolSel) continue;
          conditions.push({ field, op: "is", value: boolSel.value === "true" });
        } else {
          const opSel = row.querySelector("[data-role='op']");
          const valInp = row.querySelector("[data-role='value']");
          if (!opSel || !valInp) continue;
          const value = Number(valInp.value);
          if (!isFiniteNumber(value)) continue;
          conditions.push({ field, op: opSel.value, value });
        }
      }

      const id = ui.ruleId.value || "";
      if (id) {
        const r = state.data.rules.find((x) => x.id === id);
        if (r) {
          r.name = name;
          r.comboId = comboId;
          r.conditions = conditions;
        }
      } else {
        state.data.rules.push({ id: newId(), name, comboId, conditions });
      }

      saveData(state.data);
      resetRuleForm();
      renderAll();
    });

    ui.exportBtn.addEventListener("click", exportJson);

    ui.importFile.addEventListener("change", async () => {
      const file = ui.importFile.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const raw = safeJsonParse(text);
        if (!raw) throw new Error("Invalid JSON.");
        if (!confirm("Import JSON and replace your current data?")) return;
        importData(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setBackupStatus(`Import failed: ${msg}`);
      } finally {
        ui.importFile.value = "";
      }
    });

    ui.importFromTextBtn.addEventListener("click", () => {
      try {
        const raw = safeJsonParse(ui.backupText.value);
        if (!raw) throw new Error("Invalid JSON.");
        if (!confirm("Import JSON and replace your current data?")) return;
        importData(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setBackupStatus(`Import failed: ${msg}`);
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (state.activeTab !== "tonight") return;
      refreshWeather({ quietIfFresh: true });
    });
  };

  const init = async () => {
    hydrateWeatherFromStorage();
    renderAll();
    initEvents();
    await initServiceWorker();

    // Kick off a refresh on load if the Tonight tab is visible.
    if (state.activeTab === "tonight") {
      startWeatherAutoRefresh();
      refreshWeather({ quietIfFresh: true });
    }
  };

  init();
})();

