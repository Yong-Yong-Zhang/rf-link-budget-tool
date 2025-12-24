/*
 * RF 鏈路預算 (Web App v10.2V) - 核心 JavaScript (English Menu)
 */

// ============================================================================
// 1. 全域變數宣告
// ============================================================================
let calculator;
let blocks = []; 
let connections_TX = new Map(); 
let connections_RX = new Map(); 
let currentConnections; 
let isMergeSelectMode = false; 
let mergeSelection = [];      
let currentCalcMode = "TX";
let lastCalcFreq = null;
let lastCalcMode = null;

let canvas, ctx;
let canvasWidth, canvasHeight;
let dragData = { item: null, offsetX: 0, offsetY: 0 };
let lineData = { startComp: null, tempLineId: null, mouseX: 0, mouseY: 0 };
let poutLabels = []; 
let canvasZoom = 1.0;
let canvasPan = { x: 0, y: 0 };
let panData = { isPanning: false, startX: 0, startY: 0 };
const MAX_ZOOM = 3.0;
const MIN_ZOOM = 0.3;

let rightClickedComp = null;
let rightClickedLine = null;
let editingComp = null;
let editingSpecsCopy = null;
let editingCurrentFreq = null;
let dom = {};

// ============================================================================
// 2. 自訂錯誤與輔助工具
// ============================================================================
class CompressionError extends Error {
    constructor(message, component) {
        super(message);
        this.name = "CompressionError";
        this.component = component;
    }
}

function db_to_linear(db_value) { return 10**(db_value / 10); }
function linear_to_db(linear_value) {
    if (linear_value <= 0) return -Infinity;
    return 10 * Math.log10(linear_value);
}
function dbm_to_mw(db_value) { return 10**(db_value / 10); }
function mw_to_dbm(mw_value) {
    if (mw_value <= 0) return -Infinity;
    return 10 * Math.log10(mw_value);
}
function formatNum(num, digits = 1) {
    const roundedNum = parseFloat(num.toFixed(digits));
    return String(roundedNum);
}
function calculateFSPL(freqGHz, distCm) {
    if (distCm <= 0) return 0.0;
    const freqHz = freqGHz * 1e9;
    const distM = distCm / 100.0;
    const c = 299792458; 
    const linear = (4 * Math.PI * distM * freqHz) / c;
    if (linear < 1) return 0.0; 
    return 20 * Math.log10(linear);
}

// ============================================================================
// 3. 類別定義 (Classes)
// ============================================================================
class RFComponent {
    constructor(name, isPassive = false, isSystem = false, specsByFreqDict = null, isAirLoss = false, isArray = false) {
        this.name = name;
        this.isPassive = isPassive;
        this.isSystem = isSystem;
        this.isAirLoss = isAirLoss; 
        this.isArray = isArray; 

        this.airLossConfig = { mode: 'calc', dist_cm: 100.0 };
        this.arrayConfig = { rows: 4, cols: 4 };

        this.specsByFreq = {};
        this.id = `comp_${Date.now()}_${Math.random()}`;
        this.runtimeResults = null;

        this.x = 50; this.y = 50;
        this.width = 110; this.height = 70; 
        this.isHighlighted = false; this.isSelected = false;
        this.isMerged = false; this.childrenData = [];

        if (specsByFreqDict) {
            for (const [freq, modes_dict] of Object.entries(specsByFreqDict)) {
                this.specsByFreq[freq] = {};
                const raw_tx = modes_dict.TX || {};
                const raw_rx = modes_dict.RX || {};
                const final_tx_specs = Object.keys(raw_tx).length > 0 ? raw_tx : raw_rx;
                const final_rx_specs = Object.keys(raw_rx).length > 0 ? raw_rx : final_tx_specs;
                this.specsByFreq[freq]["TX"] = this.calculateSpecs(freq, "TX", final_tx_specs);
                this.specsByFreq[freq]["RX"] = this.calculateSpecs(freq, "RX", final_rx_specs);
            }
        } else {
            let defaultSpecs = {};
            if (isPassive) defaultSpecs = { 'loss_db': 0.0 };
            else if (isSystem) defaultSpecs = { 'gain_db': 0.0, 'nf_db': 0.0, 'op1db_dbm': 99.0 }; 
            else defaultSpecs = { 'gain_db': 0.0, 'nf_db': 0.0, 'op1db_dbm': 99.0 };
            
            this.specsByFreq["1.0"] = {
                "TX": this.calculateSpecs("1.0", "TX", defaultSpecs),
                "RX": this.calculateSpecs("1.0", "RX", defaultSpecs)
            };
        }
    }

    calculateSpecs(freqStr, mode, specsDict) {
        const storage = {};
        let gain_db, nf_db, op1db_dbm;

        if (this.isPassive) {
            const loss_db = parseFloat(specsDict.loss_db || 0.0);
            gain_db = -loss_db;
            nf_db = loss_db; 
            op1db_dbm = 99.0;
            storage['loss_db'] = loss_db;
        } else { 
            gain_db = parseFloat(specsDict.gain_db || 0.0);
            nf_db = parseFloat(specsDict.nf_db || 0.0);
            if (mode === "RX") op1db_dbm = 99.0;
            else op1db_dbm = parseFloat(specsDict.op1db_dbm || 99.0);
            
            const oip3_dbm = parseFloat(specsDict.oip3_dbm || 99.0);
            storage['gain_db'] = gain_db;
            storage['nf_db'] = nf_db;
            storage['op1db_dbm'] = op1db_dbm;
            storage['active_gain_db'] = parseFloat(specsDict.active_gain_db || 0.0);
            storage['passive_gain_db'] = parseFloat(specsDict.passive_gain_db || 0.0);
            storage['system_gain_db'] = parseFloat(specsDict.system_gain_db || 0.0);
        }
        storage['gain_db'] = gain_db;
        storage['nf_db'] = nf_db;
        storage['op1db_dbm'] = op1db_dbm;
        storage['gain_linear'] = db_to_linear(gain_db);
        storage['nf_linear'] = db_to_linear(nf_db);
        storage['op1db_mw'] = dbm_to_mw(op1db_dbm);
        return storage;
    }

    setSpecsForFreq(freqStr, mode, specsDict) {
        const freqKey = String(freqStr);
        if (!(freqKey in this.specsByFreq)) {
            this.specsByFreq[freqKey] = {
                "TX": this.calculateSpecs(freqKey, "TX", {}),
                "RX": this.calculateSpecs(freqKey, "RX", {})
            };
        }
        const calculatedSpec = this.calculateSpecs(freqKey, mode, specsDict);
        this.specsByFreq[freqKey][mode] = calculatedSpec;
    }

    getSpecsForFreq(freqStr, mode) {
        const freqKey = String(freqStr);
        if (!(freqKey in this.specsByFreq)) return null;
        return this.specsByFreq[freqKey][mode] || null;
    }

    getRawSpecsForFreq(freqStr, mode) {
        const specs = this.getSpecsForFreq(freqStr, mode);
        if (!specs) return {};
        if (this.isPassive) return { 'loss_db': specs.loss_db || 0.0 };
        else { 
            const raw = { 'gain_db': specs.gain_db || 0.0, 'nf_db': specs.nf_db || 0.0 };
            if (mode === "TX") raw['op1db_dbm'] = specs.op1db_dbm || 99.0;
            if(this.isMerged){
                raw['active_gain_db'] = specs.active_gain_db || 0.0;
                raw['passive_gain_db'] = specs.passive_gain_db || 0.0;
                raw['system_gain_db'] = specs.system_gain_db || 0.0;
            }
            return raw;
        }
    }

    getAvailableFreqs() { return Object.keys(this.specsByFreq).sort((a, b) => parseFloat(a) - parseFloat(b)); }
    getDisplayName() { return this.name; }
    
    getDisplaySpecs() {
        const freqList = this.getAvailableFreqs();
        if (freqList.length === 0) return "(No Freq)";
        const displayFreqs = freqList.slice(0, 3);
        const suffix = (freqList.length > 3) ? "..." : "";
        return `(${displayFreqs.join(', ')}${suffix} GHz)`;
    }

    getDisplaySpecsLines(freq, mode) {
        let lines = [];
        if (!freq || !mode) return lines;
        const specs = this.getSpecsForFreq(freq, mode);
        if (!specs) return [`(${freq} GHz Undefined)`];

        if (this.isPassive) {
            if (this.isAirLoss) {
                if (this.airLossConfig.mode === 'calc') lines.push(`Dist: ${this.airLossConfig.dist_cm} cm`);
                else lines.push(`(Manual Loss)`);
            }
            lines.push(`L: ${formatNum(specs.loss_db, 1)} dB`);
            lines.push(`NF: ${formatNum(specs.nf_db, 1)} dB`);
        } else if (this.isSystem) {
            return [`G: ${formatNum(specs.gain_db, 1)} dB`, `NF: ${formatNum(specs.nf_db, 1)} dB`];
        } else {
            if (this.isMerged) {
                lines.push(`G_total: ${formatNum(specs.gain_db, 1)} dB`);
                lines.push(`(Pas:${formatNum(specs.passive_gain_db, 1)})`);
                lines.push(`NF: ${formatNum(specs.nf_db, 1)} dB`);
                if (mode === "TX") lines.push(`OP1dB: ${formatNum(specs.op1db_dbm, 1)} dBm`);
            } else {
                lines.push(`G: ${formatNum(specs.gain_db, 1)} dB`);
                lines.push(`NF: ${formatNum(specs.nf_db, 1)} dB`);
                if (mode === "TX") lines.push(`OP1dB: ${formatNum(specs.op1db_dbm, 1)} dBm`);
            }
        }
        return lines;
    }

