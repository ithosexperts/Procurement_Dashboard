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
        granularity: "Yearly",   // "Daily" | "Weekly" | "Monthly" | "Yearly"
        measure: "Spend",         // "Spend" | "Quantity"
        dateBasis: "Posting Date", // "Posting Date" | "Vendor's Doc Date"
        breakdownAnalysis: "None", // "None" | "Import vs Domestic" | "Receiving State" | "Item Group" | "Sub Group 1" | "Sub Group 2" | "Brand" | "Buyer" | "Credit vs Advance"

        // Cascading Drill-Down State (Year/FY -> Month -> Week -> Date)
        drilldown: {
            level: "yearly", // "yearly" | "financialYear" | "monthly" | "weekly" | "daily"
            sourceGranularity: "Yearly", // "Yearly" | "Financial Year"
            year: null,
            financialYear: null,
            month: null,
            monthName: null,
            week: null,
            date: null,
            history: []
        },

        // Metadata & Datasets
        isLoaded: false,
        dataAsOf: null,
        totalRecords: 0,

        // Active Filter Selections (FT3, FT4)
        filters: {
            fromDate: null,
            toDate: null,
            financialYear: [],
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

        // Top Vendors editable limit (Req 14)
        topVendorsLimit: 10,
        chartLimits: {
            item_group: 10,
            sub_group1: 10,
            sub_group2: 10,
            brand: 10,
            buyer: 10,
            vendor_group: 10
        },
        latestBreakdowns: null,
        latestMainChart: null,
        currentModalChart: null,

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
        vendorGroup: null,
        topVendorsModal: null,
        universalModal: null
    };

    // Disable default animation for instant rendering & reliable PDF exports
    if (typeof Chart !== "undefined" && Chart.defaults) {
        Chart.defaults.animation = false;
    }

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
         * Dynamic compact notation for quantities / numbers:
         * >= 1,00,00,000 -> X Cr (or -X Cr)
         * >= 1,00,000    -> X Lkh (or -X Lkh)
         * >= 1,000       -> X Thd (or -X Thd)
         * < 1,000        -> X
         */
        formatQuantityCompact(val, precision = 1) {
            if (val === null || val === undefined || isNaN(val)) return "0";
            const num = Number(val);
            if (num === 0) return "0";
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
                unit = " Lkh";
            } else if (abs >= 1000) { // 1 Thousand = 1,000
                const th = abs / 1000;
                formattedNumber = (th % 1 === 0) ? th.toString() : parseFloat(th.toFixed(precision)).toString();
                unit = " Thd";
            } else {
                formattedNumber = (abs % 1 === 0) ? abs.toString() : parseFloat(abs.toFixed(precision)).toString();
                unit = "";
            }

            return sign + formattedNumber + unit;
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

    /**
     * Formats data-as-of timestamp into local device/Indian time format:
     * e.g. 19-11-2026 at 10:46 am
     */
    function formatDataAsOf(isoDate, fallbackStr) {
        if (isoDate) {
            try {
                const d = new Date(isoDate);
                if (!isNaN(d.getTime())) {
                    const day = String(d.getDate()).padStart(2, "0");
                    const month = String(d.getMonth() + 1).padStart(2, "0");
                    const year = d.getFullYear();
                    let hours = d.getHours();
                    const minutes = String(d.getMinutes()).padStart(2, "0");
                    const ampm = hours >= 12 ? "pm" : "am";
                    hours = hours % 12;
                    hours = hours ? hours : 12;
                    const strHours = String(hours).padStart(2, "0");
                    return `${day}-${month}-${year} at ${strHours}:${minutes} ${ampm}`;
                }
            } catch (e) {}
        }
        if (fallbackStr && fallbackStr !== "--") {
            return String(fallbackStr).replace(/^Data as of\s*/i, "");
        }
        return "--";
    }

    /**
     * Chart.js Custom Plugin: Display Values on Bars.
     * Renders clean, readable data values on or beside bars for all breakdown charts and the main period chart.
     */
    const barValueLabelsPlugin = {
        id: "barValueLabels",
        afterDatasetsDraw(chart, args, options) {
            if (options && options.display === false) return;

            // When Granularity is Daily, Weekly, or Monthly on the main period chart,
            // suppress bar value labels to eliminate crowded/chaotic label collisions.
            const isMainChart = chart.canvas && (
                chart.canvas.id === "mainChartCanvas" ||
                (chart.canvas.id === "canvasUniversalModalChart" && AppState.currentModalChart && AppState.currentModalChart.chartKey === "main_chart")
            );
            if (isMainChart && AppState.granularity !== "Yearly" && AppState.granularity !== "Financial Year") {
                return;
            }

            const { ctx, chartArea } = chart;
            if (!chartArea) return;
            const isHorizontal = chart.config.options.indexAxis === "y";
            const measure = (AppState && AppState.measure) ? AppState.measure : "Spend";
            const barDatasets = chart.data.datasets.filter(ds => !ds._isAverageLine && ds.type !== "line");
            const barDatasetsCount = barDatasets.length;

            // ── When more than 3 bar datasets exist (e.g. 5–15 UoMs in unfiltered Quantity mode),
            //    only draw a label for the dataset with the LARGEST value at each position
            //    to prevent chaotic label collisions. For 1 to 3 datasets (e.g. MM & COIL),
            //    draw labels for ALL bars so the user can see every selected UoM!
            let winnerAtIndex = null;
            if (barDatasetsCount > 3) {
                winnerAtIndex = {};
                chart.data.datasets.forEach((ds, dsIdx) => {
                    if (ds._isAverageLine || ds.type === "line") return;
                    const meta = chart.getDatasetMeta(dsIdx);
                    if (!meta || meta.hidden) return;
                    ds.data.forEach((rawVal, idx) => {
                        const num = Number(rawVal);
                        if (isNaN(num) || num === 0) return;
                        const absNum = Math.abs(num);
                        if (!winnerAtIndex[idx] || absNum > winnerAtIndex[idx].abs) {
                            winnerAtIndex[idx] = { dsIdx, abs: absNum, val: num };
                        }
                    });
                });
            }

            // ── Collision tracking: remember positions already occupied by a label to avoid overlap.
            const usedPositions = [];
            const MIN_GAP = 14; // px – minimum clearance between labels

            chart.data.datasets.forEach((dataset, datasetIndex) => {
                if (dataset._isAverageLine || dataset.type === "line") return;
                const meta = chart.getDatasetMeta(datasetIndex);
                if (!meta || meta.hidden) return;

                meta.data.forEach((element, index) => {
                    // Skip if another dataset "won" this index position
                    if (winnerAtIndex && winnerAtIndex[index] &&
                        winnerAtIndex[index].dsIdx !== datasetIndex) {
                        return;
                    }

                    const rawVal = dataset.data[index];
                    if (rawVal === null || rawVal === undefined || isNaN(rawVal)) return;
                    const numVal = Number(rawVal);
                    if (numVal === 0) return;

                    let text = "";
                    if (measure === "Spend") {
                        text = IndianCurrencyFormatter.formatCompact(numVal, 1);
                    } else {
                        text = IndianCurrencyFormatter.formatQuantityCompact(numVal, 1);
                    }

                    // ── Collision check: skip this label if coordinate is too close to an already-drawn label.
                    let collides = false;
                    for (let i = 0; i < usedPositions.length; i++) {
                        if (isHorizontal) {
                            if (Math.abs(usedPositions[i].y - element.y) < MIN_GAP) {
                                collides = true;
                                break;
                            }
                        } else {
                            // In vertical bar charts, only consider collision if both x and y are touching
                            if (Math.abs(usedPositions[i].x - element.x) < 8 && Math.abs(usedPositions[i].y - element.y) < 12) {
                                collides = true;
                                break;
                            }
                        }
                    }
                    if (collides) return;
                    usedPositions.push({ x: element.x, y: element.y });

                    ctx.save();
                    ctx.font = "600 11px 'Plus Jakarta Sans', sans-serif";

                    if (isHorizontal) {
                        const textWidth = ctx.measureText(text).width;
                        const barEnd = element.x;
                        const y = element.y;

                        if (numVal >= 0) {
                            const roomOnRight = chartArea.right - barEnd;
                            const baseline = chart.scales.x.getPixelForValue(0);
                            if (roomOnRight >= textWidth + 8) {
                                ctx.fillStyle = "#334155";
                                ctx.textAlign = "left";
                                ctx.textBaseline = "middle";
                                ctx.fillText(text, barEnd + 6, y);
                            } else if (Math.abs(barEnd - baseline) >= textWidth + 12) {
                                ctx.fillStyle = "#FFFFFF";
                                ctx.textAlign = "right";
                                ctx.textBaseline = "middle";
                                ctx.fillText(text, barEnd - 6, y);
                            } else {
                                ctx.fillStyle = "#334155";
                                ctx.textAlign = "left";
                                ctx.textBaseline = "middle";
                                ctx.fillText(text, barEnd + 4, y);
                            }
                        } else {
                            const roomOnLeft = barEnd - chartArea.left;
                            if (roomOnLeft >= textWidth + 8) {
                                ctx.fillStyle = "#DC2626";
                                ctx.textAlign = "right";
                                ctx.textBaseline = "middle";
                                ctx.fillText(text, barEnd - 6, y);
                            } else {
                                ctx.fillStyle = "#FFFFFF";
                                ctx.textAlign = "left";
                                ctx.textBaseline = "middle";
                                ctx.fillText(text, barEnd + 6, y);
                            }
                        }
                    } else {
                        const barTop = element.y;
                        const x = element.x;

                        if (numVal >= 0) {
                            const roomOnTop = barTop - chartArea.top;
                            if (roomOnTop >= 16) {
                                ctx.fillStyle = "#1E293B";
                                ctx.textAlign = "center";
                                ctx.textBaseline = "bottom";
                                ctx.fillText(text, x, barTop - 4);
                            } else {
                                ctx.fillStyle = "#FFFFFF";
                                ctx.textAlign = "center";
                                ctx.textBaseline = "top";
                                ctx.fillText(text, x, barTop + 4);
                            }
                        } else {
                            const roomOnBottom = chartArea.bottom - barTop;
                            if (roomOnBottom >= 16) {
                                ctx.fillStyle = "#DC2626";
                                ctx.textAlign = "center";
                                ctx.textBaseline = "top";
                                ctx.fillText(text, x, barTop + 4);
                            } else {
                                ctx.fillStyle = "#FFFFFF";
                                ctx.textAlign = "center";
                                ctx.textBaseline = "bottom";
                                ctx.fillText(text, x, barTop - 4);
                            }
                        }
                    }
                    ctx.restore();
                });
            });
        }
    };

    if (typeof Chart !== "undefined") {
        Chart.register(barValueLabelsPlugin);
    }

    // DOM Elements Cache
    const DOM = {
        selectionPromptCard: document.getElementById("selectionPromptCard"),
        dashboardMainContent: document.getElementById("dashboardMainContent"),
        loadingOverlay: document.getElementById("loadingOverlay"),
        loadingText: document.getElementById("loadingText"),
        btnRefreshData: document.getElementById("btnRefreshData"),
        btnResetFilters: document.getElementById("btnResetFilters"),
        btnResetGranularity: document.getElementById("btnResetGranularity"),
        btnExportPdf: document.getElementById("btnExportPdf"),
        btnToggleFilterSidebar: document.getElementById("btnToggleFilterSidebar"),
        textToggleSidebar: document.getElementById("textToggleSidebar"),
        iconToggleSidebar: document.getElementById("iconToggleSidebar"),
        filterSidebarCol: document.getElementById("filterSidebarCol"),
        mainDashboardView: document.getElementById("mainDashboardView"),
        btnToggleAllSections: document.getElementById("btnToggleAllSections"),
        textToggleAll: document.getElementById("textToggleAll"),
        iconToggleAll: document.getElementById("iconToggleAll"),
        selectTopVendorsLimit: document.getElementById("selectTopVendorsLimit"),
        btnToggleExpandTopVendors: document.getElementById("btnToggleExpandTopVendors"),
        btnOpenModalTopVendors: document.getElementById("btnOpenModalTopVendors"),
        modalTopVendors: document.getElementById("modalTopVendors"),
        btnOpenNewTabTopVendors: document.getElementById("btnOpenNewTabTopVendors"),
        iconExpandTopVendors: document.getElementById("iconExpandTopVendors"),
        textExpandTopVendors: document.getElementById("textExpandTopVendors"),
        colTopVendors: document.getElementById("colTopVendors"),
        containerTopVendors: document.getElementById("containerTopVendors"),
        titleTopVendors: document.getElementById("titleTopVendors"),
        subTitleTopVendors: document.getElementById("subTitleTopVendors"),
        dataAsOfText: document.getElementById("dataAsOfText"),
        noDataAlert: document.getElementById("noDataAlert"),
        activeFilterBadge: document.getElementById("activeFilterBadge"),

        // Stage Controls
        granularityRadios: document.querySelectorAll('input[name="granularity"]'),
        measureRadios: document.querySelectorAll('input[name="measure"]'),
        dateBasisRadios: document.querySelectorAll('input[name="dateBasis"]'),
        breakdownAnalysisRadios: document.querySelectorAll('input[name="breakdownAnalysis"]'),
        breakdownAnalysisContainer: document.getElementById("breakdownAnalysisContainer"),
        breakdownDimensionsBadge: document.getElementById("breakdownDimensionsBadge"),
        breakdownResetFilterContainer: document.getElementById("breakdownResetFilterContainer"),

        // Period Filter Subgroups (FT2)
        filterGroupYear: document.getElementById("filterGroupYear"),
        filterGroupMonth: document.getElementById("filterGroupMonth"),
        filterGroupWeek: document.getElementById("filterGroupWeek"),
        filterGroupDay: document.getElementById("filterGroupDay"),
        filterGroupDateRange: document.getElementById("filterGroupDateRange"),

        // Filter Inputs
        filterFromDate: document.getElementById("filterFromDate"),
        filterToDate: document.getElementById("filterToDate"),
        itemAttributesContainer: document.getElementById("itemAttributesContainer"),

        // Detail Table
        detailTableCard: document.getElementById("detailTableCard"),
        detailTableHeader: document.getElementById("detailTableHeader"),
        collapseDetailTable: document.getElementById("collapseDetailTable"),
        btnToggleDetailTable: document.getElementById("btnToggleDetailTable"),
        iconToggleDetailTable: document.getElementById("iconToggleDetailTable"),
        textToggleDetailTable: document.getElementById("textToggleDetailTable"),
        detailTable: document.getElementById("detailTable"),
        detailTableBody: document.getElementById("detailTableBody"),
        tableRowsCountText: document.getElementById("tableRowsCountText"),
        paginationInfo: document.getElementById("paginationInfo"),
        tablePagination: document.getElementById("tablePagination"),

        // KPI elements
        kpiFilteredSpend: document.getElementById("kpiFilteredSpend"),
        kpiFilteredRows: document.getElementById("kpiFilteredRows"),
        kpiActiveSelection: document.getElementById("kpiActiveSelection"),
        mainChartTitle: document.getElementById("mainChartTitle"),
        mainChartSubtitle: document.getElementById("mainChartSubtitle"),
        mainChartCanvas: document.getElementById("mainChartCanvas"),
        chartDrilldownBreadcrumb: document.getElementById("chartDrilldownBreadcrumb"),
        btnChartDrilldownBack: document.getElementById("btnChartDrilldownBack"),
        btnChartDrilldownReset: document.getElementById("btnChartDrilldownReset"),
        mainChartLoading: document.getElementById("mainChartLoading")
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
        updatePeriodFilterVisibility();
        const ready = isFlowReady();
        if (ready) {
            if (DOM.selectionPromptCard) DOM.selectionPromptCard.style.display = "none";
            if (DOM.dashboardMainContent) DOM.dashboardMainContent.style.display = "block";
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

        // Date Range (Calendar) is always visible
        if (DOM.filterGroupDateRange) {
            DOM.filterGroupDateRange.style.display = "block";
        }

        if (!DOM.filterGroupYear) return;

        // Financial Year -> Date Range only (hide Year, Month, Week, Day)
        // Yearly -> Year
        // Monthly -> Year, Month
        // Weekly -> Year, Month, Week
        // Daily -> Year, Month, Week, Day
        DOM.filterGroupYear.style.display = (gran === "Yearly" || gran === "Monthly" || gran === "Weekly" || gran === "Daily") ? "block" : "none";
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
            financialYear: 1, year: 1, month: 1, week: 1, day: 1,
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
                const visibleCheckboxes = Array.from(optionsContainer.querySelectorAll('.multiselect-option-item:not([style*="display: none"]) input[type="checkbox"]:not(:disabled)'));
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
                const isSelected = selectedSet.has(val);
                const isStale = !!opt.is_stale || count === 0;
                // Zero-record options must be frozen/disabled and not selectable (Req 9)
                const isDisabled = (count === 0 && !isSelected);

                const item = document.createElement("label");
                item.className = `multiselect-option-item ${isSelected ? "is-selected" : ""} ${isStale ? "is-stale" : ""} ${isDisabled ? "is-disabled" : ""}`;
                item.dataset.value = val;
                if (isDisabled) {
                    item.setAttribute("title", "No matching records for current filter selection");
                }

                const checkbox = document.createElement("input");
                checkbox.type = "checkbox";
                checkbox.className = "form-check-input";
                checkbox.value = val;
                checkbox.checked = isSelected;
                if (isDisabled) {
                    checkbox.disabled = true;
                }

                checkbox.addEventListener("change", function () {
                    if (this.disabled) return;
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
                    if (isDisabled) optElem.disabled = true;
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
            reset,
            setSelected,
            getSelected
        };
    })();

    /**
     * Interactive Cascading Drill-Down Controller for Main Chart.
     * Implements Year -> Month -> Week -> Date navigation.
     * Synchronizes AppState.filters, visible filter controls, KPI cards, and all breakdown charts.
     */
    const ChartDrillDown = (function () {
        const MONTH_NAMES = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ];
        const MONTH_ABBRS = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun",
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
        ];

        function parseMonthInfo(strOrNum) {
            if (!strOrNum) return { num: 1, name: "January", abbr: "Jan" };
            const s = String(strOrNum).trim();
            const num = parseInt(s, 10);
            if (!isNaN(num) && num >= 1 && num <= 12) {
                return { num: num, name: MONTH_NAMES[num - 1], abbr: MONTH_ABBRS[num - 1] };
            }
            const lower = s.toLowerCase();
            for (let i = 0; i < 12; i++) {
                if (lower.startsWith(MONTH_ABBRS[i].toLowerCase()) || lower.startsWith(MONTH_NAMES[i].toLowerCase())) {
                    return { num: i + 1, name: MONTH_NAMES[i], abbr: MONTH_ABBRS[i] };
                }
            }
            return { num: 1, name: "January", abbr: "Jan" };
        }

        function updateTitleAndSubtitle() {
            if (!DOM.mainChartTitle) return;
            const measure = AppState.measure || "Spend";
            const basis = AppState.dateBasis || "Posting Date";
            const brk = (AppState.breakdownAnalysis && AppState.breakdownAnalysis !== "All" && AppState.breakdownAnalysis !== "None")
                ? ` [${AppState.breakdownAnalysis}]`
                : "";
            const dd = AppState.drilldown;

            if (AppState.granularity === "Financial Year" || dd.level === "financialYear") {
                DOM.mainChartTitle.textContent = `Procurement ${measure} by Period (Financial Year)${brk} – ${basis}`;
                if (DOM.mainChartSubtitle) {
                    DOM.mainChartSubtitle.textContent = "Double-click a bar to drill down (FY → Month → Week → Date)";
                }
                return;
            }

            if (dd.level === "yearly") {
                DOM.mainChartTitle.textContent = `Procurement ${measure} by Period (Yearly)${brk} – ${basis}`;
                if (DOM.mainChartSubtitle) {
                    DOM.mainChartSubtitle.textContent = "Double-click a bar to drill down (Year → Month → Week → Date)";
                }
            } else if (dd.level === "monthly") {
                if (dd.financialYear || dd.year) {
                    const subTitlePrefix = dd.sourceGranularity === "Financial Year" && dd.financialYear ? `FY ${dd.financialYear}` : String(dd.year || '');
                    DOM.mainChartTitle.textContent = `Procurement ${measure} by Period (Monthly)${brk} – ${subTitlePrefix}`;
                    if (DOM.mainChartSubtitle) {
                        DOM.mainChartSubtitle.textContent = "Double-click a month to view weekly breakdown";
                    }
                } else {
                    DOM.mainChartTitle.textContent = `Procurement ${measure} by Period (Monthly)${brk} – ${basis}`;
                    if (DOM.mainChartSubtitle) {
                        DOM.mainChartSubtitle.textContent = "Monthly breakdown across selected period";
                    }
                }
            } else if (dd.level === "weekly") {
                if (dd.year || dd.monthName) {
                    DOM.mainChartTitle.textContent = `Procurement ${measure} by Period (Weekly)${brk} – ${dd.monthName || 'Month'} ${dd.year || ''}`;
                    if (DOM.mainChartSubtitle) {
                        DOM.mainChartSubtitle.textContent = "Double-click a week to view daily breakdown";
                    }
                } else {
                    DOM.mainChartTitle.textContent = `Procurement ${measure} by Period (Weekly)${brk} – ${basis}`;
                    if (DOM.mainChartSubtitle) {
                        DOM.mainChartSubtitle.textContent = "Weekly breakdown across selected period";
                    }
                }
            } else if (dd.level === "daily") {
                if (dd.date) {
                    const dateObj = new Date(dd.date);
                    const dateFmt = !isNaN(dateObj) ? `${String(dateObj.getDate()).padStart(2, '0')} ${MONTH_NAMES[dateObj.getMonth()]} ${dateObj.getFullYear()}` : dd.date;
                    DOM.mainChartTitle.textContent = `Procurement ${measure} by Period (Daily)${brk} – ${dateFmt}`;
                    if (DOM.mainChartSubtitle) {
                        DOM.mainChartSubtitle.textContent = "Single date filter applied across entire dashboard";
                    }
                } else if (dd.week) {
                    DOM.mainChartTitle.textContent = `Procurement ${measure} by Period (Daily)${brk} – Week ${dd.week.week_num}, ${dd.monthName || ''} ${dd.year}`;
                    if (DOM.mainChartSubtitle) {
                        DOM.mainChartSubtitle.textContent = "Double-click a date to apply single-date filter";
                    }
                } else {
                    DOM.mainChartTitle.textContent = `Procurement ${measure} by Period (Daily)${brk} – ${basis}`;
                    if (DOM.mainChartSubtitle) {
                        DOM.mainChartSubtitle.textContent = "Double-click a date to apply single-date filter";
                    }
                }
            }
        }

        function renderBreadcrumbs() {
            if (!DOM.chartDrilldownBreadcrumb) return;
            const dd = AppState.drilldown;
            const ol = DOM.chartDrilldownBreadcrumb;
            ol.innerHTML = "";

            const createItem = (text, level, isLast, clickData = {}) => {
                const li = document.createElement("li");
                li.className = `breadcrumb-item ${isLast ? 'active fw-bold text-dark' : ''}`;
                if (isLast) {
                    li.setAttribute("aria-current", "page");
                    li.textContent = text;
                } else {
                    const a = document.createElement("a");
                    a.href = "#";
                    a.dataset.level = level;
                    Object.entries(clickData).forEach(([k, v]) => { a.dataset[k] = v; });
                    a.textContent = text;
                    a.addEventListener("click", function (e) {
                        e.preventDefault();
                        navigateBreadcrumb(level, clickData);
                    });
                    li.appendChild(a);
                }
                return li;
            };

            const isFY = (dd.sourceGranularity === "Financial Year" || AppState.granularity === "Financial Year");

            // Level 1: Financial Year or Yearly
            if (isFY && (dd.level === "financialYear" || (AppState.granularity === "Financial Year" && dd.level !== "monthly" && dd.level !== "weekly" && dd.level !== "daily"))) {
                ol.appendChild(createItem("Financial Year", "financialYear", true));
                if (DOM.btnChartDrilldownBack) DOM.btnChartDrilldownBack.classList.add("d-none");
                if (DOM.btnChartDrilldownReset) DOM.btnChartDrilldownReset.classList.add("d-none");
                return;
            }

            if (!isFY && dd.level === "yearly") {
                ol.appendChild(createItem("Yearly", "yearly", true));
                if (DOM.btnChartDrilldownBack) DOM.btnChartDrilldownBack.classList.add("d-none");
                if (DOM.btnChartDrilldownReset) DOM.btnChartDrilldownReset.classList.add("d-none");
                return;
            }

            if (!dd.year && !dd.financialYear && (dd.level === "monthly" || dd.level === "weekly" || dd.level === "daily")) {
                const labelMap = { monthly: "Monthly", weekly: "Weekly", daily: "Daily" };
                ol.appendChild(createItem(labelMap[dd.level] || AppState.granularity, dd.level, true));
                if (DOM.btnChartDrilldownBack) DOM.btnChartDrilldownBack.classList.add("d-none");
                if (DOM.btnChartDrilldownReset) DOM.btnChartDrilldownReset.classList.add("d-none");
                return;
            }

            // Deeper level: show Back and Reset
            if (DOM.btnChartDrilldownBack) DOM.btnChartDrilldownBack.classList.remove("d-none");
            if (DOM.btnChartDrilldownReset) DOM.btnChartDrilldownReset.classList.remove("d-none");

            if (isFY) {
                ol.appendChild(createItem("Financial Year", "financialYear", false));
                if (dd.level === "monthly") {
                    ol.appendChild(createItem(`FY ${dd.financialYear}`, "monthly", true));
                    return;
                }
                ol.appendChild(createItem(`FY ${dd.financialYear}`, "financialYearMonthly", false, { financialYear: dd.financialYear }));
            } else {
                ol.appendChild(createItem("Yearly", "yearly", false));
                if (dd.level === "monthly") {
                    ol.appendChild(createItem(String(dd.year), "monthly", true));
                    return;
                }
                ol.appendChild(createItem(String(dd.year), "monthly", false, { year: dd.year }));
            }

            // Level 3: Month
            const monthLabel = dd.monthName || "Month";
            if (dd.level === "weekly") {
                ol.appendChild(createItem(monthLabel, "weekly", true));
                return;
            }
            ol.appendChild(createItem(monthLabel, "weekly", false, { year: dd.year, month: dd.month, monthName: dd.monthName }));

            // Level 4: Week
            const weekLabel = dd.week ? `Week ${dd.week.week_num}` : "Week";
            if (dd.level === "daily" && !dd.date) {
                ol.appendChild(createItem(weekLabel, "daily", true));
                return;
            }
            ol.appendChild(createItem(weekLabel, "daily", false, {
                year: dd.year,
                month: dd.month,
                monthName: dd.monthName,
                week: JSON.stringify(dd.week)
            }));

            // Level 4 Terminal: Date
            if (dd.level === "daily" && dd.date) {
                const dateObj = new Date(dd.date);
                const dateFmt = !isNaN(dateObj) ? `${String(dateObj.getDate()).padStart(2, '0')} ${MONTH_NAMES[dateObj.getMonth()]}` : dd.date;
                ol.appendChild(createItem(dateFmt, "date", true));
            }
        }

        function navigateBreadcrumb(targetLevel, clickData) {
            if (targetLevel === "yearly" || targetLevel === "financialYear") {
                resetDrillDown();
            } else if (targetLevel === "financialYearMonthly") {
                drillToFinancialYearMonthly(clickData.financialYear || AppState.drilldown.financialYear);
            } else if (targetLevel === "monthly") {
                if (AppState.drilldown.sourceGranularity === "Financial Year") {
                    drillToFinancialYearMonthly(clickData.financialYear || AppState.drilldown.financialYear);
                } else {
                    drillToMonthly(clickData.year || AppState.drilldown.year);
                }
            } else if (targetLevel === "weekly") {
                const yr = clickData.year || AppState.drilldown.year;
                const mo = clickData.month || AppState.drilldown.month;
                const moName = clickData.monthName || AppState.drilldown.monthName;
                drillToWeekly(yr, mo, moName);
            } else if (targetLevel === "daily") {
                const yr = clickData.year || AppState.drilldown.year;
                const mo = clickData.month || AppState.drilldown.month;
                const moName = clickData.monthName || AppState.drilldown.monthName;
                let week = null;
                if (clickData.week) {
                    try { week = typeof clickData.week === "string" ? JSON.parse(clickData.week) : clickData.week; } catch (e) {}
                }
                if (!week) week = AppState.drilldown.week;
                drillToDaily(yr, mo, moName, week);
            }
        }

        function drillToFinancialYearMonthly(fyVal) {
            AppState.drilldown.level = "monthly";
            AppState.drilldown.sourceGranularity = "Financial Year";
            AppState.drilldown.financialYear = String(fyVal);
            AppState.drilldown.year = null;
            AppState.drilldown.month = null;
            AppState.drilldown.monthName = null;
            AppState.drilldown.week = null;
            AppState.drilldown.date = null;

            AppState.filters.financialYear = [String(fyVal)];
            AppState.filters.year = [];
            AppState.filters.month = [];
            AppState.filters.week = [];
            AppState.filters.day = [];
            AppState.filters.fromDate = null;
            AppState.filters.toDate = null;

            AppState.granularity = "Monthly";
            syncControls();
            renderBreadcrumbs();
            updateTitleAndSubtitle();
            executeQuery();
        }

        function drillToMonthly(yearVal) {
            AppState.drilldown.level = "monthly";
            AppState.drilldown.sourceGranularity = "Yearly";
            AppState.drilldown.financialYear = null;
            AppState.drilldown.year = String(yearVal);
            AppState.drilldown.month = null;
            AppState.drilldown.monthName = null;
            AppState.drilldown.week = null;
            AppState.drilldown.date = null;

            AppState.filters.financialYear = [];
            AppState.filters.year = [String(yearVal)];
            AppState.filters.month = [];
            AppState.filters.week = [];
            AppState.filters.day = [];
            AppState.filters.fromDate = null;
            AppState.filters.toDate = null;

            AppState.granularity = "Monthly";
            syncControls();
            renderBreadcrumbs();
            updateTitleAndSubtitle();
            executeQuery();
        }

        function drillToWeekly(yearVal, monthVal, monthName) {
            AppState.drilldown.level = "weekly";
            AppState.drilldown.year = String(yearVal);
            AppState.drilldown.month = monthVal;
            AppState.drilldown.monthName = monthName;
            AppState.drilldown.week = null;
            AppState.drilldown.date = null;

            AppState.filters.year = [String(yearVal)];
            AppState.filters.month = [String(monthVal)];
            AppState.filters.week = [];
            AppState.filters.day = [];
            AppState.filters.fromDate = null;
            AppState.filters.toDate = null;

            AppState.granularity = "Weekly";
            syncControls();
            renderBreadcrumbs();
            updateTitleAndSubtitle();
            executeQuery();
        }

        function drillToDaily(yearVal, monthVal, monthName, weekObj) {
            AppState.drilldown.level = "daily";
            AppState.drilldown.year = String(yearVal);
            AppState.drilldown.month = monthVal;
            AppState.drilldown.monthName = monthName;
            AppState.drilldown.week = weekObj;
            AppState.drilldown.date = null;

            AppState.filters.year = [String(yearVal)];
            AppState.filters.month = [String(monthVal)];
            AppState.filters.week = [];
            AppState.filters.day = [];
            AppState.filters.fromDate = weekObj ? weekObj.start_date : null;
            AppState.filters.toDate = weekObj ? weekObj.end_date : null;

            AppState.granularity = "Daily";
            syncControls();
            renderBreadcrumbs();
            updateTitleAndSubtitle();
            executeQuery();
        }

        function drillToDate(dateStr) {
            AppState.drilldown.level = "daily";
            AppState.drilldown.date = dateStr;

            AppState.filters.fromDate = dateStr;
            AppState.filters.toDate = dateStr;

            AppState.granularity = "Daily";
            syncControls();
            renderBreadcrumbs();
            updateTitleAndSubtitle();
            executeQuery();
        }

        function handleBarDoubleClick(index) {
            if (!ChartInstances.main) return;
            const chart = ChartInstances.main;
            const labels = chart.data.labels;
            if (!labels || index < 0 || index >= labels.length) return;

            const clickedLabel = labels[index];
            const meta = (chart.data.meta && chart.data.meta[index]) || {};
            const dd = AppState.drilldown;

            if (AppState.granularity === "Financial Year" || dd.level === "financialYear") {
                const fy = meta.financialYear || clickedLabel;
                if (fy && fy !== "(Blank)") {
                    drillToFinancialYearMonthly(fy);
                }
                return;
            }

            if (dd.level === "yearly") {
                // Level 1 -> Level 2 (Yearly to Monthly)
                const yr = meta.year || clickedLabel;
                drillToMonthly(yr);
            } else if (dd.level === "monthly") {
                // Level 2 -> Level 3 (Monthly to Weekly)
                const moInfo = meta.month ? { num: meta.month, name: meta.month_name } : parseMonthInfo(clickedLabel);
                const labelYearMatch = String(clickedLabel).match(/(\d{4})$/);
                const yr = meta.year || dd.year || (labelYearMatch ? labelYearMatch[1] : null);
                drillToWeekly(yr, moInfo.num, moInfo.name);
            } else if (dd.level === "weekly") {
                // Level 3 -> Level 4 (Weekly to Daily)
                let weekObj = meta;
                if (!weekObj || !weekObj.start_date) {
                    const yr = dd.year;
                    const mo = dd.month;
                    const match = String(clickedLabel).match(/Week\s*(\d+)/i);
                    const wNum = match ? parseInt(match[1], 10) : (index + 1);
                    weekObj = { week_num: wNum, label: clickedLabel, start_date: `${yr}-${String(mo).padStart(2, '0')}-01`, end_date: `${yr}-${String(mo).padStart(2, '0')}-28` };
                }
                drillToDaily(dd.year, dd.month, dd.monthName, weekObj);
            } else if (dd.level === "daily") {
                // Level 4 -> Terminal Date Selection
                if (dd.date) {
                    return;
                }
                let dateStr = meta.date;
                if (!dateStr) {
                    const dt = new Date(clickedLabel);
                    if (!isNaN(dt)) {
                        dateStr = dt.toISOString().slice(0, 10);
                    } else {
                        dateStr = clickedLabel;
                    }
                }
                drillToDate(dateStr);
            }
        }

        function navigateBack() {
            const dd = AppState.drilldown;
            const isFY = (dd.sourceGranularity === "Financial Year");

            if (dd.level === "daily" && dd.date) {
                // Step back from exact date to week view
                drillToDaily(dd.year, dd.month, dd.monthName, dd.week);
            } else if (dd.level === "daily") {
                // Step back from week daily to monthly weekly
                drillToWeekly(dd.year, dd.month, dd.monthName);
            } else if (dd.level === "weekly") {
                // Step back from weekly to monthly
                if (isFY && dd.financialYear) {
                    drillToFinancialYearMonthly(dd.financialYear);
                } else {
                    drillToMonthly(dd.year);
                }
            } else if (dd.level === "monthly") {
                // Step back from monthly to level 1 (FY or Yearly)
                resetDrillDown();
            }
        }

        function resetDrillDown() {
            const rootGran = (AppState.drilldown && AppState.drilldown.sourceGranularity === "Financial Year") ? "Financial Year" : "Yearly";
            AppState.drilldown = {
                level: rootGran === "Financial Year" ? "financialYear" : "yearly",
                sourceGranularity: rootGran,
                financialYear: null,
                year: null,
                month: null,
                monthName: null,
                week: null,
                date: null,
                history: []
            };

            // Clear only period drill-down filters (preserve unrelated filters like vendor/buyer!)
            AppState.filters.financialYear = [];
            AppState.filters.year = [];
            AppState.filters.month = [];
            AppState.filters.week = [];
            AppState.filters.day = [];
            AppState.filters.fromDate = null;
            AppState.filters.toDate = null;

            AppState.granularity = rootGran;
            syncControls();
            renderBreadcrumbs();
            updateTitleAndSubtitle();
            executeQuery();
        }

        function syncControls() {
            // Sync Granularity Radio
            if (DOM.granularityRadios) {
                DOM.granularityRadios.forEach(radio => {
                    radio.checked = (radio.value === AppState.granularity);
                });
            }

            // Sync Breakdown Analysis Radio
            if (DOM.breakdownAnalysisRadios) {
                DOM.breakdownAnalysisRadios.forEach(radio => {
                    radio.checked = (radio.value === (AppState.breakdownAnalysis || "None"));
                });
            }

            // Sync MultiSelect dropdowns
            MultiSelectManager.setSelected("year", AppState.filters.year);
            MultiSelectManager.refreshUI("year");

            MultiSelectManager.setSelected("month", AppState.filters.month);
            MultiSelectManager.refreshUI("month");

            MultiSelectManager.setSelected("week", AppState.filters.week);
            MultiSelectManager.refreshUI("week");

            // Sync Date inputs
            if (DOM.filterFromDate) DOM.filterFromDate.value = AppState.filters.fromDate || "";
            if (DOM.filterToDate) DOM.filterToDate.value = AppState.filters.toDate || "";
            if (DOM.btnClearDateRange) {
                DOM.btnClearDateRange.style.display = (AppState.filters.fromDate || AppState.filters.toDate) ? "inline" : "none";
            }

            // Sync period visibility
            updatePeriodFilterVisibility();
        }

        return {
            parseMonthInfo,
            updateTitleAndSubtitle,
            renderBreadcrumbs,
            handleBarDoubleClick,
            navigateBack,
            resetDrillDown,
            syncControls,
            drillToMonthly,
            drillToWeekly,
            drillToDaily,
            drillToDate
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
                    if (this.value === "Financial Year") {
                        AppState.drilldown.sourceGranularity = "Financial Year";
                        AppState.drilldown.level = "financialYear";
                        AppState.drilldown.financialYear = null;
                        AppState.drilldown.year = null;
                        AppState.drilldown.month = null;
                        AppState.drilldown.week = null;
                        AppState.drilldown.date = null;
                        AppState.filters.financialYear = [];
                        AppState.filters.year = [];
                        AppState.filters.month = [];
                        AppState.filters.week = [];
                        AppState.filters.day = [];
                    } else if (this.value === "Yearly") {
                        AppState.drilldown.sourceGranularity = "Yearly";
                        AppState.drilldown.level = "yearly";
                        AppState.drilldown.financialYear = null;
                        AppState.drilldown.year = null;
                        AppState.drilldown.month = null;
                        AppState.drilldown.week = null;
                        AppState.drilldown.date = null;
                        AppState.filters.financialYear = [];
                        AppState.filters.year = [];
                        AppState.filters.month = [];
                        AppState.filters.week = [];
                        AppState.filters.day = [];
                    } else if (this.value === "Monthly" || this.value === "Weekly" || this.value === "Daily") {
                        AppState.drilldown.sourceGranularity = this.value;
                        AppState.drilldown.level = this.value.toLowerCase();
                        AppState.drilldown.financialYear = null;
                        AppState.drilldown.year = null;
                        AppState.drilldown.month = null;
                        AppState.drilldown.monthName = null;
                        AppState.drilldown.week = null;
                        AppState.drilldown.date = null;
                    }
                    ChartDrillDown.renderBreadcrumbs();
                    ChartDrillDown.updateTitleAndSubtitle();
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
                    ChartDrillDown.updateTitleAndSubtitle();
                    updateGatingVisibility();
                    updateTopVendorsSubtitle();
                }
            });
        });

        // Date Basis
        DOM.dateBasisRadios.forEach(radio => {
            if (radio.checked) AppState.dateBasis = radio.value;
            radio.addEventListener("change", function () {
                if (this.checked) {
                    AppState.dateBasis = this.value;
                    ChartDrillDown.updateTitleAndSubtitle();
                    updateGatingVisibility();
                }
            });
        });

        // Breakdown Analysis Granularity
        if (DOM.breakdownAnalysisRadios) {
            DOM.breakdownAnalysisRadios.forEach(radio => {
                if (radio.checked) AppState.breakdownAnalysis = radio.value;
                radio.addEventListener("change", function () {
                    if (this.checked) {
                        AppState.breakdownAnalysis = this.value;
                        ChartDrillDown.updateTitleAndSubtitle();
                        updateKpiSelectionText();
                        executeQuery();
                    }
                });
            });
        }

        // Chart Drill-Down Back & Reset Buttons
        if (DOM.btnChartDrilldownBack) {
            DOM.btnChartDrilldownBack.addEventListener("click", function (e) {
                e.preventDefault();
                ChartDrillDown.navigateBack();
            });
        }
        if (DOM.btnChartDrilldownReset) {
            DOM.btnChartDrilldownReset.addEventListener("click", function (e) {
                e.preventDefault();
                ChartDrillDown.resetDrillDown();
            });
        }

        // Canvas Double-Click & Touch Double-Tap for Drill-Down
        const mainCanvas = document.getElementById("mainChartCanvas");
        if (mainCanvas) {
            mainCanvas.addEventListener("dblclick", function (e) {
                if (!ChartInstances.main) return;
                const elements = ChartInstances.main.getElementsAtEventForMode(e, "nearest", { intersect: true }, false);
                if (elements && elements.length > 0) {
                    const idx = elements[0].index;
                    ChartDrillDown.handleBarDoubleClick(idx);
                }
            });

            // Mobile double-tap detection (<350ms between taps on same bar)
            let lastTapTime = 0;
            let lastTapIndex = -1;
            mainCanvas.addEventListener("touchend", function (e) {
                if (!ChartInstances.main) return;
                const now = Date.now();
                const timeDiff = now - lastTapTime;

                if (!e.changedTouches || !e.changedTouches.length) return;
                const touch = e.changedTouches[0];
                const rect = mainCanvas.getBoundingClientRect();
                const x = touch.clientX - rect.left;
                const y = touch.clientY - rect.top;

                const fakeEvent = {
                    type: "click",
                    chart: ChartInstances.main,
                    native: e,
                    x: x,
                    y: y
                };

                const elements = ChartInstances.main.getElementsAtEventForMode(fakeEvent, "nearest", { intersect: true }, false);
                if (!elements || !elements.length) {
                    lastTapTime = 0;
                    lastTapIndex = -1;
                    return;
                }

                const currentIndex = elements[0].index;
                if (timeDiff < 350 && timeDiff > 40 && lastTapIndex === currentIndex) {
                    e.preventDefault();
                    lastTapTime = 0;
                    lastTapIndex = -1;
                    ChartDrillDown.handleBarDoubleClick(currentIndex);
                } else {
                    lastTapTime = now;
                    lastTapIndex = currentIndex;
                }
            }, { passive: false });
        }

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

        // Export PDF (Req 2)
        const btnPdf = document.getElementById("btnExportPdf");
        if (btnPdf) {
            btnPdf.addEventListener("click", function (e) {
                e.preventDefault();
                exportPdf();
            });
        }

        // Collapse / Expand Filter Sidebar (Req 8)
        const btnToggleSidebar = document.getElementById("btnToggleFilterSidebar");
        if (btnToggleSidebar) {
            btnToggleSidebar.addEventListener("click", function (e) {
                e.preventDefault();
                e.stopPropagation();
                toggleFilterSidebar();
            });
        }

        // Collapse / Expand All Filter Sections (Req 8)
        const btnToggleSections = document.getElementById("btnToggleAllSections");
        if (btnToggleSections) {
            btnToggleSections.addEventListener("click", function (e) {
                e.preventDefault();
                e.stopPropagation();
                toggleAllFilterSections();
            });
        }

        // Global delegated click handler as fallback
        document.addEventListener("click", function (e) {
            if (e.target.closest("#btnExportPdf, #btnToggleFilterSidebar, #btnToggleAllSections")) {
                return;
            }

            const expandVendorsTarget = e.target.closest("#btnToggleExpandTopVendors");
            if (expandVendorsTarget && !expandVendorsTarget.hasAttribute("data-handled")) {
                expandVendorsTarget.setAttribute("data-handled", "true");
                setTimeout(() => expandVendorsTarget.removeAttribute("data-handled"), 400);
                toggleExpandTopVendors();
                return;
            }
        });

        function updateTopVendorsSubtitle() {
            if (!DOM.subTitleTopVendors) return;
            const val = AppState.topVendorsLimit !== undefined ? AppState.topVendorsLimit : 10;
            const mText = AppState.measure === "Quantity" ? "Quantity" : "Spend";
            DOM.subTitleTopVendors.textContent = val === 0 ? `Ranked by ${mText}` : `Ranked by ${mText} + Others`;
        }

        // Editable Selection for Number of Top Vendors (Req 14)
        if (DOM.selectTopVendorsLimit) {
            DOM.selectTopVendorsLimit.addEventListener("change", function () {
                const val = parseInt(this.value, 10);
                AppState.topVendorsLimit = isNaN(val) ? 10 : val;
                if (DOM.titleTopVendors) {
                    DOM.titleTopVendors.textContent = val === 0 ? "9. All Vendors" : `9. Top ${val} Vendors`;
                }
                updateTopVendorsSubtitle();
                executeQuery();
            });
        }

        // Breakdown Chart Entity Limits (10, 20, 30, 40, 50, All)
        document.addEventListener("change", function (e) {
            const sel = e.target.closest(".chart-limit-select");
            if (!sel) return;
            const key = sel.getAttribute("data-chart-key");
            const inst = sel.getAttribute("data-inst");
            const canvasId = sel.getAttribute("data-canvas-id");
            const val = parseInt(sel.value, 10) || 0;

            if (!AppState.chartLimits) AppState.chartLimits = {};
            AppState.chartLimits[key] = val;

            if (AppState.latestBreakdowns && AppState.latestBreakdowns[key]) {
                renderSingleBreakdownChart(key, canvasId, inst, AppState.latestBreakdowns[key]);
            }
        });

        // Universal Expand / Collapse for Any Breakdown Chart (CH1 - CH10)
        function toggleExpandChart(btn, e) {
            if (e) {
                if (typeof e.preventDefault === "function") e.preventDefault();
                if (typeof e.stopPropagation === "function") e.stopPropagation();
            }
            if (!btn) return;

            if (btn.hasAttribute("data-busy")) return;
            btn.setAttribute("data-busy", "true");
            setTimeout(() => btn.removeAttribute("data-busy"), 300);

            const col = btn.closest(".chart-col-expandable");
            if (!col) return;

            const instName = btn.getAttribute("data-inst");
            const container = col.querySelector(".chart-container-horizontal");
            const icon = btn.querySelector("i");
            const label = btn.querySelector("span");
            const modalBtn = col.querySelector(".btn-chart-modal");

            const isExpanded = col.classList.contains("col-12") || col.classList.contains("is-expanded");
            if (isExpanded) {
                col.classList.remove("col-12", "is-expanded");
                col.classList.add("col-md-6");
                if (container) container.classList.remove("is-expanded");
                if (icon) icon.className = "bi bi-arrows-angle-expand";
                if (label) label.textContent = "Expand";
                btn.setAttribute("title", "Expand to full width");
                btn.classList.remove("active");

                if (modalBtn) {
                    modalBtn.classList.add("d-none");
                    modalBtn.classList.remove("d-inline-flex");
                }
            } else {
                col.classList.remove("col-md-6");
                col.classList.add("col-12", "is-expanded");
                if (container) container.classList.add("is-expanded");
                if (icon) icon.className = "bi bi-arrows-angle-contract";
                if (label) label.textContent = "Collapse";
                btn.setAttribute("title", "Collapse to half width");
                btn.classList.add("active");

                if (modalBtn) {
                    modalBtn.classList.remove("d-none");
                    modalBtn.classList.add("d-inline-flex");
                }
            }

            if (instName && ChartInstances[instName]) {
                ChartInstances[instName].resize();
            }
            window.dispatchEvent(new Event("resize"));
            setTimeout(() => {
                if (instName && ChartInstances[instName]) {
                    ChartInstances[instName].resize();
                }
                window.dispatchEvent(new Event("resize"));
            }, 260);
        }

        // Backwards compatible wrapper for Top Vendors expand toggle
        function toggleExpandTopVendors(e) {
            const btn = document.getElementById("btnToggleExpandTopVendors") || document.querySelector(".btn-chart-expand[data-inst='topVendors']");
            toggleExpandChart(btn, e);
        }

        // Universal Modal View for Any Chart
        function openUniversalModal(chartKey, inst, title, subtitle, e) {
            if (e) {
                if (typeof e.preventDefault === "function") e.preventDefault();
                if (typeof e.stopPropagation === "function") e.stopPropagation();
            }

            const modalEl = document.getElementById("modalUniversalChart");
            if (!modalEl) return;

            AppState.currentModalChart = {
                chartKey: chartKey || "top_vendors",
                inst: inst || "topVendors",
                title: title || "Chart View",
                subtitle: subtitle || ""
            };

            const modalTitle = document.getElementById("modalUniversalChartTitle");
            const modalSubtitle = document.getElementById("modalUniversalChartSubtitle");
            if (modalTitle) modalTitle.textContent = title || "Chart View";
            if (modalSubtitle) modalSubtitle.textContent = subtitle || "";

            renderUniversalModalChart();

            const bsModal = bootstrap.Modal.getOrCreateInstance(modalEl);
            bsModal.show();
        }

        // Backwards compatible wrapper for Top Vendors modal
        function openModalTopVendors(e) {
            const title = (DOM.titleTopVendors ? DOM.titleTopVendors.textContent : "9. Top 50 Vendors");
            const subTitle = (DOM.subTitleTopVendors ? DOM.subTitleTopVendors.textContent : "Ranked by Spend + Others");
            openUniversalModal("top_vendors", "topVendors", title, subTitle, e);
        }

        // Render chart inside Universal Modal
        function renderUniversalModalChart() {
            const canvas = document.getElementById("canvasUniversalModalChart");
            if (!canvas || !AppState.currentModalChart) return;

            const { chartKey, title } = AppState.currentModalChart;

            if (ChartInstances.universalModal) {
                ChartInstances.universalModal.destroy();
                ChartInstances.universalModal = null;
            }

            if (chartKey === "main_chart") {
                const cData = AppState.latestMainChart;
                if (!cData) return;

                const wrapper = document.getElementById("wrapperUniversalModalChart");
                if (wrapper) wrapper.style.height = "520px";
                canvas.style.height = "520px";

                const barDatasets = (cData && cData.datasets)
                    ? cData.datasets.filter(ds => !ds._isAverageLine && ds.type !== "line")
                    : [];
                const isBreakdownActive = !!(AppState.breakdownAnalysis && AppState.breakdownAnalysis !== "All" && AppState.breakdownAnalysis !== "None");
        const isDualAxis = (AppState.measure === "Quantity" && !isBreakdownActive && barDatasets.length === 2);

                if (cData && cData.datasets) {
                    cData.datasets.forEach(ds => {
                        if (!ds._isAverageLine && ds.type !== "line") {
                            ds.minBarLength = isBreakdownActive ? 4 : 8;
                            if (ds.backgroundColor && ds.backgroundColor !== "#0F3B6C") {
                                ds.hoverBackgroundColor = ds.backgroundColor;
                                ds.hoverBorderColor = ds.borderColor || ds.backgroundColor;
                            } else {
                                ds.hoverBackgroundColor = "#165BAA";
                                ds.hoverBorderColor = "#0F3B6C";
                            }
                        }
                    });
                }

                if (isDualAxis) {
                    barDatasets[0].yAxisID = "y";
                    barDatasets[1].yAxisID = "y1";
                } else {
                    barDatasets.forEach(ds => { ds.yAxisID = "y"; });
                }

                // Inject Dynamic Average Benchmark Line
                addMainChartAverageLine(cData);

                const ctx = canvas.getContext("2d");
                ChartInstances.universalModal = new Chart(ctx, {
                    type: "bar",
                    data: cData,
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            x: {
                                stacked: false,
                                grid: {
                                    display: true,
                                    color: "#E2E8F0",
                                    lineWidth: 1,
                                    drawTicks: true
                                },
                                ticks: {
                                    color: "#475569",
                                    font: { family: "'Plus Jakarta Sans', sans-serif", size: 12, weight: "600" }
                                }
                            },
                            y: {
                                stacked: false,
                                type: "linear",
                                position: "left",
                                beginAtZero: true,
                                grace: "10%",
                                grid: {
                                    display: true,
                                    color: "#CBD5E1",
                                    lineWidth: 1.2
                                },
                                title: isDualAxis ? {
                                    display: true,
                                    text: barDatasets[0].label || "Quantity",
                                    color: barDatasets[0].backgroundColor || "#0f766e",
                                    font: { family: "'Plus Jakarta Sans', sans-serif", size: 12, weight: "bold" }
                                } : { display: false },
                                ticks: {
                                    color: isDualAxis ? (barDatasets[0].backgroundColor || "#0f766e") : "#1E293B",
                                    font: { family: "'Plus Jakarta Sans', sans-serif", size: 12, weight: "600" },
                                    callback: function (val) {
                                        if (AppState.measure === "Spend") {
                                            return IndianCurrencyFormatter.formatCompact(val);
                                        }
                                        return IndianCurrencyFormatter.formatQuantityCompact(val);
                                    }
                                }
                            },
                            ...(isDualAxis ? {
                                y1: {
                                    type: "linear",
                                    position: "right",
                                    beginAtZero: true,
                                    grace: "10%",
                                    grid: {
                                        drawOnChartArea: false
                                    },
                                    title: {
                                        display: true,
                                        text: barDatasets[1].label || "Quantity",
                                        color: barDatasets[1].backgroundColor || "#2563eb",
                                        font: { family: "'Plus Jakarta Sans', sans-serif", size: 12, weight: "bold" }
                                    },
                                    ticks: {
                                        color: barDatasets[1].backgroundColor || "#2563eb",
                                        font: { family: "'Plus Jakarta Sans', sans-serif", size: 12, weight: "600" },
                                        callback: function (val) {
                                            return IndianCurrencyFormatter.formatQuantityCompact(val);
                                        }
                                    }
                                }
                            } : {})
                        },
                        plugins: {
                            legend: {
                                display: true,
                                position: "top",
                                align: "end",
                                labels: {
                                    boxWidth: 16,
                                    boxHeight: 10,
                                    font: { family: "'Plus Jakarta Sans', sans-serif", size: 12, weight: "600" },
                                    color: "#334155",
                                    padding: 12,
                                    generateLabels: function (chart) {
                                        const orig = Chart.defaults.plugins.legend.labels.generateLabels(chart);
                                        return orig.map(item => {
                                            const ds = chart.data.datasets[item.datasetIndex];
                                            if (ds && ds._isAverageLine) {
                                                item.lineDash = [6, 4];
                                                item.strokeStyle = ds.borderColor;
                                                item.lineWidth = 2.5;
                                            }
                                            return item;
                                        });
                                    }
                                }
                            },
                            barValueLabels: { display: AppState.granularity === "Yearly" || AppState.granularity === "Financial Year" },
                            tooltip: {
                                backgroundColor: "#0A2540",
                                titleFont: { family: "'Plus Jakarta Sans', sans-serif", size: 13, weight: "bold" },
                                bodyFont: { family: "'Plus Jakarta Sans', sans-serif", size: 12 },
                                cornerRadius: 6,
                                padding: 12,
                                callbacks: {
                                    label: function (context) {
                                        const rawVal = context.raw;
                                        if (context.dataset && context.dataset._isAverageLine) {
                                            if (AppState.measure === "Spend") {
                                                return [
                                                    `★ ${context.dataset.label}`,
                                                    `Exact Average: ${IndianCurrencyFormatter.formatExact(rawVal)}`
                                                ];
                                            }
                                            const num = Number(rawVal);
                                            const compactQty = IndianCurrencyFormatter.formatQuantityCompact(rawVal, 2);
                                            const formattedQty = num.toLocaleString("en-IN", {
                                                minimumFractionDigits: 0,
                                                maximumFractionDigits: 2
                                            });
                                            return [
                                                `★ ${context.dataset.label}`,
                                                `Exact Average Qty: ${formattedQty}`
                                            ];
                                        }
                                        if (AppState.measure === "Spend") {
                                            const compact = IndianCurrencyFormatter.formatCompact(rawVal, 2);
                                            const exact = IndianCurrencyFormatter.formatExact(rawVal);
                                            return [compact, `Exact Value: ${exact}`];
                                        }
                                        const num = Number(rawVal);
                                        const compactQty = IndianCurrencyFormatter.formatQuantityCompact(rawVal, 2);
                                        const formattedQty = num.toLocaleString("en-IN", {
                                            minimumFractionDigits: 0,
                                            maximumFractionDigits: 2
                                        });
                                        const uom = context.dataset.label ? `${context.dataset.label}: ` : "Quantity: ";
                                        return [
                                            `${uom}${compactQty}`,
                                            `Exact Qty: ${formattedQty}`
                                        ];
                                    }
                                }
                            }
                        }
                    }
                });
            } else {
                let rawData = AppState.latestBreakdowns ? AppState.latestBreakdowns[chartKey] : null;
                if (!rawData) return;

                const limit = AppState.chartLimits && AppState.chartLimits[chartKey] ? AppState.chartLimits[chartKey] : 0;
                const cData = sliceChartData(rawData, limit);

                const numItems = cData.labels ? cData.labels.length : 0;
                const barHeight = Math.max(340, numItems * 32);

                const wrapper = document.getElementById("wrapperUniversalModalChart");
                if (wrapper) wrapper.style.height = `${barHeight}px`;
                canvas.style.height = `${barHeight}px`;

                const ctx = canvas.getContext("2d");
                ChartInstances.universalModal = new Chart(ctx, {
                    type: "bar",
                    data: cData,
                    options: {
                        indexAxis: "y",
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            x: {
                                beginAtZero: true,
                                grace: "12%",
                                grid: { color: "#F1F5F9" },
                                ticks: {
                                    color: "#64748B",
                                    font: { family: "'Plus Jakarta Sans', sans-serif", size: 12 },
                                    callback: function (val) {
                                        if (AppState.measure === "Spend") {
                                            return IndianCurrencyFormatter.formatCompact(val);
                                        }
                                        return IndianCurrencyFormatter.formatQuantityCompact(val);
                                    }
                                }
                            },
                            y: {
                                grid: { display: false },
                                ticks: {
                                    autoSkip: false,
                                    color: "#1E293B",
                                    font: { family: "'Plus Jakarta Sans', sans-serif", size: 12, weight: "500" },
                                    padding: 10
                                }
                            }
                        },
                        plugins: {
                            legend: { display: AppState.measure === "Quantity" },
                            barValueLabels: { display: AppState.granularity === "Yearly" || AppState.granularity === "Financial Year" },
                            tooltip: {
                                backgroundColor: "#0A2540",
                                titleFont: { family: "'Plus Jakarta Sans', sans-serif", size: 13, weight: "bold" },
                                bodyFont: { family: "'Plus Jakarta Sans', sans-serif", size: 12 },
                                cornerRadius: 6,
                                padding: 12,
                                callbacks: {
                                    label: function (context) {
                                        const rawVal = context.raw;
                                        if (AppState.measure === "Spend") {
                                            const compact = IndianCurrencyFormatter.formatCompact(rawVal, 2);
                                            const exact = IndianCurrencyFormatter.formatExact(rawVal);
                                            return [compact, `Exact Value: ${exact}`];
                                        }
                                        const num = Number(rawVal);
                                        const compactQty = IndianCurrencyFormatter.formatQuantityCompact(rawVal, 2);
                                        const formattedQty = num.toLocaleString("en-IN", {
                                            minimumFractionDigits: 0,
                                            maximumFractionDigits: 2
                                        });
                                        const label = context.dataset.label || "Quantity";
                                        return [
                                            `${label}: ${compactQty}`,
                                            `Exact Qty: ${formattedQty}`
                                        ];
                                    }
                                }
                            }
                        }
                    }
                });
            }

            setTimeout(() => {
                if (ChartInstances.universalModal) {
                    ChartInstances.universalModal.resize();
                }
            }, 180);
        }

        // Open in New Tab with URL masked / untouched (about:blank with written document)
        function openCurrentModalChartInNewTab(e) {
            if (e) {
                if (typeof e.preventDefault === "function") e.preventDefault();
                if (typeof e.stopPropagation === "function") e.stopPropagation();
            }

            const canvas = document.getElementById("canvasUniversalModalChart") || document.getElementById("chartTopVendorsModal");
            const current = AppState.currentModalChart || {
                chartKey: "top_vendors",
                inst: "topVendors",
                title: "Chart View",
                subtitle: ""
            };

            let chartData = null;
            if (current.chartKey === "main_chart") {
                chartData = AppState.latestMainChart;
            } else if (AppState.latestBreakdowns) {
                chartData = AppState.latestBreakdowns[current.chartKey];
            }

            const title = current.title || (DOM.titleTopVendors ? DOM.titleTopVendors.textContent : "Procurement Chart");
            const subTitle = current.subtitle || (DOM.subTitleTopVendors ? DOM.subTitleTopVendors.textContent : "");
            const dateAsOf = (DOM.dataAsOfText ? DOM.dataAsOfText.textContent : "Data as of Latest");
            const measure = AppState.measure || "Spend";
            const dateBasis = AppState.dateBasis || "Posting Date";
            const gran = AppState.granularity || "Monthly";

            // Safely snapshot the chart canvas
            let imgData = "";
            try {
                if (canvas && typeof canvas.toDataURL === "function") {
                    imgData = canvas.toDataURL("image/png");
                }
            } catch (canvasErr) {
                console.warn("Could not export canvas to image:", canvasErr);
            }

            let tableRowsHtml = "";
            if (chartData && chartData.labels && chartData.datasets && chartData.datasets[0]) {
                const labels = chartData.labels;
                const vals = chartData.datasets[0].data || [];
                const total = vals.reduce((a, b) => a + Number(b || 0), 0);
                labels.forEach((label, idx) => {
                    const val = Number(vals[idx] || 0);
                    const pct = total > 0 ? ((val / total) * 100).toFixed(1) + "%" : "0.0%";
                    const formattedVal = measure === "Spend"
                        ? IndianCurrencyFormatter.formatExact(val)
                        : val.toLocaleString("en-IN");
                    tableRowsHtml += `
                        <tr>
                            <td style="padding: 10px 14px; border-bottom: 1px solid #E2E8F0; color: #64748B; font-size: 13px;">${idx + 1}</td>
                            <td style="padding: 10px 14px; border-bottom: 1px solid #E2E8F0; font-weight: 600; color: #0F172A; font-size: 13px;">${label}</td>
                            <td style="padding: 10px 14px; border-bottom: 1px solid #E2E8F0; text-align: right; font-weight: 600; color: #165BAA; font-size: 13px;">${formattedVal}</td>
                            <td style="padding: 10px 14px; border-bottom: 1px solid #E2E8F0; text-align: right; color: #64748B; font-size: 13px;">${pct}</td>
                        </tr>
                    `;
                });
            }

            const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - HoseXperts Procurement Analytics</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: #F6F8FB;
            color: #1E293B;
            padding: 24px;
            -webkit-font-smoothing: antialiased;
        }
        .container {
            max-width: 1280px;
            margin: 0 auto;
        }
        .header-card {
            background: #FFFFFF;
            border: 1px solid #E2E8F0;
            border-radius: 12px;
            padding: 20px 24px;
            box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 16px;
            margin-bottom: 20px;
        }
        .title-area h1 {
            font-size: 20px;
            font-weight: 700;
            color: #0A2540;
            margin-bottom: 4px;
        }
        .title-area p {
            font-size: 13px;
            color: #64748B;
            margin: 0;
        }
        .badge {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            background: #EEF4FB;
            color: #165BAA;
            border: 1px solid #C9DCF2;
        }
        .btn-group {
            display: flex;
            gap: 8px;
        }
        .btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            border: 1px solid #CBD5E1;
            background: #FFFFFF;
            color: #334155;
            transition: all 0.15s ease-in-out;
            text-decoration: none;
        }
        .btn:hover {
            background: #F8FAFC;
            border-color: #94A3B8;
        }
        .btn-primary {
            background: #0F3B6C;
            border-color: #0F3B6C;
            color: #FFFFFF;
        }
        .btn-primary:hover {
            background: #0A2540;
        }
        .card {
            background: #FFFFFF;
            border: 1px solid #E2E8F0;
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
            margin-bottom: 20px;
        }
        .chart-img {
            width: 100%;
            height: auto;
            display: block;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            text-align: left;
        }
        th {
            background: #09264A;
            color: #FFFFFF;
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            padding: 11px 14px;
        }
        @media print {
            body { background: #FFFFFF; padding: 0; }
            .btn-group { display: none; }
            .card, .header-card { box-shadow: none; border-color: #CBD5E1; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header-card">
            <div class="title-area">
                <h1>${title}</h1>
                <p>${subTitle} &bull; HoseXperts Procurement Analytics</p>
                <div style="margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap;">
                    <span class="badge">${measure}</span>
                    <span class="badge">${dateBasis}</span>
                    <span class="badge">${gran}</span>
                    <span class="badge" style="background: #F1F5F9; color: #475569; border-color: #E2E8F0;">${dateAsOf}</span>
                </div>
            </div>
            <div class="btn-group">
                <button class="btn btn-primary" onclick="window.print()">Print / Save PDF</button>
                <button class="btn" onclick="window.close()">Close Tab</button>
            </div>
        </div>

        <div class="card">
            <h2 style="font-size: 15px; font-weight: 700; color: #0A2540; margin-bottom: 16px;">Visual Spend Breakdown</h2>
            <img class="chart-img" src="${imgData}" alt="${title}">
        </div>

        <div class="card">
            <h2 style="font-size: 15px; font-weight: 700; color: #0A2540; margin-bottom: 16px;">Detailed Ranking Table</h2>
            <div style="overflow-x: auto;">
                <table>
                    <thead>
                        <tr>
                            <th style="width: 60px;">#</th>
                            <th>Dimension Item</th>
                            <th style="text-align: right;">Total ${measure}</th>
                            <th style="text-align: right; width: 100px;">% Share</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRowsHtml}
                    </tbody>
                </table>
            </div>
        </div>
    </div>
</body>
</html>`;

            // MULTI-TIER NEW TAB OPENER (Ensures zero URL leakage & 100% reliability)
            // Strategy 1: Modern in-memory Blob URL via dynamically clicked anchor tag.
            // - Immune to popup blockers (anchor clicks with target="_blank" are treated as user navigation).
            // - Completely client-side: never makes a backend network request, preserving portal security.
            // - Does NOT expose internal application server ports, IPs, or private endpoints.
            // - Works seamlessly inside sandboxed iframes without cross-origin frame access exceptions.
            let openedSuccessfully = false;

            try {
                const blob = new Blob([html], { type: "text/html;charset=utf-8" });
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = blobUrl;
                a.target = "_blank";
                a.rel = "noopener noreferrer";
                a.style.display = "none";
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    if (a.parentNode) a.parentNode.removeChild(a);
                    setTimeout(() => {
                        try { URL.revokeObjectURL(blobUrl); } catch (e) {}
                    }, 120000);
                }, 200);
                openedSuccessfully = true;
            } catch (blobErr) {
                console.warn("Anchor Blob navigation failed, attempting direct window.open fallback:", blobErr);
            }

            // Strategy 2: Direct window.open with document.write fallback (for restricted legacy browsers)
            if (!openedSuccessfully) {
                try {
                    const newTab = window.open("", "_blank");
                    if (newTab && newTab.document) {
                        newTab.document.open();
                        newTab.document.write(html);
                        newTab.document.close();
                        openedSuccessfully = true;
                    }
                } catch (winErr) {
                    console.warn("Direct window.open document.write failed:", winErr);
                }
            }

            if (!openedSuccessfully) {
                alert("Please enable popups or allow opening new tabs in your browser to view the chart in a new tab.");
            }
        }

        // Backwards compatible wrapper for Top Vendors New Tab
        function openTopVendorsInNewTab(e) {
            openCurrentModalChartInNewTab(e);
        }

        // Delegated click handlers for expand, modal, and open in new tab buttons
        document.addEventListener("click", function (e) {
            const newTabBtn = e.target.closest("#btnUniversalModalOpenNewTab, .btn-chart-modal-newtab, #btnOpenNewTabTopVendors");
            if (newTabBtn) {
                openCurrentModalChartInNewTab(e);
                return;
            }

            const expandBtn = e.target.closest(".btn-chart-expand");
            if (expandBtn) {
                toggleExpandChart(expandBtn, e);
                return;
            }

            const modalBtn = e.target.closest(".btn-chart-modal");
            if (modalBtn) {
                const chartKey = modalBtn.getAttribute("data-chart-key") || "top_vendors";
                const inst = modalBtn.getAttribute("data-inst") || "topVendors";
                const title = modalBtn.getAttribute("data-title") || "Chart View";
                const subtitle = modalBtn.getAttribute("data-subtitle") || "";
                openUniversalModal(chartKey, inst, title, subtitle, e);
                return;
            }
        });

        // Direct click listener on universal modal new tab button
        if (DOM.btnUniversalModalOpenNewTab) {
            DOM.btnUniversalModalOpenNewTab.addEventListener("click", function (e) {
                openCurrentModalChartInNewTab(e);
            });
        }

        const modalUniversalEl = document.getElementById("modalUniversalChart");
        if (modalUniversalEl) {
            modalUniversalEl.addEventListener("shown.bs.modal", function () {
                if (ChartInstances.universalModal) {
                    ChartInstances.universalModal.resize();
                }
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

        // Detail Table Collapse / Expand Controller
        initDetailTableCollapse();
    }

    /**
     * Detail Table Collapse/Expand Controller.
     * Default state is collapsed; toggling changes icon, button label, and expands/collapses the table.
     */
    function updateTableCollapseState(isExpanded) {
        const iconToggle = document.getElementById("iconToggleDetailTable");
        const textToggle = document.getElementById("textToggleDetailTable");
        const btnToggle = document.getElementById("btnToggleDetailTable");
        const cardEl = document.getElementById("detailTableCard");

        if (iconToggle) {
            iconToggle.className = isExpanded ? "bi bi-chevron-up" : "bi bi-chevron-down";
        }
        if (textToggle) {
            textToggle.textContent = isExpanded ? "Collapse" : "Expand";
        }
        if (btnToggle) {
            btnToggle.setAttribute("aria-expanded", isExpanded ? "true" : "false");
            btnToggle.title = isExpanded ? "Collapse Table" : "Expand Table";
            if (isExpanded) {
                btnToggle.classList.add("table-expanded");
            } else {
                btnToggle.classList.remove("table-expanded");
            }
        }
        if (cardEl) {
            if (isExpanded) {
                cardEl.classList.remove("is-table-collapsed");
            } else {
                cardEl.classList.add("is-table-collapsed");
            }
        }
    }

    function toggleDetailTableCollapse() {
        const collapseEl = document.getElementById("collapseDetailTable");
        if (!collapseEl) return;

        if (window.bootstrap && window.bootstrap.Collapse) {
            const bsCollapse = bootstrap.Collapse.getOrCreateInstance(collapseEl, { toggle: false });
            bsCollapse.toggle();
        } else {
            const isShown = collapseEl.classList.contains("show");
            if (isShown) {
                collapseEl.classList.remove("show");
                updateTableCollapseState(false);
            } else {
                collapseEl.classList.add("show");
                updateTableCollapseState(true);
            }
        }
    }

    function initDetailTableCollapse() {
        const collapseEl = document.getElementById("collapseDetailTable");
        const btnToggle = document.getElementById("btnToggleDetailTable");
        const headerEl = document.getElementById("detailTableHeader");

        if (btnToggle) {
            btnToggle.addEventListener("click", function (e) {
                e.preventDefault();
                e.stopPropagation();
                toggleDetailTableCollapse();
            });
        }

        if (headerEl) {
            headerEl.addEventListener("click", function (e) {
                // If user clicked inside the button or a badge, avoid double toggle
                if (e.target.closest("#btnToggleDetailTable")) return;
                toggleDetailTableCollapse();
            });
        }

        if (collapseEl) {
            collapseEl.addEventListener("show.bs.collapse", function () {
                updateTableCollapseState(true);
            });
            collapseEl.addEventListener("shown.bs.collapse", function () {
                updateTableCollapseState(true);
            });
            collapseEl.addEventListener("hide.bs.collapse", function () {
                updateTableCollapseState(false);
            });
            collapseEl.addEventListener("hidden.bs.collapse", function () {
                updateTableCollapseState(false);
            });
        }
    }

    /**
     * Collapse or Expand the left Filter Sidebar (Req 8).
     * When hidden, charts view expands to 100% full width (col-12).
     */
    let _lastToggleSidebarTime = 0;
    function toggleFilterSidebar() {
        const now = Date.now();
        if (now - _lastToggleSidebarTime < 250) {
            return;
        }
        _lastToggleSidebarTime = now;

        const sidebar = document.getElementById("filterSidebarCol");
        const mainView = document.getElementById("mainDashboardView");
        const toggleBtn = document.getElementById("btnToggleFilterSidebar");
        const toggleText = document.getElementById("textToggleSidebar");
        const toggleIcon = document.getElementById("iconToggleSidebar");

        if (!sidebar) return;

        const isHidden = sidebar.classList.contains("d-none") || sidebar.style.display === "none";

        if (isHidden) {
            sidebar.classList.remove("d-none");
            sidebar.style.display = "";
            if (mainView) {
                mainView.classList.remove("col-12");
                mainView.classList.add("col-xl-9", "col-lg-8");
            }
            if (toggleText) toggleText.textContent = "Hide Filters";
            if (toggleIcon) toggleIcon.className = "bi bi-layout-sidebar-inset";
            if (toggleBtn) {
                toggleBtn.classList.remove("btn-primary");
                toggleBtn.classList.add("btn-outline-secondary");
            }
        } else {
            sidebar.classList.add("d-none");
            sidebar.style.display = "none";
            if (mainView) {
                mainView.classList.remove("col-xl-9", "col-lg-8");
                mainView.classList.add("col-12");
            }
            if (toggleText) toggleText.textContent = "Show Filters";
            if (toggleIcon) toggleIcon.className = "bi bi-layout-sidebar";
            if (toggleBtn) {
                toggleBtn.classList.remove("btn-outline-secondary");
                toggleBtn.classList.add("btn-primary");
            }
        }

        setTimeout(() => {
            window.dispatchEvent(new Event("resize"));
            for (const k in ChartInstances) {
                if (ChartInstances[k]) ChartInstances[k].resize();
            }
        }, 120);
    }

    /**
     * Collapse or Expand all 8 filter accordion sections simultaneously (Req 8).
     */
    let _lastToggleAllSectionsTime = 0;
    function toggleAllFilterSections() {
        const now = Date.now();
        if (now - _lastToggleAllSectionsTime < 250) {
            return;
        }
        _lastToggleAllSectionsTime = now;
        const accordionCollapses = document.querySelectorAll("#filterAccordion .accordion-collapse");
        const anyClosed = Array.from(accordionCollapses).some(el => !el.classList.contains("show"));

        accordionCollapses.forEach(el => {
            if (typeof bootstrap !== "undefined" && bootstrap.Collapse) {
                const bsCollapse = bootstrap.Collapse.getOrCreateInstance(el, { toggle: false });
                if (anyClosed) {
                    bsCollapse.show();
                } else {
                    bsCollapse.hide();
                }
            } else {
                if (anyClosed) {
                    el.classList.add("show");
                } else {
                    el.classList.remove("show");
                }
            }
        });

        const toggleText = document.getElementById("textToggleAll");
        const toggleIcon = document.getElementById("iconToggleAll");
        if (toggleText) toggleText.textContent = anyClosed ? "Collapse All" : "Expand All";
        if (toggleIcon) toggleIcon.className = anyClosed ? "bi bi-arrows-collapse" : "bi bi-arrows-expand";
    }

    /**
     * Export PDF (Req 2): Generates a high-resolution, multi-page executive PDF report containing ONLY
     * the bar graphs and their values, KPI strip, report header, and active filters. Excludes transactional table.
     * Generates a guaranteed 4-page A4 Landscape report using jsPDF and html2canvas, with fallback to html2pdf/window.print.
     */
    async function exportPdf() {
        const granElem = document.getElementById("printReportGranularity");
        if (granElem) {
            const brkStr = (AppState.breakdownAnalysis && AppState.breakdownAnalysis !== "All" && AppState.breakdownAnalysis !== "None") ? ` • ${AppState.breakdownAnalysis}` : "";
            granElem.textContent = `${AppState.granularity || 'All'} • ${AppState.measure || 'Spend'} • ${AppState.dateBasis || 'Posting Date'}${brkStr}`;
        }
        const dateElem = document.getElementById("printReportDate");
        if (dateElem && DOM.dataAsOfText) {
            dateElem.textContent = DOM.dataAsOfText.textContent;
        }

        const btn = document.getElementById("btnExportPdf");
        const originalHtml = btn ? btn.innerHTML : "";

        if (btn) {
            btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status"></span><span>Exporting PDF...</span>`;
            btn.disabled = true;
        }

        // Staging container mounted in DOM with valid positive coordinates (opacity 0, pointer-events none)
        const staging = document.createElement("div");
        staging.id = "pdfStagingContainer";
        staging.style.position = "fixed";
        staging.style.left = "0px";
        staging.style.top = "0px";
        staging.style.opacity = "0";
        staging.style.pointerEvents = "none";
        staging.style.zIndex = "-99999";
        staging.style.width = "1000px";
        document.body.appendChild(staging);

        function cleanup() {
            if (staging.parentNode) {
                staging.parentNode.removeChild(staging);
            }
            if (btn) {
                btn.innerHTML = originalHtml;
                btn.disabled = false;
            }
        }

        try {
            // Helper: Create a single A4 Landscape Page Container (width 1000px)
            function createPageContainer() {
                const page = document.createElement("div");
                page.style.width = "1000px";
                page.style.boxSizing = "border-box";
                page.style.backgroundColor = "#FFFFFF";
                page.style.padding = "16px 20px";
                page.style.fontFamily = "'Plus Jakarta Sans', -apple-system, sans-serif";
                page.style.color = "#0F172A";
                return page;
            }

            // Helper: Running Header for Pages 2, 3, 4
            function createRunningHeader(pageNum, totalPages = 4) {
                const rHead = document.createElement("div");
                rHead.style.display = "flex";
                rHead.style.justifyContent = "space-between";
                rHead.style.alignItems = "center";
                rHead.style.borderBottom = "1.5px solid #0F3B6C";
                rHead.style.paddingBottom = "8px";
                rHead.style.marginBottom = "10px";
                rHead.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 16px; font-weight: 800; color: #0A2540; letter-spacing: -0.02em;">HoseXperts</span>
                        <span style="font-size: 11px; font-weight: 600; color: #0284C7; background: #E0F2FE; padding: 2px 7px; border-radius: 4px;">Procurement Analytics</span>
                        <span style="font-size: 11px; color: #64748B; margin-left: 6px;">Executive Management Report</span>
                    </div>
                    <div style="text-align: right; font-size: 11px; color: #475569; font-weight: 600;">
                        <span>Page ${pageNum} of ${totalPages}</span>
                    </div>
                `;
                return rHead;
            }

            // Helper: Section Banner for Breakdown Dimensions
            function createSectionBanner(text, badgeText) {
                const s = document.createElement("div");
                s.style.display = "flex";
                s.style.justifyContent = "space-between";
                s.style.alignItems = "center";
                s.style.padding = "6px 12px";
                s.style.marginBottom = "10px";
                s.style.borderRadius = "6px";
                s.style.background = "linear-gradient(135deg, #F0F6FC 0%, #E6F0FA 100%)";
                s.style.border = "1px solid #DCE6F1";
                s.style.borderLeft = "4px solid #0F3B6C";
                s.innerHTML = `
                    <div style="font-size: 12.5px; font-weight: 700; color: #0A2540;">
                        ${text} <span style="font-size: 10px; font-weight: 700; background: #FFFFFF; color: #0F3B6C; border: 1px solid #BFDBFE; padding: 2px 7px; border-radius: 4px; margin-left: 6px;">${badgeText}</span>
                    </div>
                    <div style="font-size: 10.5px; color: #475569; font-weight: 500;">Horizontal bars &bull; Ranked largest to smallest</div>
                `;
                return s;
            }

            // Helper: Create a styled Chart Card with guaranteed rendered Image
            function createChartCard(canvasId, instKey, titleText, subtitleText, heightPx = 205) {
                const card = document.createElement("div");
                card.style.flex = "1";
                card.style.width = "calc(50% - 6px)";
                card.style.border = "1px solid #E2E8F0";
                card.style.borderRadius = "8px";
                card.style.backgroundColor = "#FFFFFF";
                card.style.overflow = "hidden";
                card.style.boxShadow = "0 1px 2px rgba(10,37,64,0.04)";
                card.style.display = "flex";
                card.style.flexDirection = "column";

                const head = document.createElement("div");
                head.style.padding = "6px 10px";
                head.style.background = "linear-gradient(135deg, #F0F6FC 0%, #E6F0FA 100%)";
                head.style.borderBottom = "1.5px solid #DCE6F1";
                head.style.borderLeft = "4px solid #0F3B6C";

                const title = document.createElement("div");
                title.style.fontSize = "12px";
                title.style.fontWeight = "700";
                title.style.color = "#0A2540";
                title.style.letterSpacing = "-0.01em";
                title.textContent = titleText;
                head.appendChild(title);

                if (subtitleText) {
                    const sub = document.createElement("div");
                    sub.style.fontSize = "10px";
                    sub.style.fontWeight = "500";
                    sub.style.color = "#475569";
                    sub.style.marginTop = "1px";
                    sub.textContent = subtitleText;
                    head.appendChild(sub);
                }
                card.appendChild(head);

                const body = document.createElement("div");
                body.style.padding = "6px";
                body.style.backgroundColor = "#FFFFFF";
                body.style.display = "flex";
                body.style.alignItems = "center";
                body.style.justifyContent = "center";

                const chartInst = (instKey && ChartInstances) ? ChartInstances[instKey] : null;
                const sourceCanvas = document.getElementById(canvasId);

                let imgUrl = "";
                if (chartInst && typeof chartInst.toBase64Image === "function") {
                    try {
                        imgUrl = chartInst.toBase64Image("image/png", 1.0);
                    } catch (e) {}
                }
                if (!imgUrl && sourceCanvas && typeof sourceCanvas.toDataURL === "function") {
                    try {
                        imgUrl = sourceCanvas.toDataURL("image/png");
                    } catch (e) {}
                }

                if (imgUrl) {
                    const img = document.createElement("img");
                    img.src = imgUrl;
                    img.style.maxWidth = "100%";
                    img.style.maxHeight = `${heightPx}px`;
                    img.style.height = `${heightPx}px`;
                    img.style.width = "auto";
                    img.style.objectFit = "contain";
                    img.style.display = "block";
                    body.appendChild(img);
                } else if (sourceCanvas) {
                    const clone = document.createElement("canvas");
                    clone.width = sourceCanvas.width;
                    clone.height = sourceCanvas.height;
                    clone.style.maxWidth = "100%";
                    clone.style.maxHeight = `${heightPx}px`;
                    clone.style.height = `${heightPx}px`;
                    clone.style.display = "block";
                    const cCtx = clone.getContext("2d");
                    cCtx.drawImage(sourceCanvas, 0, 0);
                    body.appendChild(clone);
                } else {
                    body.innerHTML = `<div style="color: #94A3B8; font-size: 11px; padding: 20px;">No chart data</div>`;
                }

                card.appendChild(body);
                return card;
            }

            function createTwoCardRow(cardA, cardB) {
                const row = document.createElement("div");
                row.style.display = "flex";
                row.style.gap = "12px";
                row.style.marginBottom = "10px";
                if (cardA) row.appendChild(cardA);
                if (cardB) row.appendChild(cardB);
                return row;
            }

            // ── BUILD PAGE 1: Executive Overview & Main Period Chart ──
            const page1 = createPageContainer();

            // Page 1 Header
            const header1 = document.createElement("div");
            header1.style.display = "flex";
            header1.style.justifyContent = "space-between";
            header1.style.alignItems = "center";
            header1.style.borderBottom = "2.5px solid #0F3B6C";
            header1.style.paddingBottom = "10px";
            header1.style.marginBottom = "12px";
            header1.innerHTML = `
                <div>
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 4px;">
                        <span style="font-size: 20px; font-weight: 800; color: #0A2540; letter-spacing: -0.02em;">HoseXperts</span>
                        <span style="font-size: 13px; font-weight: 600; color: #0284C7; background: #E0F2FE; padding: 2px 8px; border-radius: 4px;">Procurement Analytics</span>
                    </div>
                    <span style="font-size: 11px; color: #64748B;">Executive Procurement Report &bull; Database: OperationsDB</span>
                </div>
                <div style="text-align: right; font-size: 11px;">
                    <div style="font-weight: 700; color: #0A2540; font-size: 12px;">${AppState.granularity || 'Yearly'} &bull; ${AppState.measure || 'Spend'} &bull; ${AppState.dateBasis || 'Posting Date'}</div>
                    <div style="color: #64748B; margin-top: 2px;">${DOM.dataAsOfText ? DOM.dataAsOfText.textContent : 'Data as of Latest'}</div>
                </div>
            `;
            page1.appendChild(header1);

            // Active Filters Summary Strip
            const filterSummaryDiv = document.createElement("div");
            const activeChips = [];
            if (AppState.filters.financialYear && AppState.filters.financialYear.length) {
                activeChips.push(`<strong>FY:</strong> ${AppState.filters.financialYear.join(", ")}`);
            }
            if (AppState.filters.year && AppState.filters.year.length) {
                activeChips.push(`<strong>Year:</strong> ${AppState.filters.year.join(", ")}`);
            }
            if (AppState.filters.month && AppState.filters.month.length) {
                activeChips.push(`<strong>Month:</strong> ${AppState.filters.month.join(", ")}`);
            }
            if (AppState.filters.fromDate || AppState.filters.toDate) {
                activeChips.push(`<strong>Date:</strong> ${AppState.filters.fromDate || 'Start'} to ${AppState.filters.toDate || 'End'}`);
            }
            for (const [k, v] of Object.entries(AppState.filters)) {
                if (["fromDate", "toDate", "financialYear", "year", "month", "week", "day", "itemAttributes"].includes(k)) continue;
                if (Array.isArray(v) && v.length) {
                    const label = (MultiSelectManager.instances && MultiSelectManager.instances[k]) ? MultiSelectManager.instances[k].label : k;
                    activeChips.push(`<strong>${label}:</strong> ${v.slice(0, 3).join(", ")}${v.length > 3 ? ` (+${v.length - 3})` : ''}`);
                }
            }

            if (activeChips.length > 0) {
                filterSummaryDiv.innerHTML = `
                    <div style="background: #F0F6FC; border: 1px solid #BFDBFE; border-left: 4px solid #0284C7; border-radius: 6px; padding: 6px 12px; margin-bottom: 12px; font-size: 11px; color: #0F3B6C; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                        <span style="font-weight: 700; text-transform: uppercase; font-size: 10px; color: #0284C7; letter-spacing: 0.04em;">Active Filters:</span>
                        <span>${activeChips.join(" &nbsp;&bull;&nbsp; ")}</span>
                    </div>
                `;
            } else {
                filterSummaryDiv.innerHTML = `
                    <div style="background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px; padding: 6px 12px; margin-bottom: 12px; font-size: 11px; color: #64748B;">
                        <span style="font-weight: 600;">Active Filters:</span> None (Full Dataset &bull; All records included)
                    </div>
                `;
            }
            page1.appendChild(filterSummaryDiv);

            // KPI Strip
            const spendVal = DOM.kpiFilteredSpend ? DOM.kpiFilteredSpend.textContent : "₹0";
            const rowsVal = DOM.kpiFilteredRows ? DOM.kpiFilteredRows.textContent : "0";
            const granText = `${AppState.granularity || 'Yearly'} • ${AppState.measure || 'Spend'} • ${AppState.dateBasis || 'Posting Date'}`;
            const kpiRow = document.createElement("div");
            kpiRow.innerHTML = `
                <div style="display: flex; gap: 12px; margin-bottom: 14px;">
                    <div style="flex: 1; padding: 8px 14px; border: 1px solid #E2E8F0; border-left: 4px solid #0F3B6C; border-radius: 6px; background: #FFFFFF; box-shadow: 0 1px 2px rgba(10,37,64,0.04);">
                        <div style="font-size: 10px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.03em;">Filtered ${AppState.measure || 'Spend'}</div>
                        <div style="font-size: 18px; font-weight: 800; color: #0A2540; margin-top: 2px;">${spendVal}</div>
                    </div>
                    <div style="flex: 1; padding: 8px 14px; border: 1px solid #E2E8F0; border-left: 4px solid #0284C7; border-radius: 6px; background: #FFFFFF; box-shadow: 0 1px 2px rgba(10,37,64,0.04);">
                        <div style="font-size: 10px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.03em;">Filtered Rows</div>
                        <div style="font-size: 18px; font-weight: 800; color: #0284C7; margin-top: 2px;">${rowsVal}</div>
                    </div>
                    <div style="flex: 1.2; padding: 8px 14px; border: 1px solid #E2E8F0; border-left: 4px solid #0D9488; border-radius: 6px; background: #FFFFFF; box-shadow: 0 1px 2px rgba(10,37,64,0.04);">
                        <div style="font-size: 10px; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.03em;">Granularity Selection</div>
                        <div style="font-size: 13.5px; font-weight: 700; color: #0D9488; margin-top: 4px;">${granText}</div>
                    </div>
                </div>
            `;
            page1.appendChild(kpiRow);

            // Main Period Chart
            const mainTitle = DOM.mainChartTitle ? DOM.mainChartTitle.textContent : "Procurement by Period";
            const mainSub = DOM.mainChartSubtitle ? DOM.mainChartSubtitle.textContent : "Posting Date Breakdown";
            const mainCard = createChartCard("mainChartCanvas", "main", mainTitle, mainSub, 250);
            mainCard.style.width = "100%";
            page1.appendChild(mainCard);

            // Page 1 Footer
            const footer1 = document.createElement("div");
            footer1.style.marginTop = "14px";
            footer1.style.display = "flex";
            footer1.style.justifyContent = "space-between";
            footer1.style.alignItems = "center";
            footer1.style.fontSize = "10px";
            footer1.style.color = "#64748B";
            footer1.innerHTML = `
                <div>HoseXperts Procurement Analytics &bull; Executive Overview</div>
                <div>Page 1 of 4</div>
            `;
            page1.appendChild(footer1);

            // ── BUILD PAGE 2: Breakdown Analysis Dimensions 1 - 4 ──
            const page2 = createPageContainer();
            page2.appendChild(createRunningHeader(2, 4));
            page2.appendChild(createSectionBanner("Breakdown Analysis", "Dimensions 1 - 4 of 10"));
            page2.appendChild(createTwoCardRow(
                createChartCard("chartImportDomestic", "importDomestic", "1. Import vs Domestic", "Doc Currency", 205),
                createChartCard("chartReceivingState", "receivingState", "2. Receiving State", "Ship-To Location", 205)
            ));
            page2.appendChild(createTwoCardRow(
                createChartCard("chartItemGroup", "itemGroup", "3. Item Group", "Top Hierarchy", 205),
                createChartCard("chartSubGroup1", "subGroup1", "4. Sub Group 1", "Category", 205)
            ));

            // ── BUILD PAGE 3: Breakdown Analysis Dimensions 5 - 8 ──
            const page3 = createPageContainer();
            page3.appendChild(createRunningHeader(3, 4));
            page3.appendChild(createSectionBanner("Breakdown Analysis (Continued)", "Dimensions 5 - 8 of 10"));
            page3.appendChild(createTwoCardRow(
                createChartCard("chartSubGroup2", "subGroup2", "5. Sub Group 2", "Sub-Category", 205),
                createChartCard("chartBrand", "brand", "6. Brand", "Manufacturer", 205)
            ));
            page3.appendChild(createTwoCardRow(
                createChartCard("chartBuyer", "buyer", "7. Buyer", "Row Buyer", 205),
                createChartCard("chartPurchaseType", "purchaseType", "8. Credit vs Advance", "Purchase Type", 205)
            ));

            // ── BUILD PAGE 4: Breakdown Analysis Dimensions 9 - 10 & Sign-Off Footer ──
            const page4 = createPageContainer();
            page4.appendChild(createRunningHeader(4, 4));
            page4.appendChild(createSectionBanner("Breakdown Analysis (Continued)", "Dimensions 9 - 10 of 10"));

            const topVendorsTitle = (DOM.titleTopVendors ? DOM.titleTopVendors.textContent : "9. Top Vendors");
            const topVendorsSub = (DOM.subTitleTopVendors ? DOM.subTitleTopVendors.textContent : "Ranked by Spend + Others");
            page4.appendChild(createTwoCardRow(
                createChartCard("chartTopVendors", "topVendors", topVendorsTitle, topVendorsSub, 270),
                createChartCard("chartVendorGroup", "vendorGroup", "10. Vendor Group", "BP Group", 270)
            ));

            const footer4 = document.createElement("div");
            footer4.style.marginTop = "20px";
            footer4.style.paddingTop = "10px";
            footer4.style.borderTop = "1.5px solid #E2E8F0";
            footer4.style.display = "flex";
            footer4.style.justifyContent = "space-between";
            footer4.style.alignItems = "center";
            footer4.style.fontSize = "10.5px";
            footer4.style.color = "#64748B";
            footer4.innerHTML = `
                <div>Data Source: OperationsDB (VD_Procurement_Dashboard) &bull; HoseXperts Confidential</div>
                <div>Generated: ${new Date().toLocaleString('en-IN')} &bull; Page 4 of 4</div>
            `;
            page4.appendChild(footer4);

            // Mount pages into staging
            staging.appendChild(page1);
            staging.appendChild(page2);
            staging.appendChild(page3);
            staging.appendChild(page4);

            // Wait for all images across all 4 pages to complete decoding
            const allImages = Array.from(staging.querySelectorAll("img"));
            await Promise.all(allImages.map(img => {
                if (img.complete && img.naturalWidth > 0) return Promise.resolve();
                if (img.decode) return img.decode().catch(() => {});
                return new Promise(res => { img.onload = img.onerror = res; });
            }));

            // Small delay to ensure browser layout engine settles
            await new Promise(r => setTimeout(r, 60));

            // Check if jsPDF and html2canvas are available
            const jsPdfClass = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
            const h2c = window.html2canvas;

            if (jsPdfClass && h2c) {
                const pdf = new jsPdfClass({
                    orientation: "landscape",
                    unit: "mm",
                    format: "a4",
                    compress: true
                });

                const pages = [page1, page2, page3, page4];
                const printableWidthMm = 277; // A4 landscape width (297) - 2 * 10mm margins = 277mm

                for (let i = 0; i < pages.length; i++) {
                    const canvas = await h2c(pages[i], {
                        scale: 2,
                        useCORS: true,
                        backgroundColor: "#FFFFFF",
                        logging: false
                    });

                    const imgData = canvas.toDataURL("image/jpeg", 0.98);
                    const imgHeightMm = (canvas.height * printableWidthMm) / canvas.width;

                    if (i > 0) {
                        pdf.addPage("a4", "landscape");
                    }
                    pdf.addImage(imgData, "JPEG", 10, 8, printableWidthMm, imgHeightMm);
                }

                const filename = `HoseXperts_Procurement_Report_${AppState.granularity || 'All'}_${AppState.measure || 'Spend'}_${new Date().toISOString().slice(0, 10)}.pdf`;
                pdf.save(filename);
                cleanup();
            } else if (typeof html2pdf !== "undefined") {
                // Secondary fallback via html2pdf
                const opt = {
                    margin: [8, 10, 8, 10],
                    filename: `HoseXperts_Procurement_Report_${AppState.granularity || 'All'}_${AppState.measure || 'Spend'}_${new Date().toISOString().slice(0, 10)}.pdf`,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: { scale: 2, useCORS: true },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
                    pagebreak: { mode: ['css', 'legacy'] }
                };
                await html2pdf().set(opt).from(staging).save();
                cleanup();
            } else {
                cleanup();
                window.print();
            }
        } catch (err) {
            console.error("PDF export encountered an error, falling back to window.print():", err);
            cleanup();
            window.print();
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
        AppState.drilldown = {
            level: "yearly",
            sourceGranularity: "Yearly",
            financialYear: null,
            year: null,
            month: null,
            monthName: null,
            week: null,
            date: null,
            history: []
        };
        AppState.filters.financialYear = [];
        ChartDrillDown.renderBreadcrumbs();
        ChartDrillDown.updateTitleAndSubtitle();

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

        AppState.breakdownAnalysis = "None";
        if (DOM.breakdownAnalysisRadios) {
            DOM.breakdownAnalysisRadios.forEach(radio => {
                radio.checked = (radio.value === "None");
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

        // Reset Drill-down state
        AppState.drilldown = {
            level: "yearly",
            sourceGranularity: "Yearly",
            financialYear: null,
            year: null,
            month: null,
            monthName: null,
            week: null,
            date: null,
            history: []
        };
        AppState.filters.financialYear = [];
        ChartDrillDown.renderBreadcrumbs();
        ChartDrillDown.updateTitleAndSubtitle();

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
            breakdown_analysis: AppState.breakdownAnalysis || "None",
            filters: AppState.filters,
            page: AppState.tablePage,
            page_size: AppState.tablePageSize,
            sort_column: AppState.tableSort.column,
            sort_direction: AppState.tableSort.direction,
            top_vendors_limit: AppState.topVendorsLimit
        };

        if (DOM.mainChartLoading) DOM.mainChartLoading.style.display = "block";
        try {
            const resp = await fetch("/api/procurement/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!resp.ok) throw new Error(`Query error ${resp.status}`);
            const data = await resp.json();

            // Update UI components
            if (DOM.dataAsOfText && (data.data_as_of_iso || data.data_as_of_formatted || data.data_as_of)) {
                const formatted = formatDataAsOf(data.data_as_of_iso || data.data_as_of, data.data_as_of_formatted || data.data_as_of);
                if (formatted && formatted !== "--") {
                    DOM.dataAsOfText.textContent = `Data as of ${formatted}`;
                }
            }
            updateKpiStrip(data);
            updateFilterOptions(data.filter_options);

            if (data.no_data) {
                if (DOM.noDataAlert) DOM.noDataAlert.style.display = "flex";
                destroyAllCharts();
                clearDetailTable();
            } else {
                if (DOM.noDataAlert) DOM.noDataAlert.style.display = "none";
                AppState.latestBreakdowns = data.breakdown_charts;
                AppState.latestMainChart = data.main_chart;
                renderMainChart(data.main_chart);
                renderBreakdownCharts(data.breakdown_charts);
                renderDetailTable(data.table_data);
                if (document.getElementById("modalUniversalChart") && document.getElementById("modalUniversalChart").classList.contains("show")) {
                    renderUniversalModalChart();
                } else if (document.getElementById("modalTopVendors") && document.getElementById("modalTopVendors").classList.contains("show")) {
                    renderModalTopVendorsChart();
                }
            }
        } catch (err) {
            console.error("Query execution failed:", err);
        } finally {
            if (DOM.mainChartLoading) DOM.mainChartLoading.style.display = "none";
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
            updateKpiSelectionText();
        }
        if (DOM.mainChartTitle) {
            ChartDrillDown.updateTitleAndSubtitle();
        }
        ChartDrillDown.renderBreadcrumbs();

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
     * Helper to slice chart data (labels & datasets) to Top N items.
     */
    function sliceChartData(cData, limit) {
        if (!cData || !cData.labels || !limit || limit <= 0 || cData.labels.length <= limit) {
            return cData;
        }
        const slicedLabels = cData.labels.slice(0, limit);
        const slicedDatasets = (cData.datasets || []).map(ds => {
            const newDs = Object.assign({}, ds, {
                data: Array.isArray(ds.data) ? ds.data.slice(0, limit) : ds.data
            });
            if (Array.isArray(ds.backgroundColor)) {
                newDs.backgroundColor = ds.backgroundColor.slice(0, limit);
            }
            if (Array.isArray(ds.borderColor)) {
                newDs.borderColor = ds.borderColor.slice(0, limit);
            }
            return newDs;
        });
        return {
            ...cData,
            labels: slicedLabels,
            datasets: slicedDatasets
        };
    }

    /**
     * Compute and inject a dynamic Average Benchmark Line across the main period chart.
     * Works across all granularities: Yearly, Financial Year, Monthly, Weekly, and Daily.
     */
    function addMainChartAverageLine(chartData) {
        if (!chartData || !chartData.labels || chartData.labels.length === 0 || !chartData.datasets || chartData.datasets.length === 0) {
            updateMainChartAverageBadge(null);
            return null;
        }

        // Always strip any existing average line dataset before re-computing
        chartData.datasets = chartData.datasets.filter(ds => !ds._isAverageLine);

        // Granularity-aware period name matching the actual bars displayed
        let periodName = "Period";
        if (AppState.granularity === "Yearly" || AppState.granularity === "Financial Year") {
            periodName = "Yearly";
        } else if (AppState.granularity === "Monthly") {
            periodName = "Monthly";
        } else if (AppState.granularity === "Weekly") {
            periodName = "Weekly";
        } else if (AppState.granularity === "Daily") {
            periodName = "Daily";
        }

        const barDatasets = chartData.datasets.filter(ds => !ds._isAverageLine && ds.type !== "line");

        // When Measure is Quantity with multiple distinct UoMs (e.g. MM & COIL),
        // adding different physical units into a single flat line is mathematically invalid.
        // Instead, compute each UoM's own average and display in the header summary badge!
        const isBreakdownActive = !!(AppState.breakdownAnalysis && AppState.breakdownAnalysis !== "All" && AppState.breakdownAnalysis !== "None");
        if (AppState.measure === "Quantity" && !isBreakdownActive && barDatasets.length > 1) {
            const parts = [];
            barDatasets.forEach(ds => {
                let sum = 0;
                let count = 0;
                if (ds.data) {
                    ds.data.forEach(v => {
                        const num = Number(v);
                        if (!isNaN(num) && num > 0) {
                            sum += num;
                            count++;
                        }
                    });
                }
                const avg = count > 0 ? (sum / count) : 0;
                const fmt = IndianCurrencyFormatter.formatQuantityCompact(avg, 1);
                const uomName = (ds.label || "").replace(/^Qty\s*\((.*)\)$/, "$1").trim();
                parts.push(`${uomName}: ${fmt}`);
            });
            updateMainChartAverageBadge({
                periodName,
                formattedAvg: parts.join(" | ")
            });
            return null;
        }

        const numPoints = chartData.labels.length;
        let totalVal = 0;
        let validCount = 0;

        for (let i = 0; i < numPoints; i++) {
            let barSum = 0;
            let hasVal = false;
            chartData.datasets.forEach(ds => {
                if (ds._isAverageLine) return;
                const raw = ds.data ? ds.data[i] : 0;
                const val = Number(raw);
                if (!isNaN(val)) {
                    barSum += val;
                    hasVal = true;
                }
            });
            if (hasVal) {
                totalVal += barSum;
                validCount++;
            }
        }

        if (validCount === 0) {
            updateMainChartAverageBadge(null);
            return null;
        }

        const avgVal = totalVal / validCount;

        let formattedAvg = "";
        if (AppState.measure === "Spend") {
            formattedAvg = IndianCurrencyFormatter.formatCompact(avgVal, 2);
        } else {
            formattedAvg = IndianCurrencyFormatter.formatQuantityCompact(avgVal, 2);
        }

        const avgLabel = `Avg (${periodName}): ${formattedAvg}`;

        const avgDataset = {
            _isAverageLine: true,
            type: "line",
            label: avgLabel,
            data: new Array(numPoints).fill(avgVal),
            borderColor: "#D97706", // Elegant Warm Amber / Gold
            backgroundColor: "transparent",
            borderWidth: 2.2,
            borderDash: [6, 4],
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: "#D97706",
            pointHoverBorderColor: "#FFFFFF",
            pointHoverBorderWidth: 2,
            fill: false,
            tension: 0,
            order: -10 // Renders on top of bars
        };

        chartData.datasets.push(avgDataset);

        updateMainChartAverageBadge({ avgVal, formattedAvg, periodName });

        return { avgVal, formattedAvg, periodName };
    }

    function updateMainChartAverageBadge(info) {
        const badge = document.getElementById("mainChartAverageBadge");
        const text = document.getElementById("mainChartAverageText");
        if (!badge || !text) return;
        if (!info) {
            badge.style.display = "none";
            return;
        }
        text.textContent = `Avg (${info.periodName}): ${info.formattedAvg}`;
        badge.style.display = "inline-flex";
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

        const barDatasets = (chartData && chartData.datasets)
            ? chartData.datasets.filter(ds => !ds._isAverageLine && ds.type !== "line")
            : [];
        const isBreakdownActive = !!(AppState.breakdownAnalysis && AppState.breakdownAnalysis !== "All" && AppState.breakdownAnalysis !== "None");
        const isDualAxis = (AppState.measure === "Quantity" && !isBreakdownActive && barDatasets.length === 2);

        if (chartData && chartData.datasets) {
            chartData.datasets.forEach(ds => {
                if (!ds._isAverageLine && ds.type !== "line") {
                    ds.minBarLength = isBreakdownActive ? 4 : 8;
                    if (ds.backgroundColor && ds.backgroundColor !== "#0F3B6C") {
                        ds.hoverBackgroundColor = ds.backgroundColor;
                        ds.hoverBorderColor = ds.borderColor || ds.backgroundColor;
                    } else {
                        ds.hoverBackgroundColor = "#165BAA";
                        ds.hoverBorderColor = "#0F3B6C";
                    }
                }
            });
        }

        if (isDualAxis) {
            barDatasets[0].yAxisID = "y";
            barDatasets[1].yAxisID = "y1";
        } else {
            barDatasets.forEach(ds => { ds.yAxisID = "y"; });
        }

        // Inject Dynamic Average Benchmark Line
        addMainChartAverageLine(chartData);

        const ctx = canvas.getContext("2d");
        ChartInstances.main = new Chart(ctx, {
            type: "bar",
            data: chartData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                onHover: function (e, elements) {
                    canvas.style.cursor = (elements && elements.length) ? "pointer" : "default";
                },
                scales: {
                    x: {
                        stacked: false,
                        grid: {
                            display: true,
                            color: "#E2E8F0",
                            lineWidth: 1,
                            drawTicks: true
                        },
                        ticks: {
                            color: "#475569",
                            font: { family: "'Plus Jakarta Sans', sans-serif", size: 11, weight: "600" }
                        }
                    },
                    y: {
                        stacked: false,
                        type: "linear",
                        position: "left",
                        beginAtZero: true,
                        grace: "10%",
                        grid: {
                            display: true,
                            color: "#CBD5E1",
                            lineWidth: 1.2
                        },
                        title: isDualAxis ? {
                            display: true,
                            text: barDatasets[0].label || "Quantity",
                            color: barDatasets[0].backgroundColor || "#0f766e",
                            font: { family: "'Plus Jakarta Sans', sans-serif", size: 11, weight: "bold" }
                        } : { display: false },
                        ticks: {
                            color: isDualAxis ? (barDatasets[0].backgroundColor || "#0f766e") : "#1E293B",
                            font: { family: "'Plus Jakarta Sans', sans-serif", size: 11, weight: "600" },
                            callback: function (val) {
                                if (AppState.measure === "Spend") {
                                    return IndianCurrencyFormatter.formatCompact(val);
                                }
                                return IndianCurrencyFormatter.formatQuantityCompact(val);
                            }
                        }
                    },
                    ...(isDualAxis ? {
                        y1: {
                            type: "linear",
                            position: "right",
                            beginAtZero: true,
                            grace: "10%",
                            grid: {
                                drawOnChartArea: false
                            },
                            title: {
                                display: true,
                                text: barDatasets[1].label || "Quantity",
                                color: barDatasets[1].backgroundColor || "#2563eb",
                                font: { family: "'Plus Jakarta Sans', sans-serif", size: 11, weight: "bold" }
                            },
                            ticks: {
                                color: barDatasets[1].backgroundColor || "#2563eb",
                                font: { family: "'Plus Jakarta Sans', sans-serif", size: 11, weight: "600" },
                                callback: function (val) {
                                    return IndianCurrencyFormatter.formatQuantityCompact(val);
                                }
                            }
                        }
                    } : {})
                },
                plugins: {
                    legend: {
                        display: true,
                        position: "top",
                        align: "end",
                        labels: {
                            boxWidth: 16,
                            boxHeight: 10,
                            font: { family: "'Plus Jakarta Sans', sans-serif", size: 11, weight: "600" },
                            color: "#334155",
                            padding: 10,
                            generateLabels: function (chart) {
                                const orig = Chart.defaults.plugins.legend.labels.generateLabels(chart);
                                return orig.map(item => {
                                    const ds = chart.data.datasets[item.datasetIndex];
                                    if (ds && ds._isAverageLine) {
                                        item.lineDash = [6, 4];
                                        item.strokeStyle = ds.borderColor;
                                        item.lineWidth = 2.5;
                                    }
                                    return item;
                                });
                            }
                        }
                    },
                    barValueLabels: {
                        display: AppState.granularity === "Yearly" || AppState.granularity === "Financial Year"
                    },
                    tooltip: {
                        backgroundColor: "#0A2540",
                        titleFont: { family: "'Plus Jakarta Sans', sans-serif", size: 12, weight: "bold" },
                        bodyFont: { family: "'Plus Jakarta Sans', sans-serif", size: 12 },
                        cornerRadius: 6,
                        padding: 10,
                        callbacks: {
                            label: function (context) {
                                const rawVal = context.raw;
                                if (context.dataset && context.dataset._isAverageLine) {
                                    if (AppState.measure === "Spend") {
                                        return [
                                            `★ ${context.dataset.label}`,
                                            `Exact Average: ${IndianCurrencyFormatter.formatExact(rawVal)}`
                                        ];
                                    }
                                    const num = Number(rawVal);
                                    const compactQty = IndianCurrencyFormatter.formatQuantityCompact(rawVal, 2);
                                    const formattedQty = num.toLocaleString("en-IN", {
                                        minimumFractionDigits: 0,
                                        maximumFractionDigits: 2
                                    });
                                    return [
                                        `★ ${context.dataset.label}`,
                                        `Exact Average Qty: ${formattedQty}`
                                    ];
                                }
                                if (AppState.measure === "Spend") {
                                    const compact = IndianCurrencyFormatter.formatCompact(rawVal, 2);
                                    const exact = IndianCurrencyFormatter.formatExact(rawVal);
                                    return [
                                        compact,
                                        `Exact Value: ${exact}`
                                    ];
                                }
                                const num = Number(rawVal);
                                const compactQty = IndianCurrencyFormatter.formatQuantityCompact(rawVal, 2);
                                const formattedQty = num.toLocaleString("en-IN", {
                                    minimumFractionDigits: 0,
                                    maximumFractionDigits: 2
                                });
                                const uom = context.dataset.label ? `${context.dataset.label}: ` : "Quantity: ";
                                return [
                                    `${uom}${compactQty}`,
                                    `Exact Qty: ${formattedQty}`
                                ];
                            }
                        }
                    }
                }
            }
        });
    }

    /**
     * Render a single Horizontal Breakdown Bar Chart with optional limit slicing.
     */
    function renderSingleBreakdownChart(key, canvasId, inst, rawChartData) {
        const canvas = document.getElementById(canvasId);
        if (!canvas || !rawChartData) return;

        if (ChartInstances[inst]) {
            ChartInstances[inst].destroy();
            ChartInstances[inst] = null;
        }

        // Determine active limit: from select element in DOM or AppState
        let limit = 0;
        const sel = document.querySelector(`.chart-limit-select[data-chart-key="${key}"]`);
        if (sel) {
            limit = parseInt(sel.value, 10) || 0;
        } else if (AppState.chartLimits && AppState.chartLimits[key]) {
            limit = AppState.chartLimits[key];
        }

        const cData = sliceChartData(rawChartData, limit);
        const numItems = cData.labels ? cData.labels.length : 0;
        const barHeight = Math.max(260, numItems * 30);

        // Sizing wrapper ensures Chart.js respects barHeight inside scrollable containers
        let wrapper = canvas.parentElement;
        if (!wrapper.classList.contains("chart-canvas-wrapper")) {
            const parent = canvas.parentNode;
            wrapper = document.createElement("div");
            wrapper.className = "chart-canvas-wrapper";
            wrapper.style.position = "relative";
            wrapper.style.width = "100%";
            parent.insertBefore(wrapper, canvas);
            wrapper.appendChild(canvas);
        }
        wrapper.style.height = `${barHeight}px`;
        canvas.style.height = `${barHeight}px`;

        const ctx = canvas.getContext("2d");
        ChartInstances[inst] = new Chart(ctx, {
            type: "bar",
            data: cData,
            options: {
                indexAxis: "y", // Horizontal bars (CH5)
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        beginAtZero: true,
                        grace: "12%",
                        grid: {
                            color: "#F1F5F9"
                        },
                        ticks: {
                            color: "#64748B",
                            font: { family: "'Plus Jakarta Sans', sans-serif", size: 11 },
                            callback: function (val) {
                                if (AppState.measure === "Spend") {
                                    return IndianCurrencyFormatter.formatCompact(val);
                                }
                                return IndianCurrencyFormatter.formatQuantityCompact(val);
                            }
                        }
                    },
                    y: {
                        grid: { display: false },
                        ticks: {
                            autoSkip: false,
                            color: "#1E293B",
                            font: { family: "'Plus Jakarta Sans', sans-serif", size: 11, weight: "500" },
                            padding: 8
                        }
                    }
                },
                plugins: {
                    legend: {
                        display: false // Suppress repetitive legend; master legend is shown on main graph
                    },
                    tooltip: {
                        backgroundColor: "#0A2540",
                        titleFont: { family: "'Plus Jakarta Sans', sans-serif", size: 12, weight: "bold" },
                        bodyFont: { family: "'Plus Jakarta Sans', sans-serif", size: 12 },
                        cornerRadius: 6,
                        padding: 10,
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
                                const compactQty = IndianCurrencyFormatter.formatQuantityCompact(rawVal, 2);
                                const formattedQty = num.toLocaleString("en-IN", {
                                    minimumFractionDigits: 0,
                                    maximumFractionDigits: 2
                                });
                                const label = context.dataset.label || "Quantity";
                                return [
                                    `${label}: ${compactQty}`,
                                    `Exact Qty: ${formattedQty}`
                                ];
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
            renderSingleBreakdownChart(cfg.key, cfg.id, cfg.inst, breakdowns[cfg.key]);
        });
    }

    /**
     * Update active granularity / measure / date basis / breakdown indicator.
     */
    function updateKpiSelectionText() {
        if (!DOM.kpiActiveSelection) return;
        const gran = AppState.granularity || "--";
        const meas = AppState.measure || "--";
        const dateB = AppState.dateBasis || "--";
        const brk = (AppState.breakdownAnalysis && AppState.breakdownAnalysis !== "All" && AppState.breakdownAnalysis !== "None")
            ? ` • ${AppState.breakdownAnalysis}`
            : "";
        DOM.kpiActiveSelection.textContent = `${gran} • ${meas} • ${dateB}${brk}`;
    }

    /**
     * Filter or focus the Breakdown Analysis section based on selected Breakdown Analysis Granularity.
     * Options:
     * 1. Import vs Domestic
     * 2. Receiving State
     * 3. Item Group
     * 4. Sub Group 1
     * 5. Sub Group 2
     * 6. Brand
     * 7. Buyer
     * 8. Credit vs Advance
     * or "All" to view all breakdown dimensions.
     */
    function applyBreakdownAnalysisFilter(value, shouldScroll = true) {
        const breakdownMap = {
            "Import vs Domestic": { colId: "colImportDomestic", inst: "importDomestic" },
            "Receiving State": { colId: "colReceivingState", inst: "receivingState" },
            "Item Group": { colId: "colItemGroup", inst: "itemGroup" },
            "Sub Group 1": { colId: "colSubGroup1", inst: "subGroup1" },
            "Sub Group 2": { colId: "colSubGroup2", inst: "subGroup2" },
            "Brand": { colId: "colBrand", inst: "brand" },
            "Buyer": { colId: "colBuyer", inst: "buyer" },
            "Credit vs Advance": { colId: "colPurchaseType", inst: "purchaseType" },
        };

        const allBreakdownCols = document.querySelectorAll(".chart-col-expandable");
        const badge = document.getElementById("breakdownDimensionsBadge");
        const resetContainer = document.getElementById("breakdownResetFilterContainer");

        if (value === "None") {
            // Hide all breakdown charts
            allBreakdownCols.forEach(col => {
                col.style.display = "none";
                if (col.classList.contains("breakdown-isolated-col")) {
                    col.classList.remove("breakdown-isolated-col", "col-12", "breakdown-highlight-card");
                    col.classList.add("col-md-6");
                }
            });

            if (badge) {
                badge.textContent = "None";
                badge.className = "badge bg-secondary text-white";
                badge.style.background = "";
                badge.style.color = "";
                badge.style.borderColor = "";
            }

            if (resetContainer) {
                resetContainer.innerHTML = `
                    <button type="button" class="btn btn-xs btn-outline-secondary py-0 px-2 d-inline-flex align-items-center gap-1 shadow-xs" id="btnShowAllBreakdowns" title="Show all breakdown dimensions" style="height: 24px; font-size: 0.725rem;">
                        <i class="bi bi-grid"></i>
                        <span>Show All</span>
                    </button>
                `;
                const btnShowAll = document.getElementById("btnShowAllBreakdowns");
                if (btnShowAll) {
                    btnShowAll.addEventListener("click", function () {
                        const allRadio = document.getElementById("breakdownAll");
                        if (allRadio) {
                            allRadio.checked = true;
                            allRadio.dispatchEvent(new Event("change"));
                        } else {
                            AppState.breakdownAnalysis = "All";
                            applyBreakdownAnalysisFilter("All", false);
                            updateKpiSelectionText();
                        }
                    });
                }
            }
        } else if (!value || value === "All" || !breakdownMap[value]) {
            // Show all dimensions in grid
            allBreakdownCols.forEach(col => {
                col.style.display = "";
                if (col.classList.contains("breakdown-isolated-col")) {
                    col.classList.remove("breakdown-isolated-col", "col-12", "breakdown-highlight-card");
                    col.classList.add("col-md-6");
                }
            });

            if (badge) {
                badge.textContent = "All Dimensions";
                badge.className = "badge";
                badge.style.background = "#FFFFFF";
                badge.style.color = "#0F3B6C";
                badge.style.borderColor = "#BFDBFE";
            }
            if (resetContainer) {
                resetContainer.innerHTML = "";
            }
        } else {
            // Isolate and focus the selected breakdown dimension
            const target = breakdownMap[value];
            let targetEl = null;

            allBreakdownCols.forEach(col => {
                if (col.id === target.colId) {
                    col.style.display = "";
                    col.classList.remove("col-md-6");
                    col.classList.add("col-12", "breakdown-isolated-col", "breakdown-highlight-card");
                    targetEl = col;
                } else {
                    col.style.display = "none";
                }
            });

            if (badge) {
                badge.textContent = value;
                badge.className = "badge bg-primary text-white";
                badge.style.background = "";
                badge.style.color = "";
                badge.style.borderColor = "";
            }

            if (resetContainer) {
                resetContainer.innerHTML = `
                    <button type="button" class="btn btn-xs btn-outline-secondary py-0 px-2 d-inline-flex align-items-center gap-1 shadow-xs" id="btnShowAllBreakdowns" title="Show all breakdown dimensions" style="height: 24px; font-size: 0.725rem;">
                        <i class="bi bi-grid"></i>
                        <span>Show All</span>
                    </button>
                `;
                const btnShowAll = document.getElementById("btnShowAllBreakdowns");
                if (btnShowAll) {
                    btnShowAll.addEventListener("click", function () {
                        const allRadio = document.getElementById("breakdownAll");
                        if (allRadio) {
                            allRadio.checked = true;
                            allRadio.dispatchEvent(new Event("change"));
                        } else {
                            AppState.breakdownAnalysis = "All";
                            applyBreakdownAnalysisFilter("All", false);
                            updateKpiSelectionText();
                        }
                    });
                }
            }

            // Resize target chart to adapt to full-width container
            if (target && target.inst && ChartInstances[target.inst]) {
                setTimeout(() => {
                    try {
                        ChartInstances[target.inst].resize();
                    } catch (e) {}
                }, 50);
            }

            // Smooth scroll to breakdown section
            if (shouldScroll) {
                const section = document.getElementById("breakdownAnalysisSection") || targetEl;
                if (section) {
                    section.scrollIntoView({ behavior: "smooth", block: "start" });
                }
            }
        }
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
                    <td class="text-truncate" style="max-width: 200px;" title="${r["BP Name"]}">${r["BP Name"]}</td>
                    <td>${r["Vendors Doc No."]}</td>
                    <td>${r["Vendors Doc Date"]}</td>
                    <td>${r["Posting Date"]}</td>
                    <td>${r["Item Code"]}</td>
                    <td class="text-end font-monospace">${formattedQty}</td>
                    <td><span class="badge bg-light text-dark border">${r.UoM || "-"}</span></td>
                    <td class="text-end font-monospace fw-semibold ${isNeg ? 'text-danger' : 'text-dark'}">${formattedSpend}</td>
                    <td>${r["Row Buyer"]}</td>
                    <td class="d-none">${r["Document Type"]}</td>
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
        updateMainChartAverageBadge(null);
    }

    function clearDetailTable() {
        if (DOM.detailTableBody) DOM.detailTableBody.innerHTML = "";
        if (DOM.tableRowsCountText) DOM.tableRowsCountText.textContent = "Rows 0–0 of 0";
        if (DOM.paginationInfo) DOM.paginationInfo.textContent = "Showing 0 to 0 of 0 entries";
        if (DOM.tablePagination) DOM.tablePagination.innerHTML = "";
    }

    /**
     * Fetch full dataset from backend (DL1) with non-blocking progress polling.
     */
    async function loadProcurementDataset(isRefresh = false) {
        if (DOM.loadingOverlay) {
            DOM.loadingOverlay.style.display = "flex";
            if (DOM.loadingText) {
                DOM.loadingText.textContent = isRefresh ? "Refreshing Data from Server..." : "Loading Procurement Data...";
            }
        }

        if (isRefresh) {
            AppState.isLoaded = false;
        }

        const url = "/api/procurement/dataset" + (isRefresh ? "?refresh=true" : "");
        const maxAttempts = 60; // 60 attempts * 1.5s = 90s max wait
        let attempt = 0;

        while (attempt < maxAttempts) {
            attempt++;
            try {
                const resp = await fetch(attempt === 1 ? url : "/api/procurement/dataset");
                if (!resp.ok) {
                    const errBody = await resp.json().catch(() => null);
                    throw new Error(errBody?.error || `HTTP error ${resp.status}`);
                }
                const data = await resp.json();

                if (data.status === "loading") {
                    if (DOM.loadingText && data.progress) {
                        DOM.loadingText.textContent = data.progress;
                    }
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    continue;
                }

                if (data.status === "error") {
                    throw new Error(data.error || "Failed to load procurement dataset");
                }

                // Status is success!
                const priorError = document.getElementById("procurementLoadError");
                if (priorError) priorError.remove();
                AppState.isLoaded = true;
                AppState.dataAsOf = data.data_as_of;
                AppState.totalRecords = data.record_count || 0;

                if (DOM.dataAsOfText) {
                    const formatted = formatDataAsOf(data.data_as_of_iso || data.data_as_of, data.data_as_of_formatted || data.data_as_of);
                    if (formatted && formatted !== "--") {
                        DOM.dataAsOfText.textContent = `Data as of ${formatted}`;
                    }
                }

                if (isFlowReady()) {
                    executeQuery();
                }
                break;
            } catch (err) {
                console.error("Failed to load procurement dataset:", err);
                let errorBox = document.getElementById("procurementLoadError");
                if (!errorBox) {
                    errorBox = document.createElement("div");
                    errorBox.id = "procurementLoadError";
                    errorBox.className = "alert alert-danger m-3";
                    errorBox.setAttribute("role", "alert");
                    const host = document.querySelector("main") || document.body;
                    host.prepend(errorBox);
                }
                errorBox.textContent = `Procurement data could not be loaded: ${err.message}. Please use Refresh Data to retry.`;
                break;
            }
        }

        if (DOM.loadingOverlay) {
            DOM.loadingOverlay.style.display = "none";
        }
    }

    // Initialize on DOM load (handles both early and late script execution)
    function initialize() {
        setupEventListeners();
        updateGatingVisibility();
        loadProcurementDataset(false);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize);
    } else {
        // DOM is already ready (e.g. script loaded after parsing or in iframe)
        initialize();
    }

    // Expose for testing and direct button invocation
    window.ProcurementApp = {
        state: AppState,
        isFlowReady: isFlowReady,
        resetFilters: resetFilters,
        executeQuery: executeQuery,
        loadDataset: loadProcurementDataset,
        multiSelectManager: MultiSelectManager,
        chartDrillDown: ChartDrillDown,
        indianCurrencyFormatter: IndianCurrencyFormatter,
        toggleFilterSidebar: toggleFilterSidebar,
        toggleAllFilterSections: toggleAllFilterSections,
        toggleExpandChart: toggleExpandChart,
        toggleExpandTopVendors: toggleExpandTopVendors,
        openUniversalModal: openUniversalModal,
        openModalTopVendors: openModalTopVendors,
        openCurrentModalChartInNewTab: openCurrentModalChartInNewTab,
        openTopVendorsInNewTab: openTopVendorsInNewTab,
        toggleDetailTable: toggleDetailTableCollapse,
        exportPdf: exportPdf
    };

})();
