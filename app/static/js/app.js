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
        // Stage 1 & Stage 2
        granularity: null,   // "Daily" | "Weekly" | "Monthly" | "Yearly"
        measure: null,       // "Spend" | "Quantity"
        dateBasis: null,     // "Posting Date" | "Vendor's Doc Date"

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

    // DOM Elements Cache
    const DOM = {
        selectionPromptCard: document.getElementById("selectionPromptCard"),
        dashboardMainContent: document.getElementById("dashboardMainContent"),
        loadingOverlay: document.getElementById("loadingOverlay"),
        loadingText: document.getElementById("loadingText"),
        btnRefreshData: document.getElementById("btnRefreshData"),
        btnResetFilters: document.getElementById("btnResetFilters"),
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
     * Setup event listeners for Stage 1 & Stage 2 buttons, filters, and tables.
     */
    function setupEventListeners() {
        // Granularity
        DOM.granularityRadios.forEach(radio => {
            radio.addEventListener("change", function () {
                if (this.checked) {
                    AppState.granularity = this.value;
                    updateGatingVisibility();
                }
            });
        });

        // Measure
        DOM.measureRadios.forEach(radio => {
            radio.addEventListener("change", function () {
                if (this.checked) {
                    AppState.measure = this.value;
                    updateGatingVisibility();
                }
            });
        });

        // Date Basis
        DOM.dateBasisRadios.forEach(radio => {
            radio.addEventListener("change", function () {
                if (this.checked) {
                    AppState.dateBasis = this.value;
                    updateGatingVisibility();
                }
            });
        });

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

        // Standard select element change bindings
        const selectBindings = {
            filterYear: "year",
            filterMonth: "month",
            filterWeek: "week",
            filterDay: "day",
            filterDocument: "document",
            filterDocumentType: "documentType",
            filterPurchaseType: "purchaseType",
            filterDocCurrency: "docCurrency",
            filterBPName: "bpName",
            filterVendorGroup: "vendorGroup",
            industry: "industry",
            filterIndustry: "industry",
            filterVendorCity: "vendorCity",
            filterVendorState: "vendorState",
            filterVendorCountry: "vendorCountry",
            filterRowBuyer: "rowBuyer",
            filterReceivingState: "receivingState",
            filterReceivingCity: "receivingCity",
            filterItemGroup: "itemGroup",
            filterSubGroup1: "subGroup1",
            filterSubGroup2: "subGroup2",
            filterItemCode: "itemCode",
            filterBrand: "brand",
            filterMOC: "moc",
            filterMadeToOrder: "madeToOrder",
            filterUoM: "uom"
        };

        for (const [elemId, stateKey] of Object.entries(selectBindings)) {
            const el = document.getElementById(elemId);
            if (el) {
                el.addEventListener("change", function () {
                    const selected = Array.from(this.selectedOptions).map(o => o.value);
                    AppState.filters[stateKey] = selected;
                    executeQuery();
                });
            }
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
     * Reset Stage 3 filters to unselected (FT10).
     * Does NOT re-query the view or change Stage 1 & 2.
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

        // Reset select elements
        document.querySelectorAll("#filterAccordion select").forEach(sel => {
            for (let i = 0; i < sel.options.length; i++) {
                sel.options[i].selected = false;
            }
        });

        // Reset calendar inputs
        if (DOM.filterFromDate) DOM.filterFromDate.value = "";
        if (DOM.filterToDate) DOM.filterToDate.value = "";

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
            DOM.kpiFilteredSpend.textContent = data.total_spend_formatted || "₹0.00";
        }
        if (DOM.kpiFilteredRows) {
            DOM.kpiFilteredRows.textContent = (data.record_count || 0).toLocaleString();
        }
        if (DOM.kpiActiveSelection) {
            DOM.kpiActiveSelection.textContent = `${AppState.granularity} • ${AppState.measure} • ${AppState.dateBasis}`;
        }
        if (DOM.mainChartTitle) {
            DOM.mainChartTitle.textContent = `Procurement ${AppState.measure} by Period (${AppState.granularity}) – ${AppState.dateBasis}`;
        }

        // Active filter counter
        let activeCount = 0;
        if (AppState.filters.fromDate || AppState.filters.toDate) activeCount++;
        for (const [k, v] of Object.entries(AppState.filters)) {
            if (k === "itemAttributes") {
                for (const attrVals of Object.values(v)) {
                    if (attrVals.length > 0) activeCount++;
                }
            } else if (Array.isArray(v) && v.length > 0) {
                activeCount++;
            }
        }
        if (DOM.activeFilterBadge) {
            DOM.activeFilterBadge.textContent = `${activeCount} active`;
            DOM.activeFilterBadge.className = activeCount > 0 ? "badge bg-primary text-white" : "badge bg-light text-secondary border";
        }
    }

    /**
     * Populate faceted filter options with matching row counts (FT5, FT6, FT7).
     */
    function updateFilterOptions(filterOptions) {
        if (!filterOptions) return;

        const selectIdMap = {
            year: "filterYear",
            month: "filterMonth",
            week: "filterWeek",
            day: "filterDay",
            document: "filterDocument",
            documentType: "filterDocumentType",
            purchaseType: "filterPurchaseType",
            docCurrency: "filterDocCurrency",
            bpName: "filterBPName",
            vendorGroup: "filterVendorGroup",
            industry: "filterIndustry",
            vendorCity: "filterVendorCity",
            vendorState: "filterVendorState",
            vendorCountry: "filterVendorCountry",
            rowBuyer: "filterRowBuyer",
            receivingState: "filterReceivingState",
            receivingCity: "filterReceivingCity",
            itemGroup: "filterItemGroup",
            subGroup1: "filterSubGroup1",
            subGroup2: "filterSubGroup2",
            itemCode: "filterItemCode",
            brand: "filterBrand",
            moc: "filterMOC",
            madeToOrder: "filterMadeToOrder",
            uom: "filterUoM"
        };

        for (const [fKey, elemId] of Object.entries(selectIdMap)) {
            const el = document.getElementById(elemId);
            if (!el || !filterOptions[fKey]) continue;

            const selectedValues = new Set(AppState.filters[fKey] || []);
            const options = filterOptions[fKey];

            // Rebuild option list while preserving user selection
            el.innerHTML = "";
            options.forEach(opt => {
                const optElem = document.createElement("option");
                optElem.value = opt.value;
                optElem.textContent = `${opt.value} (${opt.count.toLocaleString()})`;
                if (selectedValues.has(opt.value)) {
                    optElem.selected = true;
                }
                if (opt.is_stale) {
                    optElem.className = "stale-option";
                }
                el.appendChild(optElem);
            });
        }

        // Section 8: Item Attributes
        if (DOM.itemAttributesContainer && filterOptions.itemAttributes) {
            updateItemAttributeFilters(filterOptions.itemAttributes);
        }
    }

    /**
     * Render dynamic Item Attribute dropdowns (FT1-8).
     */
    function updateItemAttributeFilters(attrsObj) {
        // Build or update individual attribute select elements
        for (const [attrName, options] of Object.entries(attrsObj)) {
            const selectId = `filterAttr_${attrName.replace(/[^a-zA-Z0-9]/g, "_")}`;
            let el = document.getElementById(selectId);

            if (!el) {
                const groupDiv = document.createElement("div");
                groupDiv.className = "filter-group mb-2";

                const label = document.createElement("label");
                label.className = "filter-group-label";
                label.textContent = attrName;
                label.htmlFor = selectId;

                el = document.createElement("select");
                el.id = selectId;
                el.className = "form-select form-select-sm filter-select";
                el.multiple = true;
                el.size = 3;

                el.addEventListener("change", function () {
                    const sel = Array.from(this.selectedOptions).map(o => o.value);
                    if (!AppState.filters.itemAttributes) {
                        AppState.filters.itemAttributes = {};
                    }
                    AppState.filters.itemAttributes[attrName] = sel;
                    executeQuery();
                });

                groupDiv.appendChild(label);
                groupDiv.appendChild(el);
                DOM.itemAttributesContainer.appendChild(groupDiv);
            }

            const currentSelected = new Set((AppState.filters.itemAttributes || {})[attrName] || []);
            el.innerHTML = "";
            options.forEach(opt => {
                const optElem = document.createElement("option");
                optElem.value = opt.value;
                optElem.textContent = `${opt.value} (${opt.count.toLocaleString()})`;
                if (currentSelected.has(opt.value)) {
                    optElem.selected = true;
                }
                if (opt.is_stale) {
                    optElem.className = "stale-option";
                }
                el.appendChild(optElem);
            });
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
                                    return "₹" + Number(val).toLocaleString();
                                }
                                return Number(val).toLocaleString();
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
                                const label = context.dataset.label || "";
                                const val = Number(context.raw).toLocaleString();
                                return AppState.measure === "Spend" ? `${label}: ₹${val}` : `${label}: ${val}`;
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
                                        return "₹" + Number(val).toLocaleString();
                                    }
                                    return Number(val).toLocaleString();
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
                                    const val = Number(context.raw).toLocaleString();
                                    return AppState.measure === "Spend" ? `Spend: ₹${val}` : `${context.dataset.label}: ${val}`;
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
                tr.innerHTML = `
                    <td class="text-muted">${r["#"]}</td>
                    <td class="fw-bold">${r.DocNum}</td>
                    <td><span class="badge bg-${r.Document === 'AP Invoice' ? 'primary' : 'warning text-dark'}">${r.Document}</span></td>
                    <td>${r["Document Type"]}</td>
                    <td>${r["Posting Date"]}</td>
                    <td>${r["Vendors Doc Date"]}</td>
                    <td class="text-truncate" style="max-width: 180px;" title="${r["BP Name"]}">${r["BP Name"]}</td>
                    <td>${r["Item Code"]}</td>
                    <td class="text-end font-monospace">${r.Quantity}</td>
                    <td><span class="badge bg-light text-dark border">${r.UoM || "-"}</span></td>
                    <td class="text-end font-monospace fw-semibold ${String(r["Row Total (After Doc Disc)"]).includes('-') ? 'text-danger' : 'text-dark'}">${r["Row Total (After Doc Disc)"]}</td>
                    <td>${r["Vendors Doc No."]}</td>
                    <td>${r["Row Buyer"]}</td>
                `;
                DOM.detailTableBody.appendChild(tr);
            });
        }

        // Paging status
        if (DOM.tableRowsCountText) {
            DOM.tableRowsCountText.textContent = `Rows ${tData.start_row}–${tData.end_row} of ${tData.total_rows.toLocaleString()}`;
        }
        if (DOM.paginationInfo) {
            DOM.paginationInfo.textContent = `Showing rows ${tData.start_row} to ${tData.end_row} of ${tData.total_rows.toLocaleString()} records`;
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
        loadDataset: loadProcurementDataset
    };

})();