    toDict() {
        const specsToSave = {};
        for (const [freq, modes] of Object.entries(this.specsByFreq)) {
            specsToSave[freq] = { "TX": this.getRawSpecsForFreq(freq, "TX"), "RX": this.getRawSpecsForFreq(freq, "RX") };
        }
        return {
            'name': this.name, 'isPassive': this.isPassive, 'isSystem': this.isSystem,
            'isAirLoss': this.isAirLoss, 'isArray': this.isArray,
            'airLossConfig': this.airLossConfig, 'arrayConfig': this.arrayConfig,
            'specs_by_freq': specsToSave, 'isMerged': this.isMerged, 'childrenData': this.childrenData 
        };
    }
    
    static fromDict(data) {
        const name = data.name || 'LoadedComp';
        const comp = new RFComponent(name, data.isPassive, data.isSystem, data.specs_by_freq, data.isAirLoss, data.isArray);
        if (data.airLossConfig) comp.airLossConfig = data.airLossConfig;
        if (data.arrayConfig) comp.arrayConfig = data.arrayConfig;
        comp.isMerged = data.isMerged || false;
        comp.childrenData = data.childrenData || [];
        return comp;
    }
}

// ============================================================================
// 3. 計算引擎 (RFLInkBudget)
// ============================================================================
class RFLInkBudget {
    constructor() {
        this.chain = [];
        this.systemParams = {};
        this.results = {};
        this.cascadeTable = [];
        this.T0 = 290.0;
        this.calcLog = []; 
    }
    setSystemParams(pInTx, pInRx) { this.systemParams = { 'p_in_tx': pInTx, 'p_in_rx': pInRx }; }
    clear() { this.chain = []; this.results = {}; this.cascadeTable = []; this.calcLog = []; }
    getCalcLog() { return this.calcLog.join('\n'); }
    setChain(sortedChain) { this.chain = sortedChain; }

    calculate(calcFreqStr, mode = "TX") {
        if (!this.chain || this.chain.length === 0) throw new Error("No components in chain.");
        calcFreqStr = String(calcFreqStr);
        this.calcLog = [];
        this.calcLog.push(`*** ${mode} Mode @ ${calcFreqStr} GHz ***`);
        this.calcLog.push(`============================`);
        this.chain.forEach(c => c.runtimeResults = null);

        let cumulative_gain_linear = 1.0;
        let cumulative_nf_linear = 0.0;
        let cumulative_gain_linear_for_nf = 1.0; 
        let nf_cascade_started = false; 
        
        let total_active_gain_db = 0.0, total_passive_gain_db = 0.0, total_system_gain_db = 0.0;
        let cumulative_pout_dbm = (mode === "TX") ? (this.systemParams.p_in_tx || -18.5) : (this.systemParams.p_in_rx || -100.0);

        this.calcLog.push(`[Info] ${mode} Mode: P_in = ${formatNum(cumulative_pout_dbm, 2)} dBm\n`);
        this.cascadeTable = []; this.results = {};

        for (let i = 0; i < this.chain.length; i++) {
            const comp = this.chain[i];
            const specs = comp.getSpecsForFreq(calcFreqStr, mode);
            if (!specs) throw new Error(`Component '${comp.name}' missing specs for '${calcFreqStr} GHz'.`);
            
            this.calcLog.push(`--- (S${i + 1}) ${comp.name} ---`);
            const stage_gain_db = specs['gain_db'];
            const stage_op1db_dbm = specs['op1db_dbm'] || 99.0;
            const stage_pin_dbm = cumulative_pout_dbm;
            cumulative_pout_dbm = stage_pin_dbm + stage_gain_db;
            
            comp.runtimeResults = { freq: calcFreqStr, mode: mode, pin_dbm: stage_pin_dbm, pout_dbm: cumulative_pout_dbm };

            if (comp.isPassive) total_passive_gain_db += stage_gain_db;
            else if (comp.isSystem) total_system_gain_db += stage_gain_db;
            else total_active_gain_db += stage_gain_db;

            this.calcLog.push(`  G_cum: ${formatNum(stage_pin_dbm, 2)} + ${formatNum(stage_gain_db, 2)} = ${formatNum(cumulative_pout_dbm, 2)} dBm`);

            const comp_gain_linear = specs['gain_linear'];
            const comp_nf_linear = specs['nf_linear'] ?? 1.0; 
            let is_first_nf_stage = false;

            if (mode === "RX") {
                if (comp.isSystem) this.calcLog.push(`  NF_cum: (Antenna, Skip NF calc)`);
                else if (!nf_cascade_started) { nf_cascade_started = true; is_first_nf_stage = true; }
            } else { 
                if (i === 0) is_first_nf_stage = true;
                nf_cascade_started = true;
            }

            if (nf_cascade_started) {
                if (is_first_nf_stage) {
                    cumulative_nf_linear = comp_nf_linear;
                    cumulative_gain_linear_for_nf = comp_gain_linear; 
                } else {
                    const F_contrib = (comp_nf_linear - 1) / cumulative_gain_linear_for_nf;
                    cumulative_nf_linear += F_contrib;
                    cumulative_gain_linear_for_nf *= comp_gain_linear; 
                }
                this.calcLog.push(`  NF_cum [dB]: ${formatNum(linear_to_db(cumulative_nf_linear), 2)} dB`);
            }
            cumulative_gain_linear *= comp_gain_linear;
            this.calcLog.push(``);

            this.cascadeTable.push({
                "Stage": `(${i + 1}) ${comp.name}`,
                "Cum. Gain (dB)": linear_to_db(cumulative_gain_linear),
                "Cum. NF (dB)": (nf_cascade_started) ? linear_to_db(cumulative_nf_linear) : 0.0,
                "Cum. Pout (dBm)": cumulative_pout_dbm
            });

            if (mode === "TX" && cumulative_pout_dbm > stage_op1db_dbm) {
                if (!comp.isSystem) { 
                    throw new CompressionError(`Component '${comp.name}' P1dB Compressed!\nPout: ${cumulative_pout_dbm.toFixed(2)} dBm > P1dB: ${stage_op1db_dbm.toFixed(2)}`, comp);
                }
            }
        } 

        let gain_from_end = 1.0, total_op1db_inv_mw = 0.0;
        if (mode === "TX") {
            for (let i = this.chain.length - 1; i >= 0; i--) {
                const comp = this.chain[i];
                const specs = comp.getSpecsForFreq(calcFreqStr, mode);
                if (!comp.isSystem) total_op1db_inv_mw += 1.0 / (specs['op1db_mw'] * gain_from_end);
                gain_from_end *= specs['gain_linear'];
            }
        }
        const total_op1db_mw = (total_op1db_inv_mw > 0) ? (1.0 / total_op1db_inv_mw) : Infinity;

        let g_ant_db = 0.0, t_ant = 0.0, t_rx = 0.0, t_sys = 0.0, g_over_t = -Infinity;
        const nf_total_db = (nf_cascade_started) ? linear_to_db(cumulative_nf_linear) : 0.0;

        if (mode === "RX") {
            this.calcLog.push(`--- (G/T) System Calculation ---`);
            for (const comp of this.chain) { 
                if (comp.isSystem) {
                    const specs = comp.getSpecsForFreq(calcFreqStr, mode); 
                    if (specs) g_ant_db += specs.gain_db;
                } else break;
            }
            t_ant = this.T0;
            const f_total = db_to_linear(nf_total_db);
            t_rx = this.T0 * (f_total - 1);
            t_sys = t_ant + t_rx;
            const t_sys_dbk = (t_sys > 0) ? (10 * Math.log10(t_sys)) : -Infinity;
            g_over_t = g_ant_db - t_sys_dbk;
            this.calcLog.push(`  G_ant: ${formatNum(g_ant_db, 2)} dB, T_sys: ${formatNum(t_sys, 2)} K`);
            this.calcLog.push(`  G/T: ${formatNum(g_over_t, 2)} dB/K\n`);
        }

        this.results['chain'] = {
            'total_gain_db': linear_to_db(cumulative_gain_linear),
            'total_nf_db': nf_total_db,
            'total_op1db_dbm': mw_to_dbm(total_op1db_mw),
            'final_pout_dbm': cumulative_pout_dbm,
            'total_active_gain_db': total_active_gain_db,
            'total_passive_gain_db': total_passive_gain_db,
            'total_system_gain_db': total_system_gain_db,
            'g_ant_db': g_ant_db, 't_ant': t_ant, 't_rx': t_rx, 't_sys': t_sys, 'g_over_t': g_over_t
        };
    }

