/**
 * Procurement Dashboard – Client-Side Application Logic.
 *
 * Implements:
 * - Stage 1 & Stage 2 selection gating (Rule FL3)
 * - In-memory data querying and filtering (Rules DL3, FT1–FT12)
 * - Main chart and 10 breakdown charts (Rules CH1–CH10)
 * - 13-column detail table with all-column sorting and 50-row pagination (Rules TB1–TB5)
 * - Refresh Data (DL1) and Reset Filters (DL5, FT10)
 */

(function () {
    "use strict";

    // Application State
    const AppState = {
        // Stage 1 & Stage 2 Defaults (Active on page load)
        granularity: "Monthly",   // "Daily" | "Weekly" | "Monthly" | "Yearly"
        measure: "Spend",         // "Spend" | "Quantity"
        dateBasis: "Posting Date", // "Posting Date" | "Vendor's Doc Date"

        // Metadata & Datasets
        isLoaded: false,
        dataAsOf: null,
        totalRecords: 0,

        // Active Filter Selections (FT3, FT4)
        filters: {
            fromDate: null,
            toDate: null,
            year: [],
            month: [],
            week: [],
            day: [],
            document: [],
            documentType: [],
            purchaseType: [],
            docCurrency: [],
            bpName: [],
            vendorGroup: [],
            industry: [],
            vendorCity: [],
            vendorState: [],
            vendorCountry: [],
            rowBuyer: [],
            receivingState: [],
            receivingCity: [],
            itemGroup: [],
            subGroup1: [],
            subGroup2: [],
            itemCode: [],
            brand: [],
            moc: [],
            madeToOrder: [],
            uom: [],
            itemAttributes: {} // attr_name -> array of selected values
        },

        // Detail Table State (TB4, TB5)
        tableSort: {
            column: "Posting Date",
            direction: "desc"
        },
        tablePage: 1,
        tablePageSize: 50
    };

    // Chart.js Instances Registry
    const ChartInstances = {
        main: null,
        importDomestic: null,
        receivingState: null,
        itemGroup: null,
        subGroup1: null,
        subGroup2: null,
        brand: null,
        buyer: null,
        purchaseType: null,
        topVendors: null,
        vendorGroup: null
    };

    /**
     * Reusable Indian Numbering & Currency Formatter.
     * Implements dynamic compact notation (Cr / Lakh / Thousand) for financial chart axes
     * and exact comma-grouped representations for tooltips, KPI cards, and detail tables.
     */
    const IndianCurrencyFormatter = {
        /**
         * Dynamic compact notation:
         * >= 1,00,00,000 -> ₹X Cr (or -₹X Cr)
         * >= 1,00,000    -> ₹X Lakh (or -₹X Lakh)
         * >= 1,000       -> ₹X Thousand (or -₹X Thousand)
         * < 1,000        -> ₹X (or -₹X)
         * Avoids unnecessary decimal places on whole numbers.
         */
        formatCompact(val, precision = 2) {
            if (val === null || val === undefined || isNaN(val)) return "₹0";
            const num = Number(val);
            if (num === 0) return "₹0";
            const sign = num < 0 ? "-" : "";
            const abs = Math.abs(num);

            let formattedNumber = "";
            let unit = "";

            if (abs >= 10000000) { // 1 Crore = 10,000,000
                const cr = abs / 10000000;
                formattedNumber = (cr % 1 === 0) ? cr.toString() : parseFloat(cr.toFixed(precision)).toString();
                unit = " Cr";
            } else if (abs >= 100000) { // 1 Lakh = 100,000
                const lakh = abs / 100000;
                formattedNumber = (lakh % 1 === 0) ? lakh.toString() : parseFloat(lakh.toFixed(precision)).toString();
                unit = " Lakh";
            } else if (abs >= 1000) { // 1 Thousand = 1,000
                const th = abs / 1000;
                formattedNumber = (th % 1 === 0) ? th.toString() : parseFloat(th.toFixed(precision)).toString();
                unit = " Thousand";
            } else {
                formattedNumber = (abs % 1 === 0) ? abs.toString() : parseFloat(abs.toFixed(precision)).toString();
                unit = "";
            }

            return sign + "₹" + formattedNumber + unit;
        },

        /**
         * Exact currency value formatted with Indian comma grouping and 2 decimal places.
         * e.g. 475252143.59 -> ₹47,52,52,143.59
         */
        formatExact(val) {
            if (val === null || val === undefined || isNaN(val)) return "₹0.00";
            const num = Number(val);
            const sign = num < 0 ? "-" : "";
            const abs = Math.abs(num);
            const formatted = abs.toLocaleString("en-IN", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            });
            return sign + "₹" + formatted;
        },

        /**
         * Formats raw string or number into Indian exact currency.
         * Safely strips existing currency prefixes or western commas first.
         */
        formatCurrencyString(val) {
            if (val === null || val === undefined || val === "" || val === "-") return "-";
            const cleanStr = String(val).replace(/[₹,\s]/g, "");
            const num = Number(cleanStr);
            if (isNaN(num)) return String(val);
            return this.formatExact(num);
        },

        /**
         * Quantity exact number formatted with Indian comma grouping.
         * e.g. 125000 -> 1,25,000.00
         */
        formatQuantity(val, decimals = 2) {
            if (val === null || val === undefined || val === "" || val === "-") return "-";
            const cleanStr = String(val).replace(/[,\s]/g, "");
            const num = Number(cleanStr);
            if (isNaN(num)) return String(val);
            const sign = num < 0 ? "-" : "";
            const abs = Math.abs(num);
            return sign + abs.toLocaleString("en-IN", {
                minimumFractionDigits: decimals,
                maximumFractionDigits: decimals
            });
        }
    };

    // DOM Elements Cache
    const DOM = {
        selectionPromptCard: document.getElementById("selectionPromptCard"),
        dashboardMainContent: document.getElementById("dashboardMainContent"),
        loadingOverlay: document.getElementById("loadingOverlay"),
        loadingText: document.getElementById("loadingText"),
        btnRefreshData: document.getElementById("btnRefreshData"),
        btnResetFilters: document.getElementById("btnResetFilters"),
        btnResetGranularity: document.getElementById("btnResetGranularity"),
        dataAsOfText: document.getElementById("dataAsOfText"),
        noDataAlert: document.getElementById("noDataAlert"),
        activeFilterBadge: document.getElementById("activeFilterBadge"),

        // Stage Controls
        granularityRadios: document.querySelectorAll('input[name="granularity"]'),
        measureRadios: document.querySelectorAll('input[name="measure"]'),
        dateBasisRadios: document.querySelectorAll('input[name="dateBasis"]'),

        // Period Filter Subgroups (FT2)
        filterGroupYear: document.getElementById("filterGroupYear"),
        filterGroupMonth: document.getElementById("filterGroupMonth"),
        filterGroupWeek: document.getElementById("filterGroupWeek"),
        filterGroupDay: document.getElementById("filterGroupDay"),

        // Filter Inputs
        filterFromDate: document.getElementById("filterFromDate"),
        filterToDate: document.getElementById("filterToDate"),
        itemAttributesContainer: document.getElementById("itemAttributesContainer"),

        // Detail Table
        detailTable: document.getElementById("detailTable"),
        detailTableBody: document.getElementById("detailTableBody"),
        tableRowsCountText: document.getElementById("tableRowsCountText"),
        paginationInfo: document.getElementById("paginationInfo"),
        tablePagination: document.getElementById("tablePagination"),

        // KPI elements
        kpiFilteredSpend: document.getElementById("kpiFilteredSpend"),
        kpiFilteredRows: document.getElementById("kpiFilteredRows"),
        kpiActiveSelection: document.getElementById("kpiActiveSelection"),
        mainChartTitle: document.getElementById("mainChartTitle")
    };

    /**
     * Check if both Stage 1 and Stage 2 are selected (FL3).
     */
    function isFlowReady() {
        return !!(AppState.granularity && AppState.measure && AppState.dateBasis);
    }

    /**
     * Update Gating visibility according to Rule FL3.
     */
    function updateGatingVisibility() {
        const ready = isFlowReady();
        if (ready) {
            if (DOM.selectionPromptCard) DOM.selectionPromptCard.style.display = "none";
            if (DOM.dashboardMainContent) DOM.dashboardMainContent.style.display = "block";
            updatePeriodFilterVisibility();
            if (AppState.isLoaded) {
                executeQuery();
            }
        } else {
            if (DOM.selectionPromptCard) DOM.selectionPromptCard.style.display = "block";
            if (DOM.dashboardMainContent) DOM.dashboardMainContent.style.display = "none";
        }
    }

    /**
     * Adjust visible period filters based on Granularity (Rule FT2).
     */
    function updatePeriodFilterVisibility() {
        const gran = AppState.granularity;
        if (!DOM.filterGroupYear) return;

        // Yearly -> Year
        // Monthly -> Year, Month
        // Weekly -> Year, Month, Week
        // Daily -> Year, Month, Week, Day
        DOM.filterGroupYear.style.display = "block";
        DOM.filterGroupMonth.style.display = (gran === "Monthly" || gran === "Weekly" || gran === "Daily") ? "block" : "none";
        DOM.filterGroupWeek.style.display = (gran === "Weekly" || gran === "Daily") ? "block" : "none";
        DOM.filterGroupDay.style.display = (gran === "Daily") ? "block" : "none";
    }

    /**
     * MultiSelectManager - Custom Searchable Multi-Select Dropdowns (FT1 - FT12).
     * Provides search, checkboxes, counts, stale zero counts, removable chips,
     * Select All, Clear actions, and Active Filters summary.
     */
    const MultiSelectManager = (function () {
        const instances = {};

        const sectionMap = {
            year: 1, month: 1, week: 1, day: 1,
            document: 2, documentType: 2, purchaseType: 2, docCurrency: 2,
            bpName: 3, vendorGroup: 3, industry: 3, vendorCity: 3, vendorState: 3, vendorCountry: 3,
            rowBuyer: 4,
            receivingState: 5, receivingCity: 5,
            itemGroup: 6, subGroup1: 6, subGroup2: 6,
            itemCode: 7, brand: 7, moc: 7, madeToOrder: 7, uom: 7
        };

        function escapeHtml(str) {
            if (str === null || str === undefined) return "";
            return String(str)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;");
        }

        function init() {
            document.querySelectorAll("#filterAccordion .filter-group[data-key]").forEach(groupEl => {
                mount(groupEl);
            });

            // Global outside-click handler to close dropdowns
            document.addEventListener("click", function (e) {
                const openDropdown = document.querySelector(".custom-multiselect.is-open");
                if (openDropdown && !openDropdown.contains(e.target)) {
                    openDropdown.classList.remove("is-open");
                    const trigger = openDropdown.querySelector(".multiselect-trigger");
                    if (trigger) trigger.setAttribute("aria-expanded", "false");
                }
            });

            // Global Escape key handler
            document.addEventListener("keydown", function (e) {
                if (e.key === "Escape") {
                    const openDropdown = document.querySelector(".custom-multiselect.is-open");
                    if (openDropdown) {
                        openDropdown.classList.remove("is-open");
                        const trigger = openDropdown.querySelector(".multiselect-trigger");
                        if (trigger) trigger.setAttribute("aria-expanded", "false");
                    }
                }
            });

            // Top Clear All Filters button
            const btnClearAll = document.getElementById("btnClearAllFilters");
            if (btnClearAll) {
                btnClearAll.addEventListener("click", function () {
                    resetFilters();
                });
            }

            // Date Range Clear button
            const btnClearDate = document.getElementById("btnClearDateRange");
            if (btnClearDate) {
                btnClearDate.addEventListener("click", function () {
                    if (DOM.filterFromDate) DOM.filterFromDate.value = "";
                    if (DOM.filterToDate) DOM.filterToDate.value = "";
                    AppState.filters.fromDate = null;
                    AppState.filters.toDate = null;
                    btnClearDate.style.display = "none";
                    updateActiveSummary();
                    executeQuery();
                });
            }
        }

        function mount(groupEl, isAttr = false, attrName = "") {
            const key = isAttr ? `attr_${attrName.replace(/[^a-zA-Z0-9]/g, "_")}` : groupEl.dataset.key;
            const label = isAttr ? attrName : (groupEl.dataset.label || key);
            const targetSelectId = isAttr ? `filterAttr_${attrName.replace(/[^a-zA-Z0-9]/g, "_")}` : groupEl.dataset.target;

            if (instances[key]) return instances[key];

            let headerDiv = groupEl.querySelector(".filter-group-header");
            if (!headerDiv) {
                headerDiv = document.createElement("div");
                headerDiv.className = "filter-group-header";
                headerDiv.innerHTML = `
                    <label class="filter-group-label" for="${targetSelectId}">${escapeHtml(label)}</label>
                    <button type="button" class="filter-clear-link" style="display: none;">Clear</button>
                `;
            }

            const dropdownEl = document.createElement("div");
            dropdownEl.className = "custom-multiselect";
            dropdownEl.innerHTML = `
                <div class="multiselect-trigger" tabindex="0" role="combobox" aria-expanded="false" title="Click to filter ${escapeHtml(label)}">
                    <div class="trigger-content">
                        <span class="trigger-placeholder">All ${escapeHtml(label)}</span>
                    </div>
                    <i class="bi bi-chevron-down trigger-arrow"></i>
                </div>
                <div class="chips-container" style="display: none;"></div>
                <div class="multiselect-menu">
                    <div class="multiselect-header">
                        <div class="multiselect-search-box">
                            <i class="bi bi-search search-icon"></i>
                            <input type="text" class="form-control form-control-sm multiselect-search-input" placeholder="Search ${escapeHtml(label)}..." aria-label="Search ${escapeHtml(label)}">
                        </div>
                        <div class="multiselect-actions-bar">
                            <button type="button" class="action-link select-all-btn">Select All</button>
                            <span class="action-status">0 selected</span>
                            <button type="button" class="action-link text-danger clear-btn">Clear</button>
                        </div>
                    </div>
                    <div class="options-container" role="listbox"></div>
                    <div class="no-options-msg" style="display: none;">No matching options</div>
                </div>
            `;

            let hiddenSelect = document.getElementById(targetSelectId);
            if (!hiddenSelect) {
                hiddenSelect = document.createElement("select");
                hiddenSelect.id = targetSelectId;
                hiddenSelect.className = "d-none";
                hiddenSelect.multiple = true;
                groupEl.appendChild(hiddenSelect);
            } else {
                hiddenSelect.classList.add("d-none");
            }

            const oldLabel = groupEl.querySelector("label:not(.multiselect-option-item)");
            if (oldLabel && oldLabel.parentNode === groupEl) oldLabel.remove();
            groupEl.insertBefore(headerDiv, hiddenSelect);
            groupEl.insertBefore(dropdownEl, hiddenSelect);

            const triggerEl = dropdownEl.querySelector(".multiselect-trigger");
            const chipsEl = dropdownEl.querySelector(".chips-container");
            const menuEl = dropdownEl.querySelector(".multiselect-menu");
            const searchInput = dropdownEl.querySelector(".multiselect-search-input");
            const optionsContainer = dropdownEl.querySelector(".options-container");
            const selectAllBtn = dropdownEl.querySelector(".select-all-btn");
            const clearBtn = dropdownEl.querySelector(".clear-btn");
            const clearLink = headerDiv.querySelector(".filter-clear-link");
            const statusEl = dropdownEl.querySelector(".action-status");
            const noOptionsMsg = dropdownEl.querySelector(".no-options-msg");

            triggerEl.addEventListener("click", function (e) {
                e.stopPropagation();
                const isOpen = dropdownEl.classList.contains("is-open");
                document.querySelectorAll(".custom-multiselect.is-open").forEach(dd => {
                    if (dd !== dropdownEl) {
                        dd.classList.remove("is-open");
                        const trig = dd.querySelector(".multiselect-trigger");
                        if (trig) trig.setAttribute("aria-expanded", "false");
                    }
                });

                if (isOpen) {
                    dropdownEl.classList.remove("is-open");
                    triggerEl.setAttribute("aria-expanded", "false");
                } else {
                    dropdownEl.classList.add("is-open");
                    triggerEl.setAttribute("aria-expanded", "true");
                    setTimeout(() => searchInput.focus(), 50);
                }
            });

            menuEl.addEventListener("click", function (e) {
                e.stopPropagation();
            });

            searchInput.addEventListener("input", function () {
                const term = this.value.trim().toLowerCase();
                let visibleCount = 0;
                const items = optionsContainer.querySelectorAll(".multiselect-option-item");
                items.forEach(item => {
                    const val = (item.dataset.value || "").toLowerCase();
                    if (!term || val.includes(term)) {
                        item.style.display = "flex";
                        visibleCount++;
                    } else {
                        item.style.display = "none";
                    }
                });
                noOptionsMsg.style.display = (visibleCount === 0 && items.length > 0) ? "block" : "none";
            });

            selectAllBtn.addEventListener("click", function () {
                const visibleCheckboxes = Array.from(optionsContainer.querySelectorAll('.multiselect-option-item:not([style*="display: none"]) input[type="checkbox"]'));
                const selectedVals = new Set(getSelected(key, isAttr, attrName));
                visibleCheckboxes.forEach(cb => {
                    cb.checked = true;
                    selectedVals.add(cb.value);
                });
                setSelected(key, Array.from(selectedVals), isAttr, attrName);
                refreshUI(key);
                updateActiveSummary();
                executeQuery();
            });

            clearBtn.addEventListener("click", function () {
                setSelected(key, [], isAttr, attrName);
                optionsContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
                optionsContainer.querySelectorAll('.multiselect-option-item').forEach(item => { item.classList.remove("is-selected"); });
                refreshUI(key);
                updateActiveSummary();
                executeQuery();
            });

            clearLink.addEventListener("click", function () {
                setSelected(key, [], isAttr, attrName);
                optionsContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
                optionsContainer.querySelectorAll('.multiselect-option-item').forEach(item => { item.classList.remove("is-selected"); });
                refreshUI(key);
                updateActiveSummary();
                executeQuery();
            });

            instances[key] = {
                key,
                label,
                targetSelectId,
                isAttr,
                attrName,
                groupEl,
                dropdownEl,
                triggerEl,
                chipsEl,
                menuEl,
                searchInput,
                optionsContainer,
                selectAllBtn,
                clearBtn,
                clearLink,
                statusEl,
                noOptionsMsg,
                hiddenSelect
            };

            return instances[key];
        }

        function getSelected(key, isAttr, attrName) {
            if (isAttr) {
                return (AppState.filters.itemAttributes && AppState.filters.itemAttributes[attrName]) || [];
            }
            return AppState.filters[key] || [];
        }

        function setSelected(key, values, isAttr, attrName) {
            if (isAttr) {
                if (!AppState.filters.itemAttributes) AppState.filters.itemAttributes = {};
                AppState.filters.itemAttributes[attrName] = values;
            } else {
                AppState.filters[key] = values;
            }
        }

        function removeSingleValue(key, valToRemove, isAttr, attrName) {
            const current = getSelected(key, isAttr, attrName);
            const updated = current.filter(v => v !== valToRemove);
            setSelected(key, updated, isAttr, attrName);
            const inst = instances[key];
            if (inst) {
                inst.optionsContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    if (cb.value === valToRemove) {
                        cb.checked = false;
                        const parent = cb.closest(".multiselect-option-item");
                        if (parent) parent.classList.remove("is-selected");
                    }
                });
                refreshUI(key);
            }
            updateActiveSummary();
            executeQuery();
        }

        function refreshUI(key) {
            const inst = instances[key];
            if (!inst) return;

            const selected = getSelected(key, inst.isAttr, inst.attrName);
            const count = selected.length;

            const contentDiv = inst.triggerEl.querySelector(".trigger-content");
            if (count === 0) {
                contentDiv.innerHTML = `<span class="trigger-placeholder">All ${escapeHtml(inst.label)}</span>`;
                inst.chipsEl.style.display = "none";
                inst.chipsEl.innerHTML = "";
                inst.clearLink.style.display = "none";
            } else {
                contentDiv.innerHTML = `
                    <span class="fw-semibold text-dark text-truncate">${escapeHtml(inst.label)}:</span>
                    <span class="trigger-badge">${count} selected</span>
                `;
                inst.clearLink.style.display = "inline";

                inst.chipsEl.style.display = "flex";
                inst.chipsEl.innerHTML = "";

                const displayChips = selected.slice(0, 2);
                displayChips.forEach(val => {
                    const chip = document.createElement("span");
                    chip.className = "filter-chip";
                    chip.innerHTML = `
                        <span class="filter-chip-text" title="${escapeHtml(val)}">${escapeHtml(val)}</span>
                        <button type="button" class="filter-chip-remove" title="Remove ${escapeHtml(val)}">&times;</button>
                    `;
                    chip.querySelector(".filter-chip-remove").addEventListener("click", function (e) {
                        e.stopPropagation();
                        removeSingleValue(key, val, inst.isAttr, inst.attrName);
                    });
                    inst.chipsEl.appendChild(chip);
                });

                if (count > 2) {
                    const morePill = document.createElement("span");
                    morePill.className = "filter-chip-more";
                    morePill.textContent = `+${count - 2} more`;
                    inst.chipsEl.appendChild(morePill);
                }
            }

            inst.statusEl.textContent = `${count} selected`;

            if (inst.hiddenSelect) {
                Array.from(inst.hiddenSelect.options).forEach(opt => {
                    opt.selected = selected.includes(opt.value);
                });
            }
        }

        function updateOptions(key, optionsList) {
            const inst = instances[key];
            if (!inst) return;

            const selectedSet = new Set(getSelected(key, inst.isAttr, inst.attrName));
            inst.optionsContainer.innerHTML = "";

            if (inst.hiddenSelect) {
                inst.hiddenSelect.innerHTML = "";
            }

            optionsList.forEach(opt => {
                const val = opt.value;
                const count = opt.count || 0;
                const isStale = !!opt.is_stale || count === 0;
                const isSelected = selectedSet.has(val);

                const item = document.createElement("label");
                item.className = `multiselect-option-item ${isSelected ? "is-selected" : ""} ${isStale ? "is-stale" : ""}`;
                item.dataset.value = val;

                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.className = "form-check-input";
                checkbox.value = val;
                checkbox.checked = isSelected;

                checkbox.addEventListener("change", function () {
                    const current = new Set(getSelected(key, inst.isAttr, inst.attrName));
                    if (this.checked) {
                        current.add(this.value);
                        item.classList.add("is-selected");
                    } else {
                        current.delete(this.value);
                        item.classList.remove("is-selected");
                    }
                    setSelected(key, Array.from(current), inst.isAttr, inst.attrName);
                    refreshUI(key);
                    updateActiveSummary();
                    executeQuery();
                });

                const textWrap = document.createElement("div");
                textWrap.className = "option-text-wrapper";

                const labelSpan = document.createElement("span");
                labelSpan.className = "option-label";
                labelSpan.textContent = val;

                textWrap.appendChild(checkbox);
                textWrap.appendChild(labelSpan);

                const countSpan = document.createElement("span");
                countSpan.className = "option-count";
                countSpan.textContent = `(${count.toLocaleString("en-IN")})`;

                item.appendChild(textWrap);
                item.appendChild(countSpan);
                inst.optionsContainer.appendChild(item);

                if (inst.hiddenSelect) {
                    const optElem = document.createElement("option");
                    optElem.value = val;
                    optElem.textContent = `${val} (${count})`;
                    optElem.selected = isSelected;
                    if (isStale) optElem.className = "stale-option";
                    inst.hiddenSelect.appendChild(optElem);
                }
            });

            const currentSearch = inst.searchInput.value.trim().toLowerCase();
            if (currentSearch) {
                inst.searchInput.dispatchEvent(new Event("input"));
            } else {
                inst.noOptionsMsg.style.display = optionsList.length === 0 ? "block" : "none";
            }

            refreshUI(key);
        }

        function updateActiveSummary() {
            let totalActive = 0;
            const activeFiltersList = [];

            if (AppState.filters.fromDate || AppState.filters.toDate) {
                totalActive++;
                const dateLabel = (AppState.filters.fromDate && AppState.filters.toDate)
                    ? `${AppState.filters.fromDate} to ${AppState.filters.toDate}`
                    : (AppState.filters.fromDate ? `From ${AppState.filters.fromDate}` : `To ${AppState.filters.toDate}`);
                activeFiltersList.push({
                    label: "Date",
                    val: dateLabel,
                    remove: () => {
                        if (DOM.filterFromDate) DOM.filterFromDate.value = "";
                        if (DOM.filterToDate) DOM.filterToDate.value = "";
                        AppState.filters.fromDate = null;
                        AppState.filters.toDate = null;
                        const clearBtn = document.getElementById("btnClearDateRange");
                        if (clearBtn) clearBtn.style.display = "none";
                        updateActiveSummary();
                        executeQuery();
                    }
                });
                const clearBtn = document.getElementById("btnClearDateRange");
                if (clearBtn) clearBtn.style.display = "inline";
            } else {
                const clearBtn = document.getElementById("btnClearDateRange");
                if (clearBtn) clearBtn.style.display = "none";
            }

            const sectionCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
            if (AppState.filters.fromDate || AppState.filters.toDate) sectionCounts[1]++;

            for (const [key, inst] of Object.entries(instances)) {
                if (inst.isAttr) continue;
                const vals = AppState.filters[key] || [];
                if (vals.length > 0) {
                    totalActive += vals.length;
                    const sec = sectionMap[key] || 1;
                    sectionCounts[sec] += vals.length;
                    vals.forEach(v => {
                        activeFiltersList.push({
                            label: inst.label,
                            val: v,
                            remove: () => removeSingleValue(key, v, false, "")
                        });
                    });
                }
            }

            if (AppState.filters.itemAttributes) {
                for (const [attrName, vals] of Object.entries(AppState.filters.itemAttributes)) {
                    if (vals && vals.length > 0) {
                        totalActive += vals.length;
                        sectionCounts[8] += vals.length;
                        const attrKey = `attr_${attrName.replace(/[^a-zA-Z0-9]/g, "_")}`;
                        vals.forEach(v => {
                            activeFiltersList.push({
                                label: attrName,
                                val: v,
                                remove: () => removeSingleValue(attrKey, v, true, attrName)
                            });
                        });
                    }
                }
            }

            const topBadge = document.getElementById("activeFilterBadge");
            if (topBadge) {
                topBadge.textContent = totalActive.toString();
                topBadge.className = totalActive > 0 ? "badge rounded-pill bg-primary text-white" : "badge rounded-pill bg-light text-secondary border";
            }

            const btnClearAll = document.getElementById("btnClearAllFilters");
            if (btnClearAll) {
                btnClearAll.style.display = totalActive > 0 ? "inline" : "none";
            }

            const chipsContainer = document.getElementById("activeFilterChipsContainer");
            if (chipsContainer) {
                if (totalActive === 0) {
                    chipsContainer.style.display = "none";
                    chipsContainer.innerHTML = "";
                } else {
                    chipsContainer.style.display = "flex";
                    chipsContainer.innerHTML = "";
                    activeFiltersList.forEach(item => {
                        const chip = document.createElement("span");
                        chip.className = "active-chip";
                        chip.innerHTML = `
                            <span class="active-chip-text" title="${escapeHtml(item.label)}: ${escapeHtml(item.val)}">
                                <strong class="text-dark">${escapeHtml(item.label)}:</strong> ${escapeHtml(item.val)}
                            </span>
                            <button type="button" class="active-chip-remove" title="Remove filter">&times;</button>
                        `;
                        chip.querySelector(".active-chip-remove").addEventListener("click", item.remove);
                        chipsContainer.appendChild(chip);
                    });
                }
            }

            for (let s = 1; s <= 8; s++) {
                const badge = document.getElementById(`badge_section_${s}`);
                if (badge) {
                    const sCount = sectionCounts[s] || 0;
                    if (sCount > 0) {
                        badge.textContent = sCount.toString();
                        badge.style.display = "inline-block";
                    } else {
                        badge.style.display = "none";
                    }
                }
            }
        }

        function reset() {
            for (const [key, inst] of Object.entries(instances)) {
                if (inst.optionsContainer) {
                    inst.optionsContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
                    inst.optionsContainer.querySelectorAll('.multiselect-option-item').forEach(item => { item.classList.remove("is-selected"); });
                }
                if (inst.searchInput) inst.searchInput.value = "";
                refreshUI(key);
            }
            updateActiveSummary();
        }

        return {
            init,
            mount,
            updateOptions,
            updateActiveSummary,
            refreshUI,
            reset
        };
    })();

    /**
     * Setup event listeners for buttons, filters, and tables.
     */
    function setupEventListeners() {
        // Initialize Searchable Multi-Select Dropdowns Manager
        MultiSelectManager.init();
        // Granularity
        DOM.granularityRadios.forEach(radio => {
            if (radio.checked) AppState.granularity = radio.value;
            radio.addEventListener("change", function () {
                if (this.checked) {
                    AppState.granularity = this.value;
                    updateGatingVisibility();
                }
            });
        });

        // Measure
        DOM.measureRadios.forEach(radio => {
            if (radio.checked) AppState.measure = radio.value;
            radio.addEventListener("change", function () {
                if (this.checked) {
                    AppState.measure = this.value;
                    updateGatingVisibility();
                }
            });
        });

        // Date Basis
        DOM.dateBasisRadios.forEach(radio => {
            if (radio.checked) AppState.dateBasis = radio.value;
            radio.addEventListener("change", function () {
                if (this.checked) {
                    AppState.dateBasis = this.value;
                    updateGatingVisibility();
                }
            });
        });

        // Reset Granularity
        if (DOM.btnResetGranularity) {
            DOM.btnResetGranularity.addEventListener("click", function () {
                resetGranularity();
            });
        }

        // Reset Filters (DL5, FT10)
        if (DOM.btnResetFilters) {
            DOM.btnResetFilters.addEventListener("click", function () {
                resetFilters();
            });
        }

        // Refresh Data (DL1)
        if (DOM.btnRefreshData) {
            DOM.btnRefreshData.addEventListener("click", function () {
                loadProcurementDataset(true);
            });
        }

        // Date pickers (FT8)
        if (DOM.filterFromDate) {
            DOM.filterFromDate.addEventListener("change", function () {
                AppState.filters.fromDate = this.value || null;
                executeQuery();
            });
        }
        if (DOM.filterToDate) {
            DOM.filterToDate.addEventListener("change", function () {
                AppState.filters.toDate = this.value || null;
                executeQuery();
            });
        }



        // Detail table header sorting (TB4)
        if (DOM.detailTable) {
            DOM.detailTable.querySelectorAll("th[data-col]").forEach(th => {
                th.addEventListener("click", function () {
                    const colName = this.getAttribute("data-col");
                    if (!colName || colName === "#") return;

                    if (AppState.tableSort.column === colName) {
                        AppState.tableSort.direction = (AppState.tableSort.direction === "asc") ? "desc" : "asc";
                    } else {
                        AppState.tableSort.column = colName;
                        AppState.tableSort.direction = (colName.includes("Date") || colName.includes("Total")) ? "desc" : "asc";
                    }
                    AppState.tablePage = 1;
                    executeQuery();
                });
            });
        }
    }

    /**
     * Reset Granularity, Measure, and Date Basis selections.
     * Clears all three selection groups, removes active button styling,
     * hides charts/table, and displays the welcome panel without reloading data.
     */
    function resetGranularity() {
        AppState.granularity = null;
        AppState.measure = null;
        AppState.dateBasis = null;

        if (DOM.granularityRadios) {
            DOM.granularityRadios.forEach(radio => {
                radio.checked = false;
            });
        }

        if (DOM.measureRadios) {
            DOM.measureRadios.forEach(radio => {
                radio.checked = false;
            });
        }

        if (DOM.dateBasisRadios) {
            DOM.dateBasisRadios.forEach(radio => {
                radio.checked = false;
            });
        }

        updateGatingVisibility();
    }

    /**
     * Reset filters to unselected (FT10).
     * Does NOT re-query the view or change Granularity / Measure / Date Basis.
     */
    function resetFilters() {
        for (const key in AppState.filters) {
            if (key === "itemAttributes") {
                AppState.filters.itemAttributes = {};
            } else if (Array.isArray(AppState.filters[key])) {
                AppState.filters[key] = [];
            } else {
                AppState.filters[key] = null;
            }
        }

        MultiSelectManager.reset();

        // Reset calendar inputs
        if (DOM.filterFromDate) DOM.filterFromDate.value = "";
        if (DOM.filterToDate) DOM.filterToDate.value = "";
        const clearDateBtn = document.getElementById("btnClearDateRange");
        if (clearDateBtn) clearDateBtn.style.display = "none";

        if (AppState.isLoaded && isFlowReady()) {
            AppState.tablePage = 1;
            executeQuery();
        }
    }

    /**
     * Execute In-Memory Query via Backend endpoint.
     */
    async function executeQuery() {
        if (!isFlowReady() || !AppState.isLoaded) return;

        const payload = {
            granularity: AppState.granularity,
            measure: AppState.measure,
            date_basis: AppState.dateBasis,
            filters: AppState.filters,
            page: AppState.tablePage,
            page_size: AppState.tablePageSize,
            sort_column: AppState.tableSort.column,
            sort_direction: AppState.tableSort.direction
        };

        try {
            const resp = await fetch("/api/procurement/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!resp.ok) throw new Error(`Query error ${resp.status}`);
            const data = await resp.json();

            // Update UI components
            updateKpiStrip(data);
            updateFilterOptions(data.filter_options);

            if (data.no_data) {
                if (DOM.noDataAlert) DOM.noDataAlert.style.display = "flex";
                destroyAllCharts();
                clearDetailTable();
            } else {
                if (DOM.noDataAlert) DOM.noDataAlert.style.display = "none";
                renderMainChart(data.main_chart);
                renderBreakdownCharts(data.breakdown_charts);
                renderDetailTable(data.table_data);
            }
        } catch (err) {
            console.error("Query execution failed:", err);
        }
    }

    /**
     * Update top KPI cards.
     */
    function updateKpiStrip(data) {
        if (DOM.kpiFilteredSpend) {
            const rawSpend = (data.total_spend !== undefined && data.total_spend !== null) ? Number(data.total_spend) : 0;
            const compactSpend = IndianCurrencyFormatter.formatCompact(rawSpend, 2);
            const exactSpend = IndianCurrencyFormatter.formatExact(rawSpend);
            DOM.kpiFilteredSpend.textContent = compactSpend;
            DOM.kpiFilteredSpend.setAttribute("title", `Exact Value: ${exactSpend}`);

            const exactEl = document.getElementById("kpiFilteredSpendExact");
            if (exactEl) {
                exactEl.textContent = `Exact: ${exactSpend}`;
            }
        }
        if (DOM.kpiFilteredRows) {
            DOM.kpiFilteredRows.textContent = (data.record_count || 0).toLocaleString("en-IN");
        }
        if (DOM.kpiActiveSelection) {
            DOM.kpiActiveSelection.textContent = `${AppState.granularity} • ${AppState.measure} • ${AppState.dateBasis}`;
        }
        if (DOM.mainChartTitle) {
            DOM.mainChartTitle.textContent = `Procurement ${AppState.measure} by Period (${AppState.granularity}) – ${AppState.dateBasis}`;
        }

        // Active filter summary & section badges
        MultiSelectManager.updateActiveSummary();
    }

    /**
     * Populate faceted filter options with matching row counts (FT5, FT6, FT7).
     */
    function updateFilterOptions(filterOptions) {
        if (!filterOptions) return;

        const filterKeys = [
            "year", "month", "week", "day",
            "document", "documentType", "purchaseType", "docCurrency",
            "bpName", "vendorGroup", "industry", "vendorCity", "vendorState", "vendorCountry",
            "rowBuyer",
            "receivingState", "receivingCity",
            "itemGroup", "subGroup1", "subGroup2",
            "itemCode", "brand", "moc", "madeToOrder", "uom"
        ];

        filterKeys.forEach(fKey => {
            if (filterOptions[fKey]) {
                MultiSelectManager.updateOptions(fKey, filterOptions[fKey]);
            }
        });

        // Section 8: Item Attributes
        if (DOM.itemAttributesContainer && filterOptions.itemAttributes) {
            updateItemAttributeFilters(filterOptions.itemAttributes);
        }

        MultiSelectManager.updateActiveSummary();
    }

    /**
     * Render dynamic Item Attribute dropdowns (FT1-8).
     */
    function updateItemAttributeFilters(attrsObj) {
        if (!DOM.itemAttributesContainer) return;

        for (const [attrName, options] of Object.entries(attrsObj)) {
            const attrKey = `attr_${attrName.replace(/[^a-zA-Z0-9]/g, "_")}`;
            let groupDiv = document.getElementById(`group_${attrKey}`);

            if (!groupDiv) {
                groupDiv = document.createElement("div");
                groupDiv.id = `group_${attrKey}`;
                groupDiv.className = "filter-group mb-2";
                groupDiv.dataset.key = attrKey;
                groupDiv.dataset.label = attrName;
                groupDiv.dataset.target = `filterAttr_${attrKey}`;
                DOM.itemAttributesContainer.appendChild(groupDiv);
                MultiSelectManager.mount(groupDiv, true, attrName);
            }

            MultiSelectManager.updateOptions(attrKey, options);
        }
    }

    /**
     * Render Main Vertical Bar Chart (CH1, CH2).
     */
    function renderMainChart(chartData) {
        const canvas = document.getElementById("mainChartCanvas");
        if (!canvas) return;

        if (ChartInstances.main) {
            ChartInstances.main.destroy();
        }

        const ctx = canvas.getContext("2d");
        ChartInstances.main = new Chart(ctx, {
            type: "bar",
            data: chartData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        grid: { display: false }
                    },
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: function (val) {
                                if (AppState.measure === "Spend") {
                                    return IndianCurrencyFormatter.formatCompact(val);
                                }
                                return Number(val).toLocaleString("en-IN");
                            }
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: AppState.measure === "Quantity"
                    },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                const rawVal = context.raw;
                                if (AppState.measure === "Spend") {
                                    const compact = IndianCurrencyFormatter.formatCompact(rawVal, 2);
                                    const exact = IndianCurrencyFormatter.formatExact(rawVal);
                                    return [
                                        compact,
                                        `Exact Value: ${exact}`
                                    ];
                                }
                                const num = Number(rawVal);
                                const formattedQty = num.toLocaleString("en-IN", {
                                    minimumFractionDigits: 0,
                                    maximumFractionDigits: 2
                                });
                                const uom = context.dataset.label ? `${context.dataset.label}: ` : "";
                                return `${uom}${formattedQty}`;
                            }
                        }
                    }
                }
            }
        });
    }

    /**
     * Render all 10 Horizontal Breakdown Bar Charts (CH3–CH10).
     */
    function renderBreakdownCharts(breakdowns) {
        if (!breakdowns) return;

        const chartConfigMap = [
            { key: "import_domestic", id: "chartImportDomestic", inst: "importDomestic" },
            { key: "receiving_state", id: "chartReceivingState", inst: "receivingState" },
            { key: "item_group", id: "chartItemGroup", inst: "itemGroup" },
            { key: "sub_group1", id: "chartSubGroup1", inst: "subGroup1" },
            { key: "sub_group2", id: "chartSubGroup2", inst: "subGroup2" },
            { key: "brand", id: "chartBrand", inst: "brand" },
            { key: "buyer", id: "chartBuyer", inst: "buyer" },
            { key: "purchase_type", id: "chartPurchaseType", inst: "purchaseType" },
            { key: "top_vendors", id: "chartTopVendors", inst: "topVendors" },
            { key: "vendor_group", id: "chartVendorGroup", inst: "vendorGroup" }
        ];

        chartConfigMap.forEach(cfg => {
            const canvas = document.getElementById(cfg.id);
            if (!canvas || !breakdowns[cfg.key]) return;

            if (ChartInstances[cfg.inst]) {
                ChartInstances[cfg.inst].destroy();
            }

            const cData = breakdowns[cfg.key];
            const barHeight = Math.max(220, (cData.labels.length || 0) * 26);
            canvas.style.height = `${barHeight}px`;

            const ctx = canvas.getContext("2d");
            ChartInstances[cfg.inst] = new Chart(ctx, {
                type: "bar",
                data: cData,
                options: {
                    indexAxis: "y", // Horizontal bars (CH5)
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: {
                            beginAtZero: true,
                            ticks: {
                                callback: function (val) {
                                    if (AppState.measure === "Spend") {
                                        return IndianCurrencyFormatter.formatCompact(val);
                                    }
                                    return Number(val).toLocaleString("en-IN");
                                }
                            }
                        },
                        y: {
                            grid: { display: false }
                        }
                    },
                    plugins: {
                        legend: {
                            display: AppState.measure === "Quantity"
                        },
                        tooltip: {
                            callbacks: {
                                label: function (context) {
                                    const rawVal = context.raw;
                                    if (AppState.measure === "Spend") {
                                        const compact = IndianCurrencyFormatter.formatCompact(rawVal, 2);
                                        const exact = IndianCurrencyFormatter.formatExact(rawVal);
                                        return [
                                            compact,
                                            `Exact Value: ${exact}`
                                        ];
                                    }
                                    const num = Number(rawVal);
                                    const formattedQty = num.toLocaleString("en-IN", {
                                        minimumFractionDigits: 0,
                                        maximumFractionDigits: 2
                                    });
                                    const label = context.dataset.label || "Quantity";
                                    return `${label}: ${formattedQty}`;
                                }
                            }
                        }
                    }
                }
            });
        });
    }

    /**
     * Render Detail Table (TB1–TB5).
     */
    function renderDetailTable(tData) {
        if (!DOM.detailTableBody || !tData) return;

        DOM.detailTableBody.innerHTML = "";

        if (tData.rows && tData.rows.length > 0) {
            tData.rows.forEach(r => {
                const tr = document.createElement("tr");
                const rowSpend = r["Row Total (After Doc Disc)"];
                const isNeg = String(rowSpend).includes("-");
                const formattedSpend = IndianCurrencyFormatter.formatCurrencyString(rowSpend);
                const formattedQty = IndianCurrencyFormatter.formatQuantity(r.Quantity, 2);
                tr.innerHTML = `
                    <td class="text-muted">${r["#"]}</td>
                    <td class="fw-bold">${r.DocNum}</td>
                    <td><span class="badge bg-${r.Document === 'AP Invoice' ? 'primary' : 'warning text-dark'}">${r.Document}</span></td>
                    <td>${r["Document Type"]}</td>
                    <td>${r["Posting Date"]}</td>
                    <td>${r["Vendors Doc Date"]}</td>
                    <td class="text-truncate" style="max-width: 180px;" title="${r["BP Name"]}">${r["BP Name"]}</td>
                    <td>${r["Item Code"]}</td>
                    <td class="text-end font-monospace">${formattedQty}</td>
                    <td><span class="badge bg-light text-dark border">${r.UoM || "-"}</span></td>
                    <td class="text-end font-monospace fw-semibold ${isNeg ? 'text-danger' : 'text-dark'}">${formattedSpend}</td>
                    <td>${r["Vendors Doc No."]}</td>
                    <td>${r["Row Buyer"]}</td>
                `;
                DOM.detailTableBody.appendChild(tr);
            });
        }

        // Paging status
        if (DOM.tableRowsCountText) {
            DOM.tableRowsCountText.textContent = `Rows ${tData.start_row}–${tData.end_row} of ${tData.total_rows.toLocaleString("en-IN")}`;
        }
        if (DOM.paginationInfo) {
            DOM.paginationInfo.textContent = `Showing rows ${tData.start_row} to ${tData.end_row} of ${tData.total_rows.toLocaleString("en-IN")} records`;
        }

        renderPagination(tData.page, tData.total_pages);
    }

    /**
     * Render pagination controls (TB5).
     */
    function renderPagination(currentPage, totalPages) {
        if (!DOM.tablePagination) return;
        DOM.tablePagination.innerHTML = "";

        if (totalPages <= 1) return;

        // Previous button
        const prevLi = document.createElement("li");
        prevLi.className = `page-item ${currentPage <= 1 ? 'disabled' : ''}`;
        prevLi.innerHTML = `<a class="page-link" href="#" aria-label="Previous">&laquo;</a>`;
        prevLi.addEventListener("click", function (e) {
            e.preventDefault();
            if (currentPage > 1) {
                AppState.tablePage = currentPage - 1;
                executeQuery();
            }
        });
        DOM.tablePagination.appendChild(prevLi);

        // Max 5 page links around current
        const startP = Math.max(1, currentPage - 2);
        const endP = Math.min(totalPages, currentPage + 2);

        for (let p = startP; p <= endP; p++) {
            const li = document.createElement("li");
            li.className = `page-item ${p === currentPage ? 'active' : ''}`;
            li.innerHTML = `<a class="page-link" href="#">${p}</a>`;
            li.addEventListener("click", (function (targetPage) {
                return function (e) {
                    e.preventDefault();
                    if (AppState.tablePage !== targetPage) {
                        AppState.tablePage = targetPage;
                        executeQuery();
                    }
                };
            })(p));
            DOM.tablePagination.appendChild(li);
        }

        // Next button
        const nextLi = document.createElement("li");
        nextLi.className = `page-item ${currentPage >= totalPages ? 'disabled' : ''}`;
        nextLi.innerHTML = `<a class="page-link" href="#" aria-label="Next">&raquo;</a>`;
        nextLi.addEventListener("click", function (e) {
            e.preventDefault();
            if (currentPage < totalPages) {
                AppState.tablePage = currentPage + 1;
                executeQuery();
            }
        });
        DOM.tablePagination.appendChild(nextLi);
    }

    function destroyAllCharts() {
        for (const [k, inst] of Object.entries(ChartInstances)) {
            if (inst) {
                inst.destroy();
                ChartInstances[k] = null;
            }
        }
    }

    function clearDetailTable() {
        if (DOM.detailTableBody) DOM.detailTableBody.innerHTML = "";
        if (DOM.tableRowsCountText) DOM.tableRowsCountText.textContent = "Rows 0–0 of 0";
        if (DOM.paginationInfo) DOM.paginationInfo.textContent = "Showing 0 to 0 of 0 entries";
        if (DOM.tablePagination) DOM.tablePagination.innerHTML = "";
    }

    /**
     * Fetch full dataset from backend (DL1).
     */
    async function loadProcurementDataset(isRefresh = false) {
        if (DOM.loadingOverlay) {
            DOM.loadingOverlay.style.display = "flex";
            if (DOM.loadingText) {
                DOM.loadingText.textContent = isRefresh ? "Refreshing Data from Server..." : "Loading Procurement Data...";
            }
        }

        try {
            const resp = await fetch("/api/procurement/dataset" + (isRefresh ? "?refresh=true" : ""));
            if (!resp.ok) {
                throw new Error(`HTTP error ${resp.status}`);
            }
            const data = await resp.json();
            AppState.isLoaded = true;
            AppState.dataAsOf = data.data_as_of;
            AppState.totalRecords = data.record_count || 0;

            if (DOM.dataAsOfText && data.data_as_of_formatted) {
                DOM.dataAsOfText.textContent = `Data as of ${data.data_as_of_formatted}`;
            }

            if (isFlowReady()) {
                executeQuery();
            }
        } catch (err) {
            console.error("Failed to load procurement dataset:", err);
        } finally {
            if (DOM.loadingOverlay) {
                DOM.loadingOverlay.style.display = "none";
            }
        }
    }

    // Initialize on DOM load
    document.addEventListener("DOMContentLoaded", function () {
        setupEventListeners();
        updateGatingVisibility();
        loadProcurementDataset(false);
    });

    // Expose for testing
    window.ProcurementApp = {
        state: AppState,
        isFlowReady: isFlowReady,
        resetFilters: resetFilters,
        executeQuery: executeQuery,
        loadDataset: loadProcurementDataset,
        multiSelectManager: MultiSelectManager,
        indianCurrencyFormatter: IndianCurrencyFormatter
    };

})();
