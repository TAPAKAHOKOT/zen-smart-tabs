// ==UserScript==
// @name           Zen Smart Tabs
// @description    AI grouping of current-space tabs into native Zen folders.
// @ignorecache
// ==/UserScript==

(() => {
  "use strict";

  const VERSION = "0.1.0";
  const CONTROLLER_KEY = "__zenSmartTabsController";
  const TOOLBAR_ITEM_ID = "zen-smart-tabs-toolbar-item";
  const BUTTON_ID = "zen-smart-tabs-button";
  const OVERLAY_ID = "zen-smart-tabs-overlay";
  const API_URL = "https://api.openai.com/v1/responses";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const MAX_TABS_PER_REQUEST = 100;
  const DEFAULT_MODEL = "gpt-5-nano";

  const log = (...args) => console.log(`[ZenSmartTabs ${VERSION}]`, ...args);
  const warn = (...args) => console.warn(`[ZenSmartTabs ${VERSION}]`, ...args);

  class ZenSmartTabs {
    constructor(win) {
      this.window = win;
      this.document = win.document;
      this.initialized = false;
      this.destroyed = false;
      this.overlay = null;
      this.viewTitle = null;
      this.viewSubtitle = null;
      this.viewBody = null;
      this.closeButton = null;
      this.toolbarItem = null;
      this.apiKey = "";
      this.busy = false;
      this.busyButton = null;
      this.abortController = null;
      this.proposal = null;
      this.tabById = new Map();
      this.lastUndo = null;
      this.ui = {};

      this.boundCleanup = this.cleanup.bind(this);
      this.boundKeydown = this.onKeydown.bind(this);
      this.boundWindowUnload = this.cleanup.bind(this);
    }

    async init() {
      if (this.initialized || this.destroyed) {
        return;
      }

      if (this.document.readyState !== "complete") {
        await new Promise(resolve => {
          this.window.addEventListener("load", resolve, { once: true });
        });
      }

      try {
        await this.waitFor(
          () =>
            this.window.gBrowser &&
            this.window.gZenWorkspaces &&
            this.window.gZenFolders &&
            this.document.querySelector(
              "#zen-sidebar-top-buttons-customization-target"
            ),
          20_000
        );
      } catch (error) {
        warn("Zen dependencies did not become available:", error.message);
        return;
      }

      if (this.destroyed) {
        return;
      }

      this.mountToolbarButton();
      this.initialized = true;

      if (typeof this.window.addUnloadListener === "function") {
        this.window.addUnloadListener(this.boundCleanup);
      }
      this.window.addEventListener("unload", this.boundWindowUnload, {
        once: true,
      });

      log("Loaded. The API key is never persisted by this mod.");
    }

    waitFor(predicate, timeoutMs = 15_000, intervalMs = 50) {
      return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const timer = this.window.setInterval(() => {
          if (this.destroyed) {
            this.window.clearInterval(timer);
            reject(new Error("Mod was unloaded"));
            return;
          }

          let result = false;
          try {
            result = predicate();
          } catch {}

          if (result) {
            this.window.clearInterval(timer);
            resolve(result);
            return;
          }

          if (Date.now() - startedAt >= timeoutMs) {
            this.window.clearInterval(timer);
            reject(new Error(`Timed out after ${timeoutMs} ms`));
          }
        }, intervalMs);
      });
    }

    mountToolbarButton() {
      this.document.getElementById(TOOLBAR_ITEM_ID)?.remove();

      const target = this.document.querySelector(
        "#zen-sidebar-top-buttons-customization-target"
      );
      if (!target) {
        throw new Error("Zen sidebar toolbar target was not found");
      }

      const item = this.document.createXULElement("toolbaritem");
      item.id = TOOLBAR_ITEM_ID;
      item.setAttribute("skipintoolbarset", "true");
      item.setAttribute("overflows", "false");
      item.classList.add("zen-smart-tabs-toolbar-item");

      const button = this.document.createXULElement("toolbarbutton");
      button.id = BUTTON_ID;
      button.classList.add(
        "toolbarbutton-1",
        "chromeclass-toolbar-additional",
        "zen-smart-tabs-toolbar-button"
      );
      button.setAttribute("label", "Smart Tabs");
      button.setAttribute("aria-label", "Умно сгруппировать вкладки");
      button.setAttribute(
        "tooltiptext",
        "Умно сгруппировать вкладки текущего пространства"
      );
      button.addEventListener("command", () => this.open());

      item.appendChild(button);
      const separator = target.querySelector(
        "#zen-sidebar-top-buttons-separator"
      );
      target.insertBefore(item, separator || null);
      this.toolbarItem = item;
    }

    cleanup() {
      if (this.destroyed) {
        return;
      }
      this.destroyed = true;

      try {
        this.abortController?.abort();
      } catch {}
      this.abortController = null;

      this.document.removeEventListener("keydown", this.boundKeydown, true);
      this.window.removeEventListener("unload", this.boundWindowUnload);
      this.overlay?.remove();
      this.toolbarItem?.remove();
      this.document.getElementById(TOOLBAR_ITEM_ID)?.remove();

      this.apiKey = "";
      this.proposal = null;
      this.tabById.clear();
      this.lastUndo = null;
      this.overlay = null;
      this.toolbarItem = null;

      if (this.window[CONTROLLER_KEY] === this) {
        delete this.window[CONTROLLER_KEY];
      }
      log("Unloaded and cleared in-memory state.");
    }

    open() {
      if (this.destroyed) {
        return;
      }

      if (this.overlay?.isConnected) {
        this.overlay.querySelector("input, button, select")?.focus();
        return;
      }

      this.renderConfig();
    }

    close() {
      if (this.abortController) {
        try {
          this.abortController.abort();
        } catch {}
        this.abortController = null;
      }
      this.busy = false;
      this.document.removeEventListener("keydown", this.boundKeydown, true);
      this.overlay?.remove();
      this.overlay = null;
      this.viewTitle = null;
      this.viewSubtitle = null;
      this.viewBody = null;
      this.closeButton = null;
      this.ui = {};
    }

    onKeydown(event) {
      if (!this.overlay?.isConnected) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      }
    }

    h(tagName, { className = "", text = "", attrs = {}, dataset = {} } = {}) {
      const node = this.document.createElementNS(HTML_NS, tagName);
      if (className) {
        node.className = className;
      }
      if (text !== "") {
        node.textContent = String(text);
      }
      for (const [name, value] of Object.entries(attrs)) {
        if (value !== undefined && value !== null) {
          node.setAttribute(name, String(value));
        }
      }
      for (const [name, value] of Object.entries(dataset)) {
        node.dataset[name] = String(value);
      }
      return node;
    }

    createButton(text, variant = "secondary") {
      return this.h("button", {
        className: `zst-button zst-button-${variant}`,
        text,
        attrs: { type: "button" },
      });
    }

    ensureOverlay() {
      if (this.overlay?.isConnected) {
        return;
      }

      this.document.getElementById(OVERLAY_ID)?.remove();

      const overlay = this.h("div", {
        className: "zst-overlay",
        attrs: {
          id: OVERLAY_ID,
          role: "presentation",
        },
      });
      const panel = this.h("section", {
        className: "zst-panel",
        attrs: {
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": "zst-dialog-title",
        },
      });
      const header = this.h("header", { className: "zst-header" });
      const headingWrap = this.h("div", { className: "zst-heading-wrap" });
      const title = this.h("h1", {
        className: "zst-title",
        attrs: { id: "zst-dialog-title" },
      });
      const subtitle = this.h("p", { className: "zst-subtitle" });
      const close = this.h("button", {
        className: "zst-icon-button zst-close-button",
        text: "×",
        attrs: {
          type: "button",
          title: "Закрыть",
          "aria-label": "Закрыть",
        },
      });
      const body = this.h("main", { className: "zst-body" });

      close.addEventListener("click", () => this.close());
      overlay.addEventListener("mousedown", event => {
        if (event.target === overlay && !this.busy) {
          this.close();
        }
      });

      headingWrap.append(title, subtitle);
      header.append(headingWrap, close);
      panel.append(header, body);
      overlay.appendChild(panel);
      this.document.documentElement.appendChild(overlay);
      this.document.addEventListener("keydown", this.boundKeydown, true);

      this.overlay = overlay;
      this.viewTitle = title;
      this.viewSubtitle = subtitle;
      this.viewBody = body;
      this.closeButton = close;

      this.window.requestAnimationFrame(() => {
        overlay.classList.add("zst-overlay-open");
      });
    }

    setView(title, subtitle = "") {
      this.ensureOverlay();
      this.viewTitle.textContent = title;
      this.viewSubtitle.textContent = subtitle;
      this.viewSubtitle.hidden = !subtitle;
      this.viewBody.replaceChildren();
      this.ui = {};
      this.overlay.removeAttribute("data-busy");
    }

    makeField(labelText, control, helpText = "") {
      const field = this.h("label", { className: "zst-field" });
      const label = this.h("span", {
        className: "zst-field-label",
        text: labelText,
      });
      field.append(label, control);
      if (helpText) {
        field.appendChild(
          this.h("span", { className: "zst-field-help", text: helpText })
        );
      }
      return field;
    }

    makeCheckbox(labelText, checked = false) {
      const label = this.h("label", { className: "zst-checkbox" });
      const input = this.h("input", {
        attrs: { type: "checkbox" },
      });
      input.checked = checked;
      const text = this.h("span", { text: labelText });
      label.append(input, text);
      return { label, input };
    }

    renderConfig(notice = "") {
      this.setView(
        "Smart Tabs",
        "AI разложит незакреплённые вкладки текущего пространства по нативным папкам Zen."
      );

      const content = this.h("div", { className: "zst-stack" });

      if (notice) {
        content.appendChild(
          this.h("div", {
            className: "zst-banner zst-banner-success",
            text: notice,
          })
        );
      }

      if (this.isPrivateOrFoldersDisabled()) {
        content.appendChild(
          this.h("div", {
            className: "zst-banner zst-banner-error",
            text:
              "В приватном окне или при отключённых Workspaces нативные Zen Folder недоступны. Открой обычное окно Zen.",
          })
        );
      }

      if (this.lastUndo) {
        const undoBanner = this.h("div", {
          className: "zst-banner zst-banner-neutral zst-banner-with-action",
        });
        undoBanner.appendChild(
          this.h("span", {
            text: "Можно отменить последнюю группировку, пока это окно Zen открыто.",
          })
        );
        const undoButton = this.createButton("Отменить", "ghost");
        undoButton.addEventListener("click", () =>
          this.undoLastGrouping(undoButton)
        );
        undoBanner.appendChild(undoButton);
        content.appendChild(undoBanner);
      }

      const keyInput = this.h("input", {
        className: "zst-input",
        attrs: {
          type: "password",
          placeholder: this.readEnvironmentKey()
            ? "Найден OPENAI_API_KEY — можно оставить пустым"
            : "sk-proj-…",
          autocomplete: "off",
          spellcheck: "false",
          "data-1p-ignore": "true",
          "data-lpignore": "true",
        },
      });
      if (this.apiKey) {
        keyInput.value = this.apiKey;
      }

      const keyHelp = this.readEnvironmentKey()
        ? "Сначала используется ключ из этого поля, затем OPENAI_API_KEY. Мод ничего не записывает в настройки, историю или файлы."
        : "Ключ остаётся только в памяти этого окна Zen и исчезнет после закрытия браузера. В код и GitHub его вставлять нельзя.";
      content.appendChild(this.makeField("OpenAI API key", keyInput, keyHelp));

      const settingsGrid = this.h("div", { className: "zst-settings-grid" });

      const modelSelect = this.h("select", { className: "zst-select" });
      for (const [value, label] of [
        ["gpt-5-nano", "GPT-5 nano — дешевле"],
        ["gpt-5-mini", "GPT-5 mini — точнее"],
      ]) {
        const option = this.h("option", {
          text: label,
          attrs: { value },
        });
        if (value === DEFAULT_MODEL) {
          option.selected = true;
        }
        modelSelect.appendChild(option);
      }
      settingsGrid.appendChild(
        this.makeField("Модель", modelSelect, "Для обычной сортировки nano обычно достаточно.")
      );

      const languageSelect = this.h("select", { className: "zst-select" });
      for (const [value, label] of [
        ["ru", "Русские названия"],
        ["en", "English names"],
        ["auto", "Как у большинства вкладок"],
      ]) {
        languageSelect.appendChild(
          this.h("option", { text: label, attrs: { value } })
        );
      }
      settingsGrid.appendChild(
        this.makeField("Язык папок", languageSelect)
      );

      const maxGroupsInput = this.h("input", {
        className: "zst-input",
        attrs: {
          type: "number",
          min: "2",
          max: "8",
          step: "1",
          value: "6",
        },
      });
      settingsGrid.appendChild(
        this.makeField("Максимум папок", maxGroupsInput, "От 2 до 8.")
      );

      content.appendChild(settingsGrid);

      const includePinned = this.makeCheckbox(
        "Также анализировать обычные закреплённые вкладки",
        false
      );
      content.appendChild(includePinned.label);

      const inventoryBox = this.h("div", { className: "zst-inventory" });
      const inventoryMain = this.h("strong");
      const inventoryDetails = this.h("span");
      inventoryBox.append(inventoryMain, inventoryDetails);
      content.appendChild(inventoryBox);

      const privacy = this.h("div", {
        className: "zst-banner zst-banner-warning",
      });
      const privacyTitle = this.h("strong", {
        text: "Перед отправкой",
      });
      const privacyText = this.h("span", {
        text:
          " В OpenAI уйдут заголовки вкладок и домены. Полные URL, query-параметры и содержимое страниц не отправляются. Уже созданные папки и группы исключаются.",
      });
      privacy.append(privacyTitle, privacyText);
      content.appendChild(privacy);

      const status = this.h("div", {
        className: "zst-status",
        attrs: { role: "status", "aria-live": "polite" },
      });
      content.appendChild(status);

      const actions = this.h("div", { className: "zst-actions" });
      const cancelButton = this.createButton("Закрыть", "secondary");
      const analyzeButton = this.createButton("Проанализировать вкладки", "primary");
      cancelButton.addEventListener("click", () => this.close());
      analyzeButton.addEventListener("click", () => this.analyze());
      actions.append(cancelButton, analyzeButton);
      content.appendChild(actions);

      this.viewBody.appendChild(content);
      this.ui = {
        keyInput,
        modelSelect,
        languageSelect,
        maxGroupsInput,
        includePinned: includePinned.input,
        inventoryMain,
        inventoryDetails,
        status,
        analyzeButton,
      };

      const updateInventory = () => {
        const inventory = this.collectTabs({
          includePinned: includePinned.input.checked,
        });
        inventoryMain.textContent = `${inventory.tabs.length} вкладок готовы к анализу`;
        const excludedParts = [];
        if (inventory.excluded.grouped) {
          excludedParts.push(`${inventory.excluded.grouped} уже в группах`);
        }
        if (inventory.excluded.pinned) {
          excludedParts.push(`${inventory.excluded.pinned} закреплено`);
        }
        if (inventory.excluded.internal) {
          excludedParts.push(`${inventory.excluded.internal} служебных/локальных`);
        }
        if (inventory.truncated) {
          excludedParts.push(
            `${inventory.truncated} сверх лимита ${MAX_TABS_PER_REQUEST}`
          );
        }
        inventoryDetails.textContent = excludedParts.length
          ? `Исключено: ${excludedParts.join(" · ")}.`
          : "Ничего лишнего не исключено.";
        analyzeButton.disabled =
          inventory.tabs.length < 2 || this.isPrivateOrFoldersDisabled();
      };

      includePinned.input.addEventListener("change", updateInventory);
      updateInventory();
      keyInput.focus();
    }

    async analyze() {
      if (this.busy) {
        return;
      }

      const keyFromInput = this.ui.keyInput?.value.trim() || "";
      const apiKey = keyFromInput || this.readEnvironmentKey();
      if (!apiKey) {
        this.showInlineError(
          "Вставь OpenAI API key или запусти Zen с переменной окружения OPENAI_API_KEY."
        );
        this.ui.keyInput?.focus();
        return;
      }

      const includePinned = Boolean(this.ui.includePinned?.checked);
      const inventory = this.collectTabs({ includePinned });
      if (inventory.tabs.length < 2) {
        this.showInlineError(
          "Для группировки нужно хотя бы две подходящие вкладки в текущем пространстве."
        );
        return;
      }

      const maxGroups = this.clampInteger(
        Number(this.ui.maxGroupsInput?.value || 6),
        2,
        8
      );
      const model = this.ui.modelSelect?.value || DEFAULT_MODEL;
      const language = this.ui.languageSelect?.value || "ru";

      this.apiKey = apiKey;
      this.tabById = new Map(
        inventory.tabs.map(descriptor => [descriptor.id, descriptor])
      );
      this.showInlineStatus(
        `Отправляю ${inventory.tabs.length} заголовков и доменов в ${model}…`
      );
      this.setBusy(true, this.ui.analyzeButton, "Анализирую…");

      try {
        const rawProposal = await this.requestGrouping({
          apiKey,
          model,
          language,
          maxGroups,
          tabs: inventory.tabs,
        });
        const proposal = this.validateProposal(
          rawProposal,
          inventory.tabs,
          maxGroups
        );

        if (!proposal.groups.length) {
          throw new Error(
            "Модель не нашла ни одной уверенной группы минимум из двух вкладок. Попробуй открыть больше связанных страниц или выбрать GPT-5 mini."
          );
        }

        this.proposal = {
          ...proposal,
          workspaceId: inventory.workspaceId,
          model,
          language,
          maxGroups,
          includePinned,
          truncated: inventory.truncated,
        };
        this.setBusy(false);
        this.renderPreview();
      } catch (error) {
        this.setBusy(false);
        if (error?.name === "AbortError") {
          return;
        }
        warn("Analysis failed:", error?.message || error);
        this.showInlineError(this.humanizeError(error));
      } finally {
        this.abortController = null;
      }
    }

    async requestGrouping({ apiKey, model, language, maxGroups, tabs }) {
      this.abortController = new AbortController();

      const languageInstruction = {
        ru: "Write folder names in Russian.",
        en: "Write folder names in English.",
        auto: "Write folder names in the language used by most tab titles.",
      }[language];

      const developerPrompt = [
        "You organize browser tabs into a small number of useful project/task folders.",
        "Use semantic intent from each title and hostname, not hostname alone.",
        "A group must contain at least 2 tabs. Leave standalone or ambiguous tabs ungrouped.",
        `Create at most ${maxGroups} groups. Prefer 3-6 coherent groups over many tiny groups.`,
        "Use every tab id at most once. Never invent or alter tab ids.",
        "Folder names must be concise, specific, neutral, contain no emoji, and be at most 32 characters.",
        languageInstruction,
        "Return only data matching the supplied JSON schema.",
      ].join("\n");

      const payload = {
        model,
        store: false,
        input: [
          {
            role: "developer",
            content: developerPrompt,
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Group these open browser tabs",
              tabs: tabs.map(({ id, title, host }) => ({ id, title, host })),
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "zen_tab_grouping",
            description:
              "A grouping of supplied browser tab IDs into named folders.",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                groups: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      name: { type: "string" },
                      tab_ids: {
                        type: "array",
                        items: { type: "string" },
                      },
                    },
                    required: ["name", "tab_ids"],
                  },
                },
                ungrouped_tab_ids: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["groups", "ungrouped_tab_ids"],
            },
          },
        },
        max_output_tokens: 3000,
      };

      const response = await this.window.fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: this.abortController.signal,
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });

      const rawText = await response.text();
      let data = null;
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        data = {};
      }

      if (!response.ok) {
        const message =
          data?.error?.message ||
          rawText.slice(0, 300) ||
          `HTTP ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        error.code = data?.error?.code || "";
        error.type = data?.error?.type || "";
        throw error;
      }

      if (data?.status === "incomplete") {
        throw new Error(
          `OpenAI вернул незавершённый ответ: ${
            data?.incomplete_details?.reason || "unknown reason"
          }`
        );
      }

      const outputText = this.extractResponseText(data);
      if (!outputText) {
        const refusal = this.extractRefusal(data);
        throw new Error(
          refusal
            ? `Модель отказалась обработать список: ${refusal}`
            : "OpenAI вернул ответ без структурированного текста."
        );
      }

      const cleaned = outputText
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      try {
        return JSON.parse(cleaned);
      } catch {
        throw new Error("Не удалось разобрать JSON, полученный от OpenAI.");
      }
    }

    extractResponseText(data) {
      if (typeof data?.output_text === "string") {
        return data.output_text;
      }

      const chunks = [];
      for (const item of data?.output || []) {
        if (item?.type !== "message") {
          continue;
        }
        for (const content of item?.content || []) {
          if (content?.type === "output_text" && typeof content.text === "string") {
            chunks.push(content.text);
          }
        }
      }
      return chunks.join("");
    }

    extractRefusal(data) {
      for (const item of data?.output || []) {
        for (const content of item?.content || []) {
          if (content?.type === "refusal") {
            return content.refusal || "refusal";
          }
        }
      }
      return "";
    }

    validateProposal(rawProposal, tabs, maxGroups) {
      if (!rawProposal || !Array.isArray(rawProposal.groups)) {
        throw new Error("Ответ модели не содержит массива groups.");
      }

      const allowed = new Map(tabs.map(tab => [tab.id, tab]));
      const used = new Set();
      const groups = [];

      for (const rawGroup of rawProposal.groups) {
        if (groups.length >= maxGroups) {
          break;
        }
        if (!rawGroup || !Array.isArray(rawGroup.tab_ids)) {
          continue;
        }

        const candidateIds = [];
        const localSeen = new Set();
        for (const rawId of rawGroup.tab_ids) {
          const id = String(rawId);
          if (!allowed.has(id) || used.has(id) || localSeen.has(id)) {
            continue;
          }
          localSeen.add(id);
          candidateIds.push(id);
        }

        if (candidateIds.length < 2) {
          continue;
        }

        const name = this.sanitizeFolderName(
          rawGroup.name,
          `Группа ${groups.length + 1}`
        );
        candidateIds.forEach(id => used.add(id));
        groups.push({ name, tabIds: candidateIds });
      }

      const ungroupedTabIds = tabs
        .map(tab => tab.id)
        .filter(id => !used.has(id));

      return { groups, ungroupedTabIds };
    }

    renderPreview() {
      const proposal = this.proposal;
      if (!proposal) {
        this.renderConfig();
        return;
      }

      const groupedCount = proposal.groups.reduce(
        (sum, group) => sum + group.tabIds.length,
        0
      );
      this.setView(
        "Проверь группировку",
        `${proposal.groups.length} папок · ${groupedCount} вкладок · названия можно изменить`
      );

      const content = this.h("div", { className: "zst-stack" });
      content.appendChild(
        this.h("div", {
          className: "zst-banner zst-banner-warning",
          text:
            "Важно: нативные Zen Folder автоматически закрепляют помещённые в них вкладки. Кнопка «Отменить» ниже распакует папки и вернёт исходный pinned-state по мере возможности.",
        })
      );

      if (proposal.truncated) {
        content.appendChild(
          this.h("div", {
            className: "zst-banner zst-banner-neutral",
            text: `${proposal.truncated} вкладок сверх лимита ${MAX_TABS_PER_REQUEST} не анализировались.`,
          })
        );
      }

      const cards = this.h("div", { className: "zst-group-list" });
      const groupCards = [];

      proposal.groups.forEach((group, groupIndex) => {
        const card = this.h("section", {
          className: "zst-group-card",
          dataset: { groupIndex },
        });
        const cardHeader = this.h("div", { className: "zst-group-header" });
        const enabledWrap = this.makeCheckbox("Создать папку", true);
        enabledWrap.input.classList.add("zst-group-enabled");
        const nameInput = this.h("input", {
          className: "zst-input zst-group-name",
          attrs: {
            type: "text",
            maxlength: "42",
            value: group.name,
            "aria-label": `Название папки ${groupIndex + 1}`,
          },
        });
        nameInput.value = group.name;
        cardHeader.append(enabledWrap.label, nameInput);

        const tabList = this.h("div", { className: "zst-tab-list" });
        for (const tabId of group.tabIds) {
          const descriptor = this.tabById.get(tabId);
          if (!descriptor) {
            continue;
          }
          const row = this.h("label", { className: "zst-tab-row" });
          const checkbox = this.h("input", {
            className: "zst-tab-enabled",
            attrs: { type: "checkbox" },
            dataset: { tabId },
          });
          checkbox.checked = true;
          const copy = this.h("span", { className: "zst-tab-copy" });
          copy.append(
            this.h("span", {
              className: "zst-tab-title",
              text: descriptor.title,
            }),
            this.h("span", {
              className: "zst-tab-host",
              text: descriptor.host,
            })
          );
          row.append(checkbox, copy);
          tabList.appendChild(row);
        }

        enabledWrap.input.addEventListener("change", () => {
          const enabled = enabledWrap.input.checked;
          card.classList.toggle("zst-group-card-disabled", !enabled);
          nameInput.disabled = !enabled;
          tabList
            .querySelectorAll("input")
            .forEach(input => (input.disabled = !enabled));
          this.updatePreviewSummary();
        });
        tabList.addEventListener("change", () => this.updatePreviewSummary());
        nameInput.addEventListener("input", () => this.updatePreviewSummary());

        card.append(cardHeader, tabList);
        cards.appendChild(card);
        groupCards.push(card);
      });

      content.appendChild(cards);

      if (proposal.ungroupedTabIds.length) {
        const details = this.h("details", { className: "zst-ungrouped" });
        const summary = this.h("summary", {
          text: `Без папки: ${proposal.ungroupedTabIds.length}`,
        });
        const list = this.h("div", { className: "zst-ungrouped-list" });
        for (const tabId of proposal.ungroupedTabIds) {
          const descriptor = this.tabById.get(tabId);
          if (!descriptor) {
            continue;
          }
          const row = this.h("div", { className: "zst-ungrouped-row" });
          row.append(
            this.h("span", { text: descriptor.title }),
            this.h("small", { text: descriptor.host })
          );
          list.appendChild(row);
        }
        details.append(summary, list);
        content.appendChild(details);
      }

      const status = this.h("div", {
        className: "zst-status",
        attrs: { role: "status", "aria-live": "polite" },
      });
      content.appendChild(status);

      const actions = this.h("div", { className: "zst-actions" });
      const backButton = this.createButton("Назад", "secondary");
      const applyButton = this.createButton("Создать папки", "primary");
      backButton.addEventListener("click", () => this.renderConfig());
      applyButton.addEventListener("click", () => this.applyGrouping());
      actions.append(backButton, applyButton);
      content.appendChild(actions);

      this.viewBody.appendChild(content);
      this.ui = { groupCards, status, applyButton, backButton };
      this.updatePreviewSummary();
      groupCards[0]?.querySelector(".zst-group-name")?.focus();
    }

    getPreviewSelection() {
      const groups = [];
      for (const [index, card] of (this.ui.groupCards || []).entries()) {
        const enabled = card.querySelector(".zst-group-enabled")?.checked;
        if (!enabled) {
          continue;
        }
        const tabIds = Array.from(
          card.querySelectorAll(".zst-tab-enabled:checked")
        ).map(input => input.dataset.tabId);
        if (tabIds.length < 2) {
          continue;
        }
        const fallback = `Группа ${index + 1}`;
        const name = this.sanitizeFolderName(
          card.querySelector(".zst-group-name")?.value,
          fallback
        );
        groups.push({ name, tabIds });
      }
      return groups;
    }

    updatePreviewSummary() {
      if (!this.ui.applyButton) {
        return;
      }
      const groups = this.getPreviewSelection();
      const tabsCount = groups.reduce(
        (sum, group) => sum + group.tabIds.length,
        0
      );
      this.ui.applyButton.disabled = groups.length === 0 || this.busy;
      this.ui.applyButton.textContent = groups.length
        ? `Создать ${groups.length} ${this.pluralizeRu(
            groups.length,
            "папку",
            "папки",
            "папок"
          )} из ${tabsCount} вкладок`
        : "Выбери хотя бы одну группу";
    }

    async applyGrouping() {
      if (this.busy || !this.proposal) {
        return;
      }
      if (this.isPrivateOrFoldersDisabled()) {
        this.showInlineError(
          "Нативные Zen Folder недоступны в этом окне. Открой обычное окно Zen."
        );
        return;
      }

      const currentWorkspaceId = this.getActiveWorkspaceId();
      if (
        this.proposal.workspaceId &&
        currentWorkspaceId &&
        this.proposal.workspaceId !== currentWorkspaceId
      ) {
        this.showInlineError(
          "Ты переключил пространство после анализа. Вернись назад и проанализируй вкладки заново."
        );
        return;
      }

      const selectedGroups = this.getPreviewSelection();
      if (!selectedGroups.length) {
        this.showInlineError(
          "В каждой создаваемой папке должно остаться минимум две вкладки."
        );
        return;
      }

      this.setBusy(true, this.ui.applyButton, "Создаю папки…");
      const snapshots = new Map();
      const createdFolders = [];

      try {
        for (const group of selectedGroups) {
          const liveTabs = group.tabIds
            .map(id => this.tabById.get(id)?.tab)
            .filter(
              tab =>
                tab &&
                tab.isConnected &&
                !tab.closing &&
                !this.isTabAlreadyGrouped(tab) &&
                this.isTabInActiveWorkspace(tab, currentWorkspaceId)
            );

          if (liveTabs.length < 2) {
            continue;
          }

          for (const tab of liveTabs) {
            if (!snapshots.has(tab)) {
              snapshots.set(tab, {
                tab,
                wasPinned: Boolean(tab.pinned),
                position: Number.isFinite(tab._tPos) ? tab._tPos : 0,
              });
            }
          }

          const options = {
            label: this.sanitizeFolderName(group.name, "Smart group"),
            collapsed: true,
          };
          if (currentWorkspaceId) {
            options.workspaceId = currentWorkspaceId;
          }

          const folder = this.window.gZenFolders.createFolder(liveTabs, options);
          if (!folder) {
            throw new Error(`Zen не создал папку «${options.label}».`);
          }
          folder.setAttribute("data-zen-smart-tabs", "true");
          createdFolders.push({
            folder,
            name: options.label,
            tabCount: liveTabs.length,
          });

          await new Promise(resolve =>
            this.window.requestAnimationFrame(resolve)
          );
        }

        if (!createdFolders.length) {
          throw new Error(
            "Папки не созданы: вкладки успели закрыться, переместиться или войти в другую группу. Проанализируй их заново."
          );
        }

        this.lastUndo = {
          folders: createdFolders,
          snapshots: Array.from(snapshots.values()),
          workspaceId: currentWorkspaceId,
          createdAt: Date.now(),
        };
        this.setBusy(false);
        this.renderSuccess(createdFolders);
      } catch (error) {
        const partialUndo = {
          folders: createdFolders,
          snapshots: Array.from(snapshots.values()),
          workspaceId: currentWorkspaceId,
        };
        if (createdFolders.length) {
          try {
            await this.performUndo(partialUndo);
          } catch (rollbackError) {
            warn("Automatic rollback failed:", rollbackError?.message || rollbackError);
          }
        }
        this.setBusy(false);
        warn("Folder creation failed:", error?.message || error);
        this.renderOperationError(
          "Не удалось создать папки",
          this.humanizeError(error)
        );
      }
    }

    renderSuccess(createdFolders) {
      const totalTabs = createdFolders.reduce(
        (sum, folder) => sum + folder.tabCount,
        0
      );
      this.setView(
        "Готово",
        `${createdFolders.length} папок · ${totalTabs} вкладок сгруппировано`
      );

      const content = this.h("div", { className: "zst-stack" });
      content.appendChild(
        this.h("div", {
          className: "zst-banner zst-banner-success",
          text: "Папки созданы в текущем пространстве Zen.",
        })
      );

      const list = this.h("div", { className: "zst-result-list" });
      for (const item of createdFolders) {
        const row = this.h("div", { className: "zst-result-row" });
        row.append(
          this.h("strong", { text: item.name }),
          this.h("span", {
            text: `${item.tabCount} ${this.pluralizeRu(
              item.tabCount,
              "вкладка",
              "вкладки",
              "вкладок"
            )}`,
          })
        );
        list.appendChild(row);
      }
      content.appendChild(list);

      content.appendChild(
        this.h("p", {
          className: "zst-footnote",
          text:
            "Отмена распакует созданные папки, снимет закрепление с вкладок, которые до этого не были закреплены, и постарается вернуть их прежний порядок.",
        })
      );

      const status = this.h("div", {
        className: "zst-status",
        attrs: { role: "status", "aria-live": "polite" },
      });
      const actions = this.h("div", { className: "zst-actions" });
      const undoButton = this.createButton("Отменить группировку", "secondary");
      const closeButton = this.createButton("Закрыть", "primary");
      undoButton.addEventListener("click", () =>
        this.undoLastGrouping(undoButton)
      );
      closeButton.addEventListener("click", () => this.close());
      actions.append(undoButton, closeButton);
      content.append(status, actions);
      this.viewBody.appendChild(content);
      this.ui = { status, undoButton, closeButton };
      closeButton.focus();
    }

    async undoLastGrouping(button = null) {
      if (this.busy || !this.lastUndo) {
        return;
      }
      this.setBusy(true, button, "Отменяю…");
      try {
        await this.performUndo(this.lastUndo);
        this.lastUndo = null;
        this.setBusy(false);
        this.renderConfig("Последняя группировка отменена.");
      } catch (error) {
        this.setBusy(false);
        warn("Undo failed:", error?.message || error);
        this.renderOperationError(
          "Не удалось полностью отменить группировку",
          this.humanizeError(error)
        );
      }
    }

    async performUndo(undoData) {
      const folders = [...(undoData?.folders || [])].reverse();
      for (const item of folders) {
        const folder = item?.folder;
        if (!folder?.isConnected) {
          continue;
        }
        if (typeof folder.unpackTabs === "function") {
          await folder.unpackTabs();
        } else {
          for (const tab of [...(folder.tabs || [])].reverse()) {
            if (tab.hasAttribute?.("zen-empty-tab")) {
              this.window.gBrowser.removeTab(tab);
            } else {
              this.window.gBrowser.ungroupTab(tab);
            }
          }
        }
      }

      await this.delay(80);

      for (const snapshot of undoData?.snapshots || []) {
        const tab = snapshot.tab;
        if (
          tab?.isConnected &&
          !snapshot.wasPinned &&
          tab.pinned &&
          !this.isTabAlreadyGrouped(tab)
        ) {
          this.window.gBrowser.unpinTab(tab);
        }
      }

      await this.delay(50);

      const restorable = (undoData?.snapshots || [])
        .filter(
          snapshot =>
            snapshot.tab?.isConnected &&
            !this.isTabAlreadyGrouped(snapshot.tab)
        )
        .sort((a, b) => a.position - b.position);
      for (const snapshot of restorable) {
        const maxIndex = Math.max(0, this.window.gBrowser.tabs.length - 1);
        const desiredIndex = Math.min(
          Math.max(0, snapshot.position),
          maxIndex
        );
        try {
          this.window.gBrowser.moveTabTo(snapshot.tab, desiredIndex);
        } catch {
          // Zen internals may change. Pinned state is more important than exact order.
        }
      }
    }

    renderOperationError(title, message) {
      this.setView(title, "Изменения не продолжаются автоматически.");
      const content = this.h("div", { className: "zst-stack" });
      content.appendChild(
        this.h("div", {
          className: "zst-banner zst-banner-error",
          text: message,
        })
      );
      content.appendChild(
        this.h("p", {
          className: "zst-footnote",
          text:
            "После обновлений Zen внутренний API папок иногда меняется. Подробности будут в Browser Console по метке [ZenSmartTabs].",
        })
      );
      const actions = this.h("div", { className: "zst-actions" });
      const back = this.createButton("К настройкам", "secondary");
      const close = this.createButton("Закрыть", "primary");
      back.addEventListener("click", () => this.renderConfig());
      close.addEventListener("click", () => this.close());
      actions.append(back, close);
      content.appendChild(actions);
      this.viewBody.appendChild(content);
      close.focus();
    }

    collectTabs({ includePinned = false } = {}) {
      const workspaceId = this.getActiveWorkspaceId();
      const excluded = {
        otherWorkspace: 0,
        closing: 0,
        essentials: 0,
        grouped: 0,
        pinned: 0,
        internal: 0,
      };
      const candidates = [];
      let currentWorkspaceTotal = 0;

      for (const tab of Array.from(this.window.gBrowser?.tabs || [])) {
        if (!tab || tab.closing) {
          excluded.closing += 1;
          continue;
        }
        if (!this.isTabInActiveWorkspace(tab, workspaceId)) {
          excluded.otherWorkspace += 1;
          continue;
        }
        currentWorkspaceTotal += 1;

        if (
          tab.hasAttribute?.("zen-essential") ||
          tab.hasAttribute?.("zen-empty-tab")
        ) {
          excluded.essentials += 1;
          continue;
        }
        if (this.isTabAlreadyGrouped(tab)) {
          excluded.grouped += 1;
          continue;
        }
        if (tab.pinned && !includePinned) {
          excluded.pinned += 1;
          continue;
        }

        const descriptor = this.describeTab(tab, candidates.length + 1);
        if (!descriptor) {
          excluded.internal += 1;
          continue;
        }
        candidates.push(descriptor);
      }

      const truncated = Math.max(0, candidates.length - MAX_TABS_PER_REQUEST);
      return {
        tabs: candidates.slice(0, MAX_TABS_PER_REQUEST),
        truncated,
        excluded,
        workspaceId,
        currentWorkspaceTotal,
      };
    }

    describeTab(tab, ordinal) {
      const spec =
        tab.linkedBrowser?.currentURI?.spec || tab.getAttribute?.("url") || "";
      let url;
      try {
        url = new URL(spec);
      } catch {
        return null;
      }

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
      }

      const rawTitle =
        tab.label ||
        tab.getAttribute?.("label") ||
        tab.linkedBrowser?.contentTitle ||
        url.hostname ||
        "Untitled tab";
      const title = this.cleanText(rawTitle, 240) || "Untitled tab";
      const host = this.cleanText(
        url.hostname.replace(/^www\./i, ""),
        120
      );

      return {
        id: `t${ordinal}`,
        title,
        host: host || "unknown-host",
        tab,
      };
    }

    getActiveWorkspaceId() {
      const workspaces = this.window.gZenWorkspaces;
      return String(
        workspaces?.activeWorkspace ||
          workspaces?.getActiveWorkspaceFromCache?.()?.uuid ||
          ""
      );
    }

    isTabInActiveWorkspace(tab, workspaceId = this.getActiveWorkspaceId()) {
      const tabWorkspace = tab.getAttribute?.("zen-workspace-id") || "";
      if (workspaceId && tabWorkspace) {
        return tabWorkspace === workspaceId;
      }

      const workspaces = this.window.gZenWorkspaces;
      if (workspaces?.activeWorkspaceStrip?.contains(tab)) {
        return true;
      }
      if (workspaces?.pinnedTabsContainer?.contains(tab)) {
        return true;
      }
      return !tab.hidden;
    }

    isPrivateOrFoldersDisabled() {
      return Boolean(this.window.gZenWorkspaces?.privateWindowOrDisabled);
    }

    readEnvironmentKey() {
      try {
        const services =
          this.window.Services ||
          (typeof Services !== "undefined" ? Services : null);
        return services?.env?.get("OPENAI_API_KEY")?.trim() || "";
      } catch {
        return "";
      }
    }

    isTabAlreadyGrouped(tab) {
      const group = tab?.group;
      if (!group) {
        return false;
      }
      return group.tagName?.toLowerCase() !== "zen-workspace-collapsible-pins";
    }

    setBusy(isBusy, button = null, busyLabel = "") {
      this.busy = isBusy;
      this.overlay?.toggleAttribute("data-busy", isBusy);
      if (this.closeButton) {
        this.closeButton.disabled = false;
      }

      if (isBusy && button) {
        if (this.busyButton && this.busyButton !== button) {
          this.restoreBusyButton(this.busyButton);
        }
        this.busyButton = button;
        button.dataset.originalText = button.textContent;
        button.disabled = true;
        if (busyLabel) {
          button.textContent = busyLabel;
        }
        button.classList.add("zst-button-busy");
      }

      if (!isBusy) {
        this.restoreBusyButton(button || this.busyButton);
        this.busyButton = null;
      }

      if (!isBusy && this.ui.applyButton) {
        this.updatePreviewSummary();
      }
    }

    restoreBusyButton(button) {
      if (!button) {
        return;
      }
      button.disabled = false;
      if (button.dataset.originalText) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
      }
      button.classList.remove("zst-button-busy");
    }

    showInlineError(message) {
      const status = this.ui.status;
      if (!status) {
        return;
      }
      status.replaceChildren(
        this.h("div", {
          className: "zst-inline-message zst-inline-error",
          text: message,
        })
      );
    }

    showInlineStatus(message) {
      const status = this.ui.status;
      if (!status) {
        return;
      }
      status.replaceChildren(
        this.h("div", {
          className: "zst-inline-message zst-inline-neutral",
          text: message,
        })
      );
    }

    humanizeError(error) {
      const message = this.cleanText(error?.message || String(error), 500);
      switch (error?.status) {
        case 400:
          return `OpenAI отклонил запрос: ${message}`;
        case 401:
          return "OpenAI не принял API key. Проверь ключ и то, что он активен.";
        case 403:
          return `У ключа нет доступа к модели или проекту: ${message}`;
        case 429:
          return "OpenAI временно ограничил запросы или на проекте закончился доступный бюджет/кредиты.";
        default:
          return message || "Неизвестная ошибка.";
      }
    }

    sanitizeFolderName(value, fallback) {
      const name = this.cleanText(value, 42)
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim();
      return name || fallback;
    }

    cleanText(value, maxLength) {
      return String(value ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLength);
    }

    clampInteger(value, min, max) {
      const integer = Number.isFinite(value) ? Math.round(value) : min;
      return Math.min(max, Math.max(min, integer));
    }

    delay(ms) {
      return new Promise(resolve => this.window.setTimeout(resolve, ms));
    }

    pluralizeRu(value, one, few, many) {
      const n = Math.abs(value) % 100;
      const n1 = n % 10;
      if (n > 10 && n < 20) {
        return many;
      }
      if (n1 > 1 && n1 < 5) {
        return few;
      }
      if (n1 === 1) {
        return one;
      }
      return many;
    }
  }

  async function start() {
    try {
      if (window[CONTROLLER_KEY]) {
        window[CONTROLLER_KEY].cleanup();
      }
      const controller = new ZenSmartTabs(window);
      window[CONTROLLER_KEY] = controller;
      await controller.init();
    } catch (error) {
      warn("Initialization failed:", error?.message || error);
    }
  }

  start();
})();