    getReport(calcFreqStr, mode = "TX") {
        const p_in_dbm = (mode === "TX") ? (this.systemParams.p_in_tx || 0) : (this.systemParams.p_in_rx || 0);
        const chain_res = this.results.chain;
        if (!chain_res) return "Not Calculated Yet.";

        const total_gain_db = chain_res['total_gain_db'];
        const total_positive_gain_db = chain_res['total_active_gain_db'] + chain_res['total_system_gain_db'];
        const total_passive_gain_db = chain_res['total_passive_gain_db'];
        
        let report_str = "======================================================================\n";
        report_str += `--- 📈 1. Cascaded Link Analysis (@ ${calcFreqStr} GHz, Mode: ${mode}) ---\n`;
        report_str += "======================================================================\n";
        
        const w1=35, w2=15;
        if (mode === "TX") {
            report_str += "Stage".padEnd(w1) + "| " + "Gain(dB)".padStart(w2) + "| " + "NF(dB)".padStart(w2) + "| " + "Pout(dBm)".padStart(w2) + "\n";
            report_str += "-".repeat(90) + "\n";
            for (const s of this.cascadeTable) {
                report_str += s['Stage'].padEnd(w1) + "| " + formatNum(s['Cum. Gain (dB)'], 2).padStart(w2) + "| " + formatNum(s['Cum. NF (dB)'], 2).padStart(w2) + "| " + formatNum(s['Cum. Pout (dBm)'], 2).padStart(w2) + "\n";
            }
        } else {
            report_str += "Stage".padEnd(w1) + "| " + "Gain(dB)".padStart(w2) + "| " + "NF(dB)".padStart(w2) + "\n";
            report_str += "-".repeat(70) + "\n";
            for (const s of this.cascadeTable) {
                report_str += s['Stage'].padEnd(w1) + "| " + formatNum(s['Cum. Gain (dB)'], 2).padStart(w2) + "| " + formatNum(s['Cum. NF (dB)'], 2).padStart(w2) + "\n";
            }
        }
        report_str += "\n" + "=".repeat(50) + "\n";

        if (mode === "TX") {
            report_str += `--- 🛰️ 2. System Summary (TX @ ${calcFreqStr} GHz) ---\n` + "=".repeat(50) + "\n";
            report_str += `  Input Power (P_in):         ${formatNum(p_in_dbm, 2).padStart(7)} dBm\n`;
            report_str += `  Total System Gain:          ${formatNum(total_gain_db, 2).padStart(7)} dB\n`;
            report_str += `    (Active/Sys Gain):        ${formatNum(total_positive_gain_db, 2).padStart(7)} dB\n`;
            report_str += `    (Passive Loss):           ${formatNum(total_passive_gain_db, 2).padStart(7)} dB\n`;
            report_str += "  --------------------------------------------------\n";
            report_str += `  **Output Power (P_out):** **${formatNum(chain_res['final_pout_dbm'], 2).padStart(7)} dBm**\n`;
        } else {
            const g_ant_db = chain_res['g_ant_db'];
            const t_ant = chain_res['t_ant'];
            const nf_total_db = chain_res['total_nf_db'];
            const t_rx = chain_res['t_rx'];
            const t_sys = chain_res['t_sys'];
            const g_over_t = chain_res['g_over_t'];
            const t_sys_dbk = (t_sys > 0) ? (10 * Math.log10(t_sys)) : -Infinity;

            report_str += `--- 🛰️ 2. System Summary (RX G/T @ ${calcFreqStr} GHz) ---\n` + "=".repeat(50) + "\n";
            report_str += `  Antenna Gain (G_ant) [Auto]:  ${formatNum(g_ant_db, 2).padStart(7)} dB\n`;
            report_str += `  Antenna Noise Temp (T_ant):   ${formatNum(t_ant, 2).padStart(7)} K\n`;
            report_str += `  Link Total Noise (NF_total):  ${formatNum(nf_total_db, 2).padStart(7)} dB\n`;
            report_str += `  Link Total Gain (G_link):     ${formatNum(total_gain_db, 2).padStart(7)} dB\n`;
            report_str += `    (Active/Sys Gain):          ${formatNum(total_positive_gain_db, 2).padStart(7)} dB\n`;
            report_str += `    (Passive Loss):             ${formatNum(total_passive_gain_db, 2).padStart(7)} dB\n`;
            report_str += `  Receiver Noise Temp (T_rx):   ${formatNum(t_rx, 2).padStart(7)} K\n`;
            report_str += `  System Noise Temp (T_sys):    ${formatNum(t_sys, 2).padStart(7)} K (${formatNum(t_sys_dbk, 2)} dBK)\n`;
            report_str += "  --------------------------------------------------\n";
            report_str += `  **System G/T:** **${formatNum(g_over_t, 2).padStart(7)} dB/K**\n`;
        }
        return report_str;
    }
}

// ============================================================================
// 4. GUI 控制邏輯與事件綁定
// ============================================================================

// 4.1 核心操作函式
function addBlock(name, isPassive, isSystem, defaultSpecs, isAirLoss = false, isArray = false) {
    const comp = new RFComponent(name, isPassive, isSystem, defaultSpecs, isAirLoss, isArray);
    const viewCenterX = (canvasWidth / 2 - canvasPan.x) / canvasZoom;
    const viewCenterY = (canvasHeight / 2 - canvasPan.y) / canvasZoom;
    comp.x = viewCenterX - comp.width / 2 + (Math.random() - 0.5) * 50;
    comp.y = viewCenterY - comp.height / 2 + (Math.random() - 0.5) * 50;
    blocks.push(comp);
    drawCanvas();
}

function calculateLink() {
    dragData.item = null; clearAllHighlights(); poutLabels = [];
    try {
        let sortedChain = topologicalSortChain(); if (!sortedChain) return;
        const calcFreq = dom.entryFreq.value; if (!calcFreq) { alert("Please enter Frequency (GHz)"); dom.entryFreq.focus(); return; }
        const calcFreqStr = String(calcFreq); 
        const p_in_tx = parseFloat(dom.entryPin.value) || -18.5; 
        const p_in_rx = parseFloat(dom.entryRxPin.value) || -100.0;
        
        calculator.setSystemParams(p_in_tx, p_in_rx); 
        calculator.setChain(sortedChain); 
        calculator.calculate(calcFreqStr, currentCalcMode);
        
        const report = calculator.getReport(calcFreqStr, currentCalcMode); 
        const calcLog = calculator.getCalcLog(); 
        dom.resultText.textContent = report; 
        dom.calcLogText.textContent = calcLog; 
        lastCalcFreq = calcFreqStr; lastCalcMode = currentCalcMode;
        if (currentCalcMode === "TX") drawPoutLabels(); else drawCanvas(); 
    } catch (e) { 
        if (e instanceof CompressionError) { alert(`Calculaton Error (P1dB):\n${e.message}`); highlightBlock(e.component, "red"); } 
        else { alert(`Calculaton Error: ${e.message}`); console.error(e); } 
    }
}

function topologicalSortChain() {
    const allCompsInMap = new Set(); const allBlocksInCurrentChain = new Set();
    for (const [fromId, toId] of currentConnections.entries()) { allCompsInMap.add(fromId); allCompsInMap.add(toId); allBlocksInCurrentChain.add(fromId); allBlocksInCurrentChain.add(toId); }
    const allBlocksInMapAsObjs = new Set(blocks.filter(b => allBlocksInCurrentChain.has(b.id)));
    const destinationComps = new Set(); for (const toId of currentConnections.values()) destinationComps.add(toId);
    const startNodes = new Set(); for (const comp of allBlocksInMapAsObjs) if (!destinationComps.has(comp.id)) startNodes.add(comp.id);
    if (allBlocksInMapAsObjs.size === 0) { alert(`No connected blocks found in ${currentCalcMode} mode.`); return null; }
    if (startNodes.size === 0) { alert(`Topology Error: No start node found in ${currentCalcMode} mode (Loop detected?).`); return null; }
    const startNodeId = [...startNodes][0]; const sortedChain = []; let currentId = startNodeId;
    while (currentId) { const currentComp = blocks.find(b => b.id === currentId); if (!currentComp) break; if (sortedChain.includes(currentComp)) { alert(`Topology Error: Loop detected!`); return null; } sortedChain.push(currentComp); currentId = currentConnections.get(currentId); }
    return sortedChain;
}

function onMergeComponents() {
    if (!isMergeSelectMode) {
        isMergeSelectMode = true; mergeSelection = []; clearAllSelections(); 
        dom.mergeButton.textContent = "Finish Merge";
        alert(`Merge Mode: Select components in sequence, then click 'Finish Merge'.`);
    } else {
        isMergeSelectMode = false; dom.mergeButton.textContent = "Merge Components";
        try { executeMerge(mergeSelection); } finally { mergeSelection = []; clearAllSelections(); drawCanvas(); }
    }
}

function executeMerge(selectedIds) {
    if (selectedIds.length < 2) { alert("Merge Error: Select at least 2 components."); return; }
    const selectedComps = blocks.filter(b => selectedIds.includes(b.id));
    try {
        const sortedChain = topologicalSortComponents(selectedComps, currentConnections);
        const allFreqs = new Set(); sortedChain.forEach(c => c.getAvailableFreqs().forEach(f => allFreqs.add(f)));
        if (allFreqs.size === 0) throw new Error("No frequency data found in selected components.");
        const validFreqs = [];
        for (const freq of allFreqs) {
            let isFreqCommon = true;
            for (const comp of sortedChain) { if (!comp.getSpecsForFreq(freq, "TX") || !comp.getSpecsForFreq(freq, "RX")) { isFreqCommon = false; break; } }
            if (isFreqCommon) validFreqs.push(freq);
        }
        if (validFreqs.length === 0) throw new Error("Merge Failed: No common frequencies found.");
        
        const newName = prompt("Enter name for merged component:", "Merged-" + sortedChain[0].name); if (!newName) return; 
        const newSpecsByFreq = {}; const tempCalculator = new RFLInkBudget();
        for (const freq of validFreqs) {
            tempCalculator.setChain(sortedChain); tempCalculator.setSystemParams(-100); 
            tempCalculator.calculate(freq, "TX"); const txRes = tempCalculator.results.chain;
            tempCalculator.calculate(freq, "RX"); const rxRes = tempCalculator.results.chain;
            newSpecsByFreq[freq] = {
                "TX": { 'gain_db': txRes.total_gain_db, 'nf_db': txRes.total_nf_db, 'op1db_dbm': txRes.total_op1db_dbm, 'active_gain_db': txRes.total_active_gain_db, 'passive_gain_db': txRes.total_passive_gain_db, 'system_gain_db': txRes.total_system_gain_db },
                "RX": { 'gain_db': rxRes.total_gain_db, 'nf_db': rxRes.total_nf_db, 'op1db_dbm': rxRes.total_op1db_dbm, 'active_gain_db': rxRes.total_active_gain_db, 'passive_gain_db': rxRes.total_passive_gain_db, 'system_gain_db': rxRes.total_system_gain_db }
            };
        }
        const startComp = sortedChain[0]; const endComp = sortedChain[sortedChain.length - 1];
        let inKeyTX=null, outKeyTX=null, inKeyRX=null, outKeyRX=null;
        outKeyTX = connections_TX.get(endComp.id); outKeyRX = connections_RX.get(endComp.id);
        for (const [from, to] of connections_TX.entries()) if (to === startComp.id) inKeyTX = from;
        for (const [from, to] of connections_RX.entries()) if (to === startComp.id) inKeyRX = from;
        
        const mergedComp = new RFComponent(newName, false, false, newSpecsByFreq);
        mergedComp.x = startComp.x; mergedComp.y = startComp.y; mergedComp.isMerged = true;
        mergedComp.childrenData = sortedChain.map(c => c.toDict());
        blocks.push(mergedComp);
        
        const selectedIdsSet = new Set(selectedIds);
        blocks = blocks.filter(b => !selectedIdsSet.has(b.id));
        [connections_TX, connections_RX].forEach(map => {
            selectedIds.forEach(id => map.delete(id));
            for (const [from, to] of map.entries()) if (selectedIdsSet.has(to)) map.delete(from);
        });
        if (inKeyTX) connections_TX.set(inKeyTX, mergedComp.id); if (outKeyTX) connections_TX.set(mergedComp.id, outKeyTX);
        if (inKeyRX) connections_RX.set(inKeyRX, mergedComp.id); if (outKeyRX) connections_RX.set(mergedComp.id, outKeyRX);
        alert(`Component "${newName}" merged successfully!`);
    } catch (e) { alert(`Merge Failed: ${e.message}`); }
}

function topologicalSortComponents(components, connections) {
    const compIds = new Set(components.map(c => c.id)); const inDegree = new Map(); const adj = new Map();
    components.forEach(c => { inDegree.set(c.id, 0); adj.set(c.id, []); });
    for (const [fromId, toId] of connections.entries()) {
        if (compIds.has(fromId) && compIds.has(toId)) { adj.get(fromId).push(toId); inDegree.set(toId, inDegree.get(toId) + 1); }
    }
    const queue = [];
    for (const [id, degree] of inDegree.entries()) if (degree === 0) queue.push(id);
    if (queue.length !== 1) throw new Error("Merge Error: Components must form a single continuous chain.");
    const sortedIds = [];
    while (queue.length > 0) {
        const u = queue.shift(); sortedIds.push(u);
        for (const v of adj.get(u)) { inDegree.set(v, inDegree.get(v) - 1); if (inDegree.get(v) === 0) queue.push(v); }
    }
    if (sortedIds.length !== components.length) throw new Error("Merge Error: Loop detected or discontinuous chain.");
    return sortedIds.map(id => components.find(c => c.id === id));
}

function resizeCanvas() { drawCanvas(); }

function clearAllLines() {
    if (confirm(`Clear all connections in ${currentCalcMode} mode?`)) { currentConnections.clear(); poutLabels = []; lastCalcFreq = null; dom.resultText.textContent = `(${currentCalcMode} connections cleared)`; dom.calcLogText.textContent = ""; drawCanvas(); }
}
function clearAll() {
    if (confirm("Clear all components and connections?")) { calculator.clear(); blocks = []; connections_TX.clear(); connections_RX.clear(); poutLabels = []; canvasZoom = 1.0; canvasPan = {x:0, y:0}; lastCalcFreq = null; dom.resultText.textContent = "(Not Calculated)"; dom.calcLogText.textContent = ""; drawCanvas(); }
}
function exportFullReport() {
    if (!lastCalcFreq || !calculator.results.chain) { alert("Please Calculate first."); return; }
    let imgDataUrl; try { const backup = poutLabels; poutLabels = []; drawCanvas(); imgDataUrl = canvas.toDataURL('image/png'); poutLabels = backup; drawCanvas(); } catch (e) { alert("Screenshot failed"); return; }
    const htmlTemplate = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>RF Report</title><style>body{font-family:sans-serif;background:#2B2B2B;color:#DDD;padding:20px;}img{border:1px solid #777;max-width:100%;}pre{background:#222;padding:10px;overflow:auto;}</style></head><body><h1>RF Link Budget Report</h1><img src="${imgDataUrl}"><h3>Results</h3><pre>${dom.resultText.textContent}</pre><h3>Log</h3><pre>${dom.calcLogText.textContent}</pre></body></html>`;
    const blob = new Blob([htmlTemplate], {type: 'text/html'}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `RF_Report.html`; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
function loadComponentFromFile(e) {
    const files = e.target.files; if (!files.length) return;
    Array.from(files).forEach((file, i) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result); const comp = RFComponent.fromDict(data);
                comp.x = 100 + (i*20); comp.y = 100 + (i*20); blocks.push(comp); drawCanvas();
            } catch(err) { alert("Load Failed: " + file.name); }
        }; reader.readAsText(file);
    }); dom.fileLoaderInput.value = null;
}

function onTabChange(e) {
    const targetTab = e.target.dataset.tab;
    dom.tabButtons.forEach(btn => btn.classList.remove('active')); e.target.classList.add('active');
    dom.tabContents.forEach(content => { content.classList.remove('active'); if (content.id === targetTab) content.classList.add('active'); });
    currentCalcMode = (targetTab === 'tx-tab') ? "TX" : "RX";
    if (currentCalcMode === "TX") currentConnections = connections_TX; else currentConnections = connections_RX;
    if (lastCalcFreq) lastCalcMode = currentCalcMode;
    if (currentCalcMode !== "TX") poutLabels = [];
    drawCanvas();
}

// 4.2 編輯視窗邏輯
function openEditModal(comp) {
    editingComp = comp; editingSpecsCopy = JSON.parse(JSON.stringify(comp.specsByFreq)); editingCurrentFreq = null;
    dom.modalTitle.textContent = `Edit Component: ${comp.name}`; dom.modalCompName.value = comp.name;
    modalRefreshFreqList();
    if (dom.modalFreqList.options.length > 0) { dom.modalFreqList.selectedIndex = 0; modalOnFreqSelect(); } else modalToggleSpecEntries(false);
    dom.modal.style.display = 'flex';
}
function closeEditModal() { dom.modal.style.display = 'none'; editingComp = null; editingSpecsCopy = null; editingCurrentFreq = null; }
function saveEditModal() {
    if (editingCurrentFreq) if (!modalSaveSpecsFromEntries(editingCurrentFreq)) return;
    const newName = dom.modalCompName.value; if (!newName) { alert("Name cannot be empty."); return; }
    editingComp.name = newName; if (!editingComp.isMerged) editingComp.specsByFreq = JSON.parse(JSON.stringify(editingSpecsCopy));
    closeEditModal(); drawCanvas();
}
function modalRefreshFreqList() { dom.modalFreqList.innerHTML = ""; const freqs = Object.keys(editingSpecsCopy).sort((a, b) => parseFloat(a) - parseFloat(b)); freqs.forEach(freq => { const option = document.createElement('option'); option.value = freq; option.textContent = freq; dom.modalFreqList.appendChild(option); }); }
function modalOnFreqSelect() {
    if (editingCurrentFreq) if (!modalSaveSpecsFromEntries(editingCurrentFreq)) { dom.modalFreqList.value = editingCurrentFreq; return; }
    const selectedFreq = dom.modalFreqList.value;
    if (selectedFreq) { editingCurrentFreq = selectedFreq; modalToggleSpecEntries(true); if (!editingComp.isMerged) modalLoadSpecsToEntries(selectedFreq); } else { editingCurrentFreq = null; modalToggleSpecEntries(false); }
}
function modalAddFreq() {
    if (editingComp.isMerged) { alert("Cannot add frequency to merged component."); return; }
    const newFreq = prompt("Enter new frequency (GHz):"); if (!newFreq) return;
    try {
        parseFloat(newFreq); const newFreqStr = String(newFreq); if (newFreqStr in editingSpecsCopy) { alert("Frequency already exists."); return; }
        if (editingCurrentFreq) modalSaveSpecsFromEntries(editingCurrentFreq);
        let defaultSpecs = {}; if (editingComp.isPassive) defaultSpecs = { 'loss_db': 0.0 }; else defaultSpecs = { 'gain_db': 0.0, 'nf_db': 0.0, 'op1db_dbm': 99.0 };
        const tempComp = new RFComponent("temp", editingComp.isPassive, editingComp.isSystem);
        editingSpecsCopy[newFreqStr] = { "TX": tempComp.calculateSpecs(newFreqStr, "TX", defaultSpecs), "RX": tempComp.calculateSpecs(newFreqStr, "RX", defaultSpecs) };
        modalRefreshFreqList(); dom.modalFreqList.value = newFreqStr; modalOnFreqSelect();
    } catch (e) { alert("Invalid number."); }
}
function modalDelFreq() {
    if (editingComp.isMerged) return; if (!editingCurrentFreq) return; if (Object.keys(editingSpecsCopy).length <= 1) return;
    if (confirm(`Delete ${editingCurrentFreq} GHz?`)) { delete editingSpecsCopy[editingCurrentFreq]; editingCurrentFreq = null; modalRefreshFreqList(); dom.modalFreqList.selectedIndex = 0; modalOnFreqSelect(); }
}
function modalSaveSpecsFromEntries(freqStr) {
    if (editingComp.isMerged) return true; if (!freqStr) return true;
    try {
        const fullSpecsDict = {};
        if (editingComp.isAirLoss) {
            const mode = editingComp.airLossConfig.mode; let loss_db = 0.0;
            if (mode === 'calc') {
                const distInput = document.getElementById('airloss-dist');
                let distCm = parseFloat(distInput ? distInput.value : editingComp.airLossConfig.dist_cm);
                if (isNaN(distCm) || distCm < 0) distCm = 0;
                editingComp.airLossConfig.dist_cm = distCm;
                loss_db = calculateFSPL(parseFloat(freqStr), distCm);
            } else { loss_db = parseFloat(document.getElementById('spec-tx-loss_db').value || 0.0); }
            const tempComp = new RFComponent("temp", true, false); 
            fullSpecsDict["TX"] = tempComp.calculateSpecs(freqStr, "TX", { 'loss_db': loss_db }); fullSpecsDict["RX"] = fullSpecsDict["TX"];
            editingSpecsCopy[freqStr] = fullSpecsDict; return true;
        }
        if (editingComp.isPassive) {
            const txLoss = parseFloat(document.getElementById('spec-tx-loss_db').value || 0.0);
            const rxLoss = parseFloat(document.getElementById('spec-rx-loss_db').value || 0.0);
            const tempComp = new RFComponent("temp", editingComp.isPassive, false);
            fullSpecsDict["TX"] = tempComp.calculateSpecs(freqStr, "TX", { 'loss_db': txLoss });
            fullSpecsDict["RX"] = tempComp.calculateSpecs(freqStr, "RX", { 'loss_db': rxLoss });
        } else {
            let txSpecs = {}, rxSpecs = {};
            if (editingComp.isSystem) {
                txSpecs = { 'gain_db': parseFloat(document.getElementById('spec-tx-gain_db').value || 0.0), 'nf_db': 0.0, 'op1db_dbm': 99.0 };
                rxSpecs = { 'gain_db': parseFloat(document.getElementById('spec-rx-gain_db').value || 0.0), 'nf_db': 0.0 };
            } else {
                txSpecs = { 'gain_db': parseFloat(document.getElementById('spec-tx-gain_db').value || 0.0), 'nf_db': parseFloat(document.getElementById('spec-tx-nf_db').value || 0.0), 'op1db_dbm': parseFloat(document.getElementById('spec-tx-op1db_dbm').value || 99.0) };
                rxSpecs = { 'gain_db': parseFloat(document.getElementById('spec-rx-gain_db').value || 0.0), 'nf_db': parseFloat(document.getElementById('spec-rx-nf_db').value || 0.0) };
            }
            const tempComp = new RFComponent("temp", false, editingComp.isSystem);
            fullSpecsDict["TX"] = tempComp.calculateSpecs(freqStr, "TX", txSpecs); fullSpecsDict["RX"] = tempComp.calculateSpecs(freqStr, "RX", rxSpecs);
        }
        editingSpecsCopy[freqStr] = fullSpecsDict; return true;
    } catch (e) { alert("Invalid input."); return false; }
}
function modalLoadSpecsToEntries(freqStr) {
    if (editingComp.isMerged) return; if (editingComp.isAirLoss) return;
    const freqData = editingSpecsCopy[freqStr]; if (!freqData) return;
    const tempComp = new RFComponent("temp", editingComp.isPassive, editingComp.isSystem); tempComp.specsByFreq = editingSpecsCopy;
    const txRaw = tempComp.getRawSpecsForFreq(freqStr, "TX"); const rxRaw = tempComp.getRawSpecsForFreq(freqStr, "RX");
    if (editingComp.isPassive) { 
        const txInput = document.getElementById('spec-tx-loss_db');
        const rxInput = document.getElementById('spec-rx-loss_db');
        if (txInput) txInput.value = txRaw.loss_db;
        if (rxInput) rxInput.value = (rxRaw.loss_db !== undefined) ? rxRaw.loss_db : txRaw.loss_db;
    } else {
        if (editingComp.isSystem) {
            document.getElementById('spec-tx-gain_db').value = txRaw.gain_db; document.getElementById('spec-rx-gain_db').value = rxRaw.gain_db;
        } else {
            document.getElementById('spec-tx-gain_db').value = txRaw.gain_db; document.getElementById('spec-tx-nf_db').value = txRaw.nf_db; document.getElementById('spec-tx-op1db_dbm').value = txRaw.op1db_dbm;
            document.getElementById('spec-rx-gain_db').value = rxRaw.gain_db; document.getElementById('spec-rx-nf_db').value = rxRaw.nf_db;
        }
    }
}
function modalToggleSpecEntries(freqSelected) {
    dom.modalSpecEditors.innerHTML = "";
    if (!freqSelected) { dom.modalSpecEditors.innerHTML = `<div id="spec-status-label">Select or add a frequency</div>`; return; }
    dom.modalSpecEditors.innerHTML = `<div id="spec-status-label" style="margin-bottom: 10px;">Editing: ${editingCurrentFreq} GHz</div>`;
    if (editingComp && editingComp.isMerged) dom.modalSpecEditors.innerHTML += `<div style="color: #C8A2C8; font-weight: bold; margin-bottom: 10px;">Merged Component (Read-Only)</div>`;

    if (editingComp.isAirLoss) {
            const fieldset = document.createElement('fieldset');
            fieldset.innerHTML = `<legend>Air Loss 設定</legend>`;
            const mode = editingComp.airLossConfig.mode; const dist = editingComp.airLossConfig.dist_cm; const currentLoss = editingComp.getRawSpecsForFreq(editingCurrentFreq, "TX").loss_db || 0;
            fieldset.innerHTML += `<div style="margin-bottom: 10px;"><label>計算模式:</label><select id="airloss-mode-select" style="width: 100%; padding: 5px; margin-top: 5px;"><option value="calc" ${mode === 'calc' ? 'selected' : ''}>自動計算 (依距離)</option><option value="manual" ${mode === 'manual' ? 'selected' : ''}>手動輸入</option></select></div>`;
            if (mode === 'calc') fieldset.innerHTML += `<div class="spec-grid"><label for="airloss-dist">距離 (cm):</label><input type="number" id="airloss-dist" value="${dist}" step="1"><label>Loss (dB):</label><input type="text" id="airloss-calc-result" value="${formatNum(currentLoss, 2)}" disabled style="background:#444; color:#aaa;"></div>`;
            else fieldset.innerHTML += `<div class="spec-grid"><label for="spec-tx-loss_db">Loss (dB):</label><input type="text" id="spec-tx-loss_db" value="${currentLoss}"></div>`;
            dom.modalSpecEditors.appendChild(fieldset);
            document.getElementById('airloss-mode-select').addEventListener('change', (e) => { editingComp.airLossConfig.mode = e.target.value; modalToggleSpecEntries(editingCurrentFreq); });
            if (mode === 'calc') {
                const distInput = document.getElementById('airloss-dist'); const resultInput = document.getElementById('airloss-calc-result');
                if (distInput) distInput.addEventListener('input', () => { 
                    const val = parseFloat(distInput.value); if (!isNaN(val) && val >= 0) { 
                        resultInput.value = formatNum(calculateFSPL(parseFloat(editingCurrentFreq), val), 2); 
                    } else resultInput.value = "---"; 
                });
            }
            return; 
    }

    if (editingComp.isArray) {
        const arrDiv = document.createElement('div');
        arrDiv.className = 'array-calc-container';
        arrDiv.innerHTML = `
            <div style="margin-bottom: 8px; font-weight: bold; color: #A8E6CF;">陣列增益計算器 (10 log N)</div>
            <div class="array-calc-grid">
                <div><label>行數</label><input type="number" id="array-rows" value="${editingComp.arrayConfig.rows}" min="1"></div>
                <div><label>列數</label><input type="number" id="array-cols" value="${editingComp.arrayConfig.cols}" min="1"></div>
            </div>
            <div style="font-size: 11px; color: #888; margin-top: 4px;">修改將自動更新 Gain</div><hr style="border-color: #555; margin: 10px 0;">`;
        dom.modalSpecEditors.appendChild(arrDiv);
        const updateArrayGain = () => {
            const r = parseInt(document.getElementById('array-rows').value)||1, c = parseInt(document.getElementById('array-cols').value)||1;
            editingComp.arrayConfig.rows = r; editingComp.arrayConfig.cols = c;
            const gain = (r*c > 0) ? 10 * Math.log10(r*c) : 0;
            const tx = document.getElementById('spec-tx-gain_db'), rx = document.getElementById('spec-rx-gain_db');
            if(tx) tx.value = gain.toFixed(2); if(rx) rx.value = gain.toFixed(2);
        };
        setTimeout(() => { document.getElementById('array-rows').addEventListener('input', updateArrayGain); document.getElementById('array-cols').addEventListener('input', updateArrayGain); }, 0);
    }

    if (editingComp.isPassive) {
            const fieldset = document.createElement('fieldset');
            fieldset.innerHTML = `<legend>規格 (TX/RX 分開)</legend>`;
            const grid = document.createElement('div'); grid.className = 'spec-grid';
            grid.innerHTML = `<label>TX Loss (dB):</label><input type="text" id="spec-tx-loss_db"><label>RX Loss (dB):</label><input type="text" id="spec-rx-loss_db">`;
            fieldset.appendChild(grid); dom.modalSpecEditors.appendChild(fieldset);
    } else {
            dom.modalSpecEditors.innerHTML += `<div class="spec-tabs"><button class="spec-tab-btn active" data-tab="tx">TX</button><button class="spec-tab-btn" data-tab="rx">RX</button></div><div id="spec-tab-tx" class="spec-tab-content"></div><div id="spec-tab-rx" class="spec-tab-content hidden"></div>`;
            if (editingComp.isSystem) {
            document.getElementById('spec-tab-tx').innerHTML = `<div class="spec-grid"><label>Gain (dB):</label><input type="text" id="spec-tx-gain_db"></div>`;
            document.getElementById('spec-tab-rx').innerHTML = `<div class="spec-grid"><label>Gain (dB):</label><input type="text" id="spec-rx-gain_db"></div>`;
            } else {
            document.getElementById('spec-tab-tx').innerHTML = `<div class="spec-grid"><label>Gain (dB):</label><input type="text" id="spec-tx-gain_db"><label>NF (dB):</label><input type="text" id="spec-tx-nf_db"><label>P1dB (dBm):</label><input type="text" id="spec-tx-op1db_dbm"></div>`;
            document.getElementById('spec-tab-rx').innerHTML = `<div class="spec-grid"><label>Gain (dB):</label><input type="text" id="spec-rx-gain_db"><label>NF (dB):</label><input type="text" id="spec-rx-nf_db"></div>`;
            }
            dom.modalSpecEditors.querySelectorAll('.spec-tab-btn').forEach(btn => btn.addEventListener('click', (e) => {
            dom.modalSpecEditors.querySelectorAll('.spec-tab-btn').forEach(b => b.classList.remove('active'));
            dom.modalSpecEditors.querySelectorAll('.spec-tab-content').forEach(c => c.classList.add('hidden'));
            e.target.classList.add('active'); document.getElementById(`spec-tab-${e.target.dataset.tab}`).classList.remove('hidden');
            }));
    }
}

// 4.3 右鍵選單操作
function saveComponent() { 
    dom.blockContextMenu.style.display = 'none'; 
    if (!rightClickedComp) return; 
    const comp = rightClickedComp; const data = comp.toDict(); const jsonString = JSON.stringify(data, null, 4); const blob = new Blob([jsonString], { type: 'application/json' }); const defaultName = `${comp.name.replace(/ /g, "_").replace(/[()=]/g, "")}.json`; const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = prompt("Filename:", defaultName) || defaultName; document.body.appendChild(a); a.click(); document.body.removeChild(a); rightClickedComp = null; 
}

function deleteComponent() { 
    dom.blockContextMenu.style.display = 'none';
    if (!rightClickedComp) return; 
    const comp = rightClickedComp; 
    if (confirm(`Delete '${comp.name}'?`)) { 
            blocks = blocks.filter(b => b.id !== comp.id); 
            [connections_TX, connections_RX].forEach(map => { 
                map.delete(comp.id); let inKey = null; 
                for (const [fromId, toId] of map.entries()) { if (toId === comp.id) { inKey = fromId; break; } } 
                if (inKey) map.delete(inKey); 
            }); 
            poutLabels = []; drawCanvas(); 
    } 
    rightClickedComp = null; 
}

function deleteSelectedLine() { 
    dom.lineContextMenu.style.display = 'none';
    if (!rightClickedLine) return; 
    const { fromComp, toComp, lineId } = rightClickedLine; 
    if (confirm(`Delete connection?`)) { 
        if (currentConnections.has(lineId)) { currentConnections.delete(lineId); poutLabels = []; drawCanvas(); } 
    } 
    rightClickedLine = null; 
}

function duplicateComponent() { 
    dom.blockContextMenu.style.display = 'none';
    if (!rightClickedComp) return; 
    try { 
        const originalComp = rightClickedComp; const data = originalComp.toDict(); const newComp = RFComponent.fromDict(data); newComp.name = `${originalComp.name} (Copy)`; newComp.x = originalComp.x + 20; newComp.y = originalComp.y + 20; newComp.isSelected = false; newComp.isHighlighted = false; blocks.push(newComp); drawCanvas(); 
    } catch (e) {} 
    rightClickedComp = null; 
}

function unmergeComponent() { 
    dom.blockContextMenu.style.display = 'none';
    if (!rightClickedComp || !rightClickedComp.isMerged) return;
    const mergedComp = rightClickedComp; rightClickedComp = null; 
    if (!confirm(`Unmerge '${mergedComp.name}'?`)) return;
    try {
        const childrenData = mergedComp.childrenData; const newComps = []; let totalWidth = 0; const h_spacing = 30; 
        for (const childData of childrenData) { const newComp = RFComponent.fromDict(childData); newComp.isSelected = false; newComp.isHighlighted = false; newComps.push(newComp); totalWidth += newComp.width; }
        totalWidth += (newComps.length - 1) * h_spacing; let currentX = mergedComp.x + (mergedComp.width / 2) - (totalWidth / 2); const startY = mergedComp.y;
        for (const comp of newComps) { comp.x = currentX; comp.y = startY; currentX += comp.width + h_spacing; }
        let inKeyTX, outKeyTX, inKeyRX, outKeyRX; outKeyTX = connections_TX.get(mergedComp.id); outKeyRX = connections_RX.get(mergedComp.id);
        for (const [from, to] of connections_TX.entries()) if (to === mergedComp.id) inKeyTX = from;
        for (const [from, to] of connections_RX.entries()) if (to === mergedComp.id) inKeyRX = from;
        blocks = blocks.filter(b => b.id !== mergedComp.id); [connections_TX, connections_RX].forEach(map => { map.delete(mergedComp.id); let inKey; for (const [from, to] of map.entries()) if (to === mergedComp.id) inKey = from; if (inKey) map.delete(inKey); });
        blocks.push(...newComps); const firstChild = newComps[0]; const lastChild = newComps[newComps.length - 1];
        if (inKeyTX) connections_TX.set(inKeyTX, firstChild.id); if (outKeyTX) connections_TX.set(lastChild.id, outKeyTX);
        if (inKeyRX) connections_RX.set(inKeyRX, firstChild.id); if (outKeyRX) connections_RX.set(lastChild.id, outKeyRX);
        for (let i = 0; i < newComps.length - 1; i++) { connections_TX.set(newComps[i].id, newComps[i+1].id); connections_RX.set(newComps[i].id, newComps[i+1].id); }
        drawCanvas(); alert(`'${mergedComp.name}' 已成功拆分。`);
    } catch (e) { alert("拆分錯誤: " + e.message); }
}

// 4.4 畫布事件與繪圖 (Event Listeners & Drawing)
function onMouseDown(e) {
    dom.blockContextMenu.style.display = 'none'; dom.lineContextMenu.style.display = 'none';
    const { x, y } = getMousePos(e);
    if (e.button === 1) { panData.isPanning = true; panData.startX = e.clientX; panData.startY = e.clientY; canvas.classList.add('panning'); e.preventDefault(); return; }
    if (e.button === 0) {
        const clickedBlock = getBlockAtPos(x, y);
        if (isMergeSelectMode) {
            if (clickedBlock) {
                const idx = mergeSelection.indexOf(clickedBlock.id);
                if (idx > -1) { mergeSelection.splice(idx, 1); clickedBlock.isSelected = false; } else { mergeSelection.push(clickedBlock.id); clickedBlock.isSelected = true; }
                drawCanvas();
            } return;
        }
        if (!clickedBlock && !e.ctrlKey && !e.metaKey) clearAllSelections();
        if (e.ctrlKey || e.metaKey) {
            if (clickedBlock) {
                if (currentConnections.has(clickedBlock.id)) { alert("Output already occupied."); return; }
                lineData.startComp = clickedBlock; lineData.mouseX = x; lineData.mouseY = y;
            }
        } else if (clickedBlock) {
            clearAllSelections(); clickedBlock.isSelected = true; drawCanvas();
            dragData.item = clickedBlock; dragData.offsetX = x - clickedBlock.x; dragData.offsetY = y - clickedBlock.y;
            blocks = blocks.filter(b => b.id !== clickedBlock.id); blocks.push(clickedBlock);
        }
    }
}
function onMouseMove(e) {
    if (panData.isPanning) { canvasPan.x += e.clientX - panData.startX; canvasPan.y += e.clientY - panData.startY; panData.startX = e.clientX; panData.startY = e.clientY; drawCanvas(); return; }
    const { x, y } = getMousePos(e);
    if (dragData.item) { dragData.item.x = x - dragData.offsetX; dragData.item.y = y - dragData.offsetY; if (currentCalcMode === "TX" && poutLabels.length) drawPoutLabels(); else drawCanvas(); }
    else if (lineData.startComp) { lineData.mouseX = x; lineData.mouseY = y; drawCanvas(); }
    else { const b = getBlockAtPos(x, y), l = getLineAtPos(x, y); canvas.style.cursor = b ? ((e.ctrlKey||e.metaKey)?'crosshair':'move') : (l?'pointer':'default'); }
}
function onMouseUp(e) {
    if (panData.isPanning) { panData.isPanning = false; canvas.classList.remove('panning'); return; }
    if (lineData.startComp) {
        const end = getBlockAtPos(getMousePos(e).x, getMousePos(e).y);
        if (end && end.id !== lineData.startComp.id) {
            let hasIn = false; for (const t of currentConnections.values()) if (t === end.id) hasIn = true;
            if (hasIn) alert("Input already occupied."); else currentConnections.set(lineData.startComp.id, end.id);
        } lineData.startComp = null; drawCanvas();
    } dragData.item = null;
}
function onMouseLeave() { dragData.item = null; panData.isPanning = false; lineData.startComp = null; drawCanvas(); }
function onDoubleClick(e) { if (isMergeSelectMode) return; const b = getBlockAtPos(getMousePos(e).x, getMousePos(e).y); if (b) openEditModal(b); }
function onContextMenu(e) {
    e.preventDefault(); if (isMergeSelectMode) return;
    const {x, y} = getMousePos(e); const b = getBlockAtPos(x, y), l = getLineAtPos(x, y);
    dom.blockContextMenu.style.display = 'none'; dom.lineContextMenu.style.display = 'none';
    if (b) { rightClickedComp = b; showContextMenu(dom.blockContextMenu, e.clientX, e.clientY); document.getElementById('menu-unmerge-comp').style.display = b.isMerged ? 'block' : 'none'; }
    else if (l) { rightClickedLine = l; showContextMenu(dom.lineContextMenu, e.clientX, e.clientY); }
}
function onMouseWheel(e) {
    e.preventDefault(); const rect = canvas.getBoundingClientRect();
    const wx = (e.clientX - rect.left - canvasPan.x) / canvasZoom;
    const wy = (e.clientY - rect.top - canvasPan.y) / canvasZoom;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    let newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, canvasZoom * delta));
    canvasPan.x = (e.clientX - rect.left) - wx * newZoom;
    canvasPan.y = (e.clientY - rect.top) - wy * newZoom;
    canvasZoom = newZoom; drawCanvas();
}
function showContextMenu(m, x, y) { m.style.left = x+'px'; m.style.top = y+'px'; m.style.display = 'block'; }
function getMousePos(e) { 
    const rect = canvas.getBoundingClientRect(); 
    return { x: (e.clientX - rect.left - canvasPan.x) / canvasZoom, y: (e.clientY - rect.top - canvasPan.y) / canvasZoom }; 
}
function getBlockAtPos(x, y) { for (let i = blocks.length - 1; i >= 0; i--) { const comp = blocks[i]; if (x >= comp.x && x <= comp.x + comp.width && y >= comp.y && y <= comp.y + comp.height) return comp; } return null; }
function getLineAtPos(x, y) {
    for (const [fid, tid] of currentConnections) {
        const f=blocks.find(b=>b.id===fid), t=blocks.find(b=>b.id===tid); if(!f||!t)continue;
        const [x1,y1]=getLineIntersectionPoint(f,t), [x2,y2]=getLineIntersectionPoint(t,f);
        const d = Math.abs((y2-y1)*x - (x2-x1)*y + x2*y1 - y2*x1) / Math.sqrt((y2-y1)**2 + (x2-x1)**2);
        if (d < 5/canvasZoom && x>=Math.min(x1,x2)-5 && x<=Math.max(x1,x2)+5 && y>=Math.min(y1,y2)-5 && y<=Math.max(y1,y2)+5) return {fromComp:f, toComp:t, lineId:fid};
    } return null;
}
function getLineIntersectionPoint(A, B) {
    const cxA=A.x+A.width/2, cyA=A.y+A.height/2, cxB=B.x+B.width/2, cyB=B.y+B.height/2;
    const dx=cxB-cxA, dy=cyB-cyA, hW=A.width/2, hH=A.height/2;
    if (!dx && !dy) return [cxA, cyA];
    const t = Math.min(Math.abs(hW/dx)||Infinity, Math.abs(hH/dy)||Infinity);
    return [cxA + dx*t, cyA + dy*t];
}
function clearAllSelections() { blocks.forEach(b => b.isSelected=false); drawCanvas(); }
function clearAllHighlights() { blocks.forEach(b => b.isHighlighted=false); drawCanvas(); }
function highlightBlock(b) { if(b){ b.isHighlighted=true; drawCanvas(); } }

function drawCanvas() {
    if (!ctx) return;
    if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) { canvas.width = canvas.clientWidth; canvas.height = canvas.clientHeight; canvasWidth = canvas.width; canvasHeight = canvas.height; }
    ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,canvasWidth,canvasHeight);
    ctx.translate(canvasPan.x, canvasPan.y); ctx.scale(canvasZoom, canvasZoom);

    ctx.strokeStyle = "#F0F0F0"; ctx.lineWidth = 2;
    for (const [fid, tid] of currentConnections) {
        const f = blocks.find(b=>b.id===fid), t = blocks.find(b=>b.id===tid);
        if (f && t) { const [x1,y1] = getLineIntersectionPoint(f,t), [x2,y2] = getLineIntersectionPoint(t,f); drawArrow(x1,y1,x2,y2); }
    }
    if (lineData.startComp) {
        ctx.strokeStyle = "blue"; ctx.setLineDash([4,2]); ctx.beginPath();
        ctx.moveTo(lineData.startComp.x + lineData.startComp.width/2, lineData.startComp.y + lineData.startComp.height/2);
        ctx.lineTo(lineData.mouseX, lineData.mouseY); ctx.stroke(); ctx.setLineDash([]);
    }

    blocks.forEach(c => {
        const mainColor = c.isMerged ? "#C8A2C8" : (c.isSystem ? "#FFEAA7" : (c.isPassive ? "#A8E6CF" : "#BDE0FE"));
        const specs = c.getDisplaySpecsLines(lastCalcFreq, lastCalcMode);
        let childHeight = 0;
        if(c.isMerged) childHeight = 15 + (c.childrenData.length * 15);
        c.height = 60 + (specs.length * 15) + childHeight;
        c.width = Math.max(110, ctx.measureText(c.name).width + 40);
        
        ctx.fillStyle = "#00000055"; ctx.fillRect(c.x+3, c.y+3, c.width, c.height);
        ctx.fillStyle = mainColor; ctx.fillRect(c.x, c.y, c.width, c.height);
        ctx.strokeStyle = "#FFFFFF33"; ctx.strokeRect(c.x, c.y, c.width, c.height);
        
        ctx.fillStyle = "#111"; ctx.font = "bold 13px Arial"; ctx.textAlign = "center";
        ctx.fillText(c.name, c.x + c.width/2, c.y + 20);
        ctx.font = "12px Arial"; ctx.fillText(c.getDisplaySpecs(), c.x + c.width/2, c.y + 38);
        
        let y = c.y + 53; ctx.fillStyle = "#555"; ctx.fillText("---", c.x + c.width/2, y); y+=15;
        specs.forEach(l => {
            if (l.startsWith("Pin") || l.startsWith("Pout")) ctx.fillStyle = "#FFD700";
            else ctx.fillStyle = "#005A9E";
            ctx.fillText(l, c.x + c.width/2, y); y += 15;
        });
        if(c.isMerged && c.childrenData.length > 0) {
            ctx.fillStyle = "#222"; ctx.font = "italic bold 11px Arial"; ctx.fillText("--- (Original) ---", c.x + c.width/2, y); y+=15;
            ctx.fillStyle = "#111"; ctx.font = "italic 11px Arial";
            c.childrenData.forEach(child => { ctx.fillText(child.name, c.x + c.width/2, y); y+=15; });
        }

        if (c.isSelected) { ctx.strokeStyle = "#00FFFF"; ctx.lineWidth = 3; ctx.setLineDash([5,3]); ctx.strokeRect(c.x-2, c.y-2, c.width+4, c.height+4); ctx.setLineDash([]); ctx.lineWidth=1; }
        if (c.isHighlighted) { ctx.strokeStyle = "red"; ctx.lineWidth=3; ctx.strokeRect(c.x-1, c.y-1, c.width+2, c.height+2); ctx.lineWidth=1; }
        
        if (c.runtimeResults && c.runtimeResults.freq === lastCalcFreq && c.runtimeResults.mode === lastCalcMode) {
            const pinT = `Pin: ${formatNum(c.runtimeResults.pin_dbm, 1)}`;
            const poutT = `Pout: ${formatNum(c.runtimeResults.pout_dbm, 1)}`;
            const isRX = lastCalcMode === "RX";
            ctx.font = "bold 12px Consolas"; ctx.fillStyle = "#FFD700";
            ctx.textAlign = isRX ? "left" : "right"; ctx.fillText(pinT, c.x + (isRX ? c.width+5 : -5), c.y + c.height/2);
            ctx.textAlign = isRX ? "right" : "left"; ctx.fillText(poutT, c.x + (isRX ? -5 : c.width+5), c.y + c.height/2);
        }
    });
    ctx.restore();
}

function drawArrow(x1,y1,x2,y2) {
    const a = Math.atan2(y2-y1, x2-x1);
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2);
    ctx.moveTo(x2,y2); ctx.lineTo(x2-10*Math.cos(a-Math.PI/6), y2-10*Math.sin(a-Math.PI/6));
    ctx.moveTo(x2,y2); ctx.lineTo(x2-10*Math.cos(a+Math.PI/6), y2-10*Math.sin(a+Math.PI/6));
    ctx.stroke();
}

function drawPoutLabels() {
    poutLabels = [];
    try {
        const sortedChain = calculator.chain;
        const cascadeTable = calculator.cascadeTable;
        for (let i = 0; i < sortedChain.length; i++) {
            const comp = sortedChain[i];
            const nextCompId = currentConnections.get(comp.id);
            if (nextCompId) {
                const nextComp = blocks.find(b => b.id === nextCompId);
                if (!nextComp) continue;
                if (i < cascadeTable.length && 'Cum. Pout (dBm)' in cascadeTable[i]) {
                    const pout_dbm = cascadeTable[i]['Cum. Pout (dBm)'];
                    const [x1, y1] = getLineIntersectionPoint(comp, nextComp);
                    const [x2, y2] = getLineIntersectionPoint(nextComp, comp);
                    poutLabels.push({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 10, text: `${formatNum(pout_dbm, 2)} dBm` });
                }
            }
        }
    } catch (e) {}
    drawCanvas();
}

// ============================================================================
// 5. 初始化與執行 (Entry Point)
// ============================================================================

function init() {
    // 綁定 DOM 元素
    dom.canvas = document.getElementById('rf-canvas');
    dom.ctx = dom.canvas.getContext('2d');
    canvas = dom.canvas; ctx = dom.ctx;
    
    dom.resultText = document.getElementById('result-text');
    dom.calcLogText = document.getElementById('calc-log-text'); 
    dom.entryFreq = document.getElementById('entry-freq'); 
    dom.entryPin = document.getElementById('entry-pin');
    dom.entryRxPin = document.getElementById('entry-rx-pin');
    
    // 初始化 calculator 實例
    calculator = new RFLInkBudget();
    dom.t0Label = document.getElementById('t0-label');
    dom.t0Label.textContent = `T0 (K): ${calculator.T0}`;
    
    // 初始化連線模式
    currentConnections = connections_TX; 

    dom.tabButtons = document.querySelectorAll('.tab-button');
    dom.tabContents = document.querySelectorAll('.tab-content');
    
    dom.calcButton = document.getElementById('calc-button');
    dom.clearButton = document.getElementById('clear-button');
    dom.clearLinesButton = document.getElementById('clear-lines-button'); 
    dom.loadCompBtn = document.getElementById('load-component');
    dom.fileLoaderInput = document.getElementById('file-loader-input');
    dom.mergeButton = document.getElementById('merge-components'); 
    
    dom.modal = document.getElementById('edit-component-modal');
    dom.modalTitle = document.getElementById('modal-title');
    dom.modalCloseBtn = document.getElementById('modal-close-btn');
    dom.modalCompName = document.getElementById('modal-comp-name');
    dom.modalFreqList = document.getElementById('modal-freq-list');
    dom.modalAddFreqBtn = document.getElementById('modal-add-freq-btn');
    dom.modalDelFreqBtn = document.getElementById('modal-del-freq-btn');
    dom.modalSpecEditors = document.getElementById('modal-spec-editors');
    dom.modalCancelBtn = document.getElementById('modal-cancel-btn');
    dom.modalSaveBtn = document.getElementById('modal-save-btn');
    
    dom.blockContextMenu = document.getElementById('block-context-menu');
    dom.lineContextMenu = document.getElementById('line-context-menu');

    // 初始化動態元素 (Export / Unmerge Menu)
    try {
        const unmergeLi = document.createElement('li');
        unmergeLi.id = 'menu-unmerge-comp';
        unmergeLi.textContent = 'Unmerge Component';
        unmergeLi.style.display = 'none'; 
        const duplicateCompMenu = document.getElementById('menu-duplicate-comp');
        if (duplicateCompMenu) duplicateCompMenu.parentNode.insertBefore(unmergeLi, duplicateCompMenu.nextSibling);
        else dom.blockContextMenu.appendChild(unmergeLi);
    } catch (e) {}

    try {
        dom.exportButton = document.createElement('button');
        dom.exportButton.id = 'export-button';
        dom.exportButton.className = 'tool-button';
        dom.exportButton.textContent = 'Export Report';
        dom.calcButton.parentNode.insertBefore(dom.exportButton, dom.calcButton.nextSibling);
        const spacer = document.createTextNode(' ');
        dom.calcButton.parentNode.insertBefore(spacer, dom.exportButton);
    } catch (e) {}

    // 事件監聽綁定
    window.addEventListener('resize', resizeCanvas); 
    dom.tabButtons.forEach(btn => btn.addEventListener('click', onTabChange));
    
    // 工具箱按鈕綁定
    document.getElementById('add-lna').addEventListener('click', () => addBlock("LNA", false, false, {'1.0': {'TX': {'gain_db': 15, 'nf_db': 1.5, 'op1db_dbm': 20}, 'RX': {'gain_db': 15, 'nf_db': 1.5, 'op1db_dbm': 20}}}));
    document.getElementById('add-pa').addEventListener('click', () => addBlock("PA", false, false, {'1.0': {'TX': {'gain_db': 20, 'nf_db': 5, 'op1db_dbm': 33}, 'RX': {'gain_db': 20, 'nf_db': 5, 'op1db_dbm': 33}}}));
    document.getElementById('add-mixer').addEventListener('click', () => addBlock("Mixer", false, false, {'1.0': {'TX': {'gain_db':-7, 'nf_db': 7, 'op1db_dbm': 15}, 'RX': {'gain_db':-7, 'nf_db': 7, 'op1db_dbm': 15}}}));
    document.getElementById('add-filter').addEventListener('click', () => addBlock("Filter", true, false, {'1.0': {'TX': {'loss_db': 1.5}, 'RX': {'loss_db': 1.5}}}));
    document.getElementById('add-atten').addEventListener('click', () => addBlock("Atten", true, false, {'1.0': {'TX': {'loss_db': 6.0}, 'RX': {'loss_db': 6.0}}}));
    document.getElementById('add-div2').addEventListener('click', () => addBlock("1-2 Div", true, false, {'1.0': {'TX': {'loss_db': 3.5}, 'RX': {'loss_db': 3.5}}}));
    document.getElementById('add-div4').addEventListener('click', () => addBlock("1-4 Div", true, false, {'1.0': {'TX': {'loss_db': 7.0}, 'RX': {'loss_db': 7.0}}}));
    document.getElementById('add-trace').addEventListener('click', () => addBlock("Trace", true, false, {'1.0': {'TX': {'loss_db': 0.5}, 'RX': {'loss_db': 0.5}}}));
    document.getElementById('add-antenna').addEventListener('click', () => addBlock("Antenna", false, true, {'1.0': {'TX': {'gain_db': 12, 'nf_db': 0.0, 'op1db_dbm': 99}, 'RX': {'gain_db': 12, 'nf_db': 0.0, 'op1db_dbm': 99}}}));
    document.getElementById('add-array').addEventListener('click', () => addBlock("Array (N=16)", false, true, {'1.0': {'TX': {'gain_db': 12.04, 'nf_db': 0.0, 'op1db_dbm': 99}, 'RX': {'gain_db': 12.04, 'nf_db': 0.0, 'op1db_dbm': 99}}}, false, true));
    
    const airBtn = document.getElementById('add-airloss');
    if (airBtn) airBtn.addEventListener('click', () => { const defaultLoss = calculateFSPL(1.0, 100); addBlock("Air Loss", true, false, {'1.0': {'TX': {'loss_db': defaultLoss}, 'RX': {'loss_db': defaultLoss}}}, true); });

    // 主功能按鈕
    dom.calcButton.addEventListener('click', calculateLink);
    dom.clearButton.addEventListener('click', clearAll); 
    dom.clearLinesButton.addEventListener('click', clearAllLines); 
    if (dom.exportButton) dom.exportButton.addEventListener('click', exportFullReport);

    // 畫布操作事件
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('wheel', onMouseWheel);
    
    // Modal 操作事件
    dom.modalCloseBtn.addEventListener('click', closeEditModal);
    dom.modalCancelBtn.addEventListener('click', closeEditModal);
    dom.modalSaveBtn.addEventListener('click', saveEditModal);
    dom.modalAddFreqBtn.addEventListener('click', modalAddFreq);
    dom.modalDelFreqBtn.addEventListener('click', modalDelFreq);
    dom.modalFreqList.addEventListener('change', modalOnFreqSelect);
    
    // 右鍵選單操作事件
    document.getElementById('menu-save-comp').addEventListener('click', saveComponent);
    document.getElementById('menu-delete-comp').addEventListener('click', deleteComponent);
    document.getElementById('menu-duplicate-comp').addEventListener('click', duplicateComponent); 
    document.getElementById('menu-unmerge-comp').addEventListener('click', unmergeComponent); 
    document.getElementById('menu-cancel-block').addEventListener('click', () => dom.blockContextMenu.style.display = 'none');
    document.getElementById('menu-delete-line').addEventListener('click', deleteSelectedLine);
    document.getElementById('menu-cancel-line').addEventListener('click', () => dom.lineContextMenu.style.display = 'none');

    // 檔案操作與合併
    dom.loadCompBtn.addEventListener('click', () => dom.fileLoaderInput.click());
    dom.fileLoaderInput.addEventListener('change', loadComponentFromFile);
    dom.mergeButton.addEventListener('click', onMergeComponents); 

    // 初始渲染
    setTimeout(resizeCanvas, 0);
}

// 啟動程式
document.addEventListener('DOMContentLoaded', init);
