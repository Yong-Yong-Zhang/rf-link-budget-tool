/*
 * RF 鏈路預算 (Web App v10.0) - 核心 JavaScript
 * v10.0 (使用者需求) 更新:
 * 1. (功能) 新增 Air Loss 元件，支援依距離(cm)與頻率自動計算路徑損耗 (FSPL)。
 * 2. (介面) 新增 Input/Output Power (Pin/Pout) 顯示於元件方塊上。
 *
 * v9.0 ~ v9.17 歷史更新包含:
 * - 複製元件、拆分元件 (Unmerge)、匯出報告、G/T 計算優化等。
 */

// --- (新) 自訂錯誤類別 ---
class CompressionError extends Error {
    constructor(message, component) {
        super(message);
        this.name = "CompressionError";
        this.component = component;
    }
}

// --- 第 0 部分：輔助工具 (單位轉換 & 計算) ---
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

/**
 * 格式化數字，移除不必要的小數點
 */
function formatNum(num, digits = 1) {
    const roundedNum = parseFloat(num.toFixed(digits));
    return String(roundedNum);
}

/**
 * (v10.0 新增) Air Loss 路徑損耗計算 (FSPL)
 * @param {number} freqGHz - 頻率 (GHz)
 * @param {number} distCm - 距離 (cm)
 * @returns {number} Path Loss (dB)
 */
function calculateFSPL(freqGHz, distCm) {
    if (distCm <= 0) return 0.0;
    // 頻率 GHz -> Hz
    const freqHz = freqGHz * 1e9;
    // 距離 cm -> m
    const distM = distCm / 100.0;
    const c = 299792458; // 光速 m/s
    
    // FSPL 公式: (4 * pi * d * f) / c
    const linear = (4 * Math.PI * distM * freqHz) / c;
    if (linear < 1) return 0.0; // Near field safety
    
    // 轉 dB
    return 20 * Math.log10(linear);
}

// --- 模組 1A：RF 元件類別 ---
class RFComponent {
    // v10.0: 新增 isAirLoss 參數
    constructor(name, isPassive = false, isSystem = false, specsByFreqDict = null, isAirLoss = false) {
        this.name = name;
        this.isPassive = isPassive;
        this.isSystem = isSystem;
        this.isAirLoss = isAirLoss; // v10.0: 標記是否為 Air Loss 元件

        // v10.0: Air Loss 專用設定
        this.airLossConfig = {
            mode: 'calc', // 'calc' (自動計算) or 'manual' (手動輸入)
            dist_cm: 100.0 // 預設距離 100cm
        };

        this.specsByFreq = {};
        this.id = `comp_${Date.now()}_${Math.random()}`;

        // v10.0: 儲存計算後的即時結果 (用於畫布顯示 Pin/Pout)
        this.runtimeResults = null;

        // 圖形介面 (Canvas) 相關屬性
        this.x = 50;
        this.y = 50;
        this.width = 110;
        this.height = 70; 
        this.isHighlighted = false;
        this.isSelected = false;
        
        this.isMerged = false;
        this.childrenData = [];

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
            // 新增元件時的預設值
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
            // v8.9: 恢復 F=L
            nf_db = loss_db; 
            op1db_dbm = 99.0;
            storage['loss_db'] = loss_db;
        } else { 
            gain_db = parseFloat(specsDict.gain_db || 0.0);
            nf_db = parseFloat(specsDict.nf_db || 0.0);
            
            // v8.7: RX 模式下 P1dB 永遠為 99
            if (mode === "RX") {
                op1db_dbm = 99.0;
            } else {
                op1db_dbm = parseFloat(specsDict.op1db_dbm || 99.0);
            }

            const oip3_dbm = parseFloat(specsDict.oip3_dbm || 99.0);
            storage['gain_db'] = gain_db;
            storage['nf_db'] = nf_db;
            storage['op1db_dbm'] = op1db_dbm;
            storage['oip3_dbm'] = oip3_dbm;
            storage['oip3_mw'] = dbm_to_mw(oip3_dbm);
            
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

        if (this.isPassive) {
            this.specsByFreq[freqKey]["TX"] = calculatedSpec;
            this.specsByFreq[freqKey]["RX"] = calculatedSpec;
        }
    }

    getSpecsForFreq(freqStr, mode) {
        const freqKey = String(freqStr);
        if (!(freqKey in this.specsByFreq)) return null;
        return this.specsByFreq[freqKey][mode] || null;
    }

    getRawSpecsForFreq(freqStr, mode) {
        const specsMode = (this.isPassive) ? "TX" : mode;
        const specs = this.getSpecsForFreq(freqStr, specsMode);
        if (!specs) return {};

        if (this.isPassive) return { 'loss_db': specs.loss_db || 0.0 };
        else { 
            const raw = {
                'gain_db': specs.gain_db || 0.0,
                'nf_db': specs.nf_db || 0.0,
            };
            if (mode === "TX") {
                raw['op1db_dbm'] = specs.op1db_dbm || 99.0;
            }

            if(this.isMerged){
                raw['active_gain_db'] = specs.active_gain_db || 0.0;
                raw['passive_gain_db'] = specs.passive_gain_db || 0.0;
                raw['system_gain_db'] = specs.system_gain_db || 0.0;
            }
            return raw;
        }
    }

    getAvailableFreqs() {
        return Object.keys(this.specsByFreq).sort((a, b) => parseFloat(a) - parseFloat(b));
    }

    removeFreq(freqStr) {
        if (String(freqStr) in this.specsByFreq) {
            delete this.specsByFreq[String(freqStr)];
        }
    }

    getDisplayName() { return this.name; }
    
    getDisplaySpecs() {
        const freqList = this.getAvailableFreqs();
        if (freqList.length === 0) return "(無頻點資料)";
        const displayFreqs = freqList.slice(0, 3);
        const suffix = (freqList.length > 3) ? "..." : "";
        return `(${displayFreqs.join(', ')}${suffix} GHz)`;
    }

    // v10.0 Updated: 加入 Pin/Pout 與 Air Loss 顯示
    getDisplaySpecsLines(freq, mode) {
        let lines = [];
        
        // --- v10.1 修改：移除內部的 Pin/Pout 顯示 (將移至 drawCanvas 外部繪製) ---
        /* // 原始程式碼：
        if (this.runtimeResults && this.runtimeResults.freq === freq && this.runtimeResults.mode === mode) {
             const pin = this.runtimeResults.pin_dbm;
             const pout = this.runtimeResults.pout_dbm;
             lines.push(`Pin: ${formatNum(pin, 1)} dBm`);
             lines.push(`Pout: ${formatNum(pout, 1)} dBm`);
             lines.push(`---`); 
        }
        */
        // -------------------------------------------------------------------

        if (!freq || !mode) return lines;
        const specs = this.getSpecsForFreq(freq, mode);
        if (!specs) return [`(${freq} GHz 未定義)`];

        if (this.isPassive) {
            // --- v10.0: Air Loss 顯示 ---
            if (this.isAirLoss) {
                if (this.airLossConfig.mode === 'calc') {
                    lines.push(`Dist: ${this.airLossConfig.dist_cm} cm`);
                } else {
                    lines.push(`(Manual Loss)`);
                }
            }
            // ---------------------------
            lines.push(`L: ${formatNum(specs.loss_db, 1)} dB`);
            lines.push(`NF: ${formatNum(specs.nf_db, 1)} dB`);
        } else if (this.isSystem) {
            return [
                `G: ${formatNum(specs.gain_db, 1)} dB`,
                `NF: ${formatNum(specs.nf_db, 1)} dB`
            ];
        } else {
            if (this.isMerged) {
                const active_gain_db = (specs.active_gain_db || 0);
                const system_gain_db = (specs.system_gain_db || 0);
                lines.push(`G_total: ${formatNum(specs.gain_db, 1)} dB`);
                lines.push(`(Act:${formatNum(active_gain_db, 1)}/Sys:${formatNum(system_gain_db, 1)})`);
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
            specsToSave[freq] = {
                "TX": this.getRawSpecsForFreq(freq, "TX"),
                "RX": this.getRawSpecsForFreq(freq, "RX")
            };
        }
        return {
            'name': this.name,
            'isPassive': this.isPassive,
            'isSystem': this.isSystem,
            'isAirLoss': this.isAirLoss, // v10.0
            'airLossConfig': this.airLossConfig, // v10.0
            'specs_by_freq': specsToSave,
            'isMerged': this.isMerged, 
            'childrenData': this.childrenData 
        };
    }
    
    static fromDict(data) {
        const name = data.name || 'LoadedComp';
        const isPassive = data.isPassive || false;
        const isSystem = data.isSystem || false;
        const specsDict = data.specs_by_freq || {};
        const isAirLoss = data.isAirLoss || false; // v10.0
        
        // v10.0: 傳遞 isAirLoss
        const comp = new RFComponent(name, isPassive, isSystem, specsDict, isAirLoss);
        
        if (data.airLossConfig) comp.airLossConfig = data.airLossConfig; // v10.0
        
        comp.isMerged = data.isMerged || false;
        comp.childrenData = data.childrenData || [];
        
        return comp;
    }
}

// --- 模組 1B：核心計算引擎 ---
class RFLInkBudget {
    constructor() {
        this.chain = [];
        this.systemParams = {};
        this.results = {};
        this.cascadeTable = [];
        this.T0 = 290.0;
        this.calcLog = []; 
    }

    setSystemParams(pInDbm) {
        this.systemParams = { 'p_in_dbm': pInDbm };
    }

    clear() {
        this.chain = [];
        this.results = {};
        this.cascadeTable = [];
        this.calcLog = [];
    }

    getCalcLog() {
        return this.calcLog.join('\n');
    }

    setChain(sortedChain) { this.chain = sortedChain; }

    calculate(calcFreqStr, mode = "TX") {
        if (!this.chain || this.chain.length === 0) throw new Error("鏈路中沒有元件。");
        calcFreqStr = String(calcFreqStr);

        this.calcLog = [];
        this.calcLog.push(`*** ${mode} 模式 @ ${calcFreqStr} GHz ***`);
        this.calcLog.push(`============================`);
        
        // v10.0: 清除舊結果
        this.chain.forEach(c => c.runtimeResults = null);

        let cumulative_gain_linear = 1.0;
        let cumulative_pout_dbm = this.systemParams.p_in_dbm || -100.0;
        
        let cumulative_nf_linear = 0.0;
        let cumulative_gain_linear_for_nf = 1.0;
        let nf_cascade_started = false; 

        let total_active_gain_db = 0;
        let total_passive_gain_db = 0;
        let total_system_gain_db = 0;

        if (mode === "RX") {
            cumulative_pout_dbm = -100.0;
            this.calcLog.push(`[Info] RX 模式: P_in 設為 -100 dBm (G/T 參考)`);
        } else {
            this.calcLog.push(`[Info] TX 模式: P_in = ${formatNum(cumulative_pout_dbm, 2)} dBm`);
        }
        this.calcLog.push(``);

        this.cascadeTable = [];
        this.results = {};

        for (let i = 0; i < this.chain.length; i++) {
            const comp = this.chain[i];
            const specs = comp.getSpecsForFreq(calcFreqStr, mode);
            if (!specs) throw new Error(`元件 '${comp.name}' 缺少 '${calcFreqStr} GHz' 的 '${mode}' 規格。`);
            
            this.calcLog.push(`--- (S${i + 1}) ${comp.name} ---`);

            const stage_gain_db = specs['gain_db'];
            const stage_op1db_dbm = specs['op1db_dbm'] || 99.0;
            
            // v10.0: 記錄該級輸入功率
            const stage_pin_dbm = cumulative_pout_dbm;
            
            cumulative_pout_dbm = stage_pin_dbm + stage_gain_db;
            
            // --- v10.0: 將計算結果寫入元件 ---
            comp.runtimeResults = {
                freq: calcFreqStr,
                mode: mode,
                pin_dbm: stage_pin_dbm,
                pout_dbm: cumulative_pout_dbm
            };
            // -----------------------------

            // 累加分離的增益
            if (comp.isPassive) {
                total_passive_gain_db += stage_gain_db;
            } else if (comp.isSystem) {
                total_system_gain_db += stage_gain_db;
            } else {
                total_active_gain_db += stage_gain_db;
            }

            this.calcLog.push(`  G_cum: ${formatNum(stage_pin_dbm, 2)} dBm (Pin) + ${formatNum(stage_gain_db, 2)} dB (G) = ${formatNum(cumulative_pout_dbm, 2)} dBm (Pout)`);

            const comp_gain_linear = specs['gain_linear'];
            const comp_nf_linear = specs['nf_linear'] ?? 1.0; 

            // NF 計算邏輯
            let is_first_nf_stage = false;
            if (mode === "RX") {
                if (comp.isSystem) {
                    this.calcLog.push(`  NF_cum: (RX 模式，跳過天線元件 NF 計算)`);
                } else if (!nf_cascade_started) {
                    nf_cascade_started = true;
                    is_first_nf_stage = true;
                }
            } else { 
                if (i === 0) {
                    is_first_nf_stage = true;
                }
                nf_cascade_started = true;
            }

            if (nf_cascade_started) {
                if (is_first_nf_stage) {
                    cumulative_nf_linear = comp_nf_linear;
                    cumulative_gain_linear_for_nf = comp_gain_linear; 
                    this.calcLog.push(`  NF_cum [F]: (NF 串級開始) F_total = F_1`);
                } else {
                    const F_prev = cumulative_nf_linear;
                    const G_prev_lin = cumulative_gain_linear_for_nf; 
                    const F_stage = comp_nf_linear;
                    const F_contrib = (F_stage - 1) / G_prev_lin;
                    cumulative_nf_linear += F_contrib;
                    cumulative_gain_linear_for_nf *= comp_gain_linear; 
                    this.calcLog.push(`  NF_cum [F]: F_total = F_prev + (F_stage - 1) / G_prev_lin`);
                }
                this.calcLog.push(`  NF_cum [dB]: 10*log10(${formatNum(cumulative_nf_linear, 4)}) = ${formatNum(linear_to_db(cumulative_nf_linear), 2)} dB`);
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
                    const errorMsg = `元件 '${comp.name}' 發生 P1dB 壓縮！\n\nPout: ${cumulative_pout_dbm.toFixed(2)} dBm\nP1dB: ${stage_op1db_dbm.toFixed(2)} dBm`;
                    this.calcLog.push(`  *** 錯誤: ${errorMsg.replace("\n\n", " ")} ***`);
                    throw new CompressionError(errorMsg, comp);
                }
            }
            
        } // --- 迴圈結束 ---

        // 後續 P1dB 累積與 G/T 計算保持不變
        let gain_from_end = 1.0;
        let total_op1db_inv_mw = 0.0;
        if (mode === "TX") {
            for (let i = this.chain.length - 1; i >= 0; i--) {
                const comp = this.chain[i];
                const specs = comp.getSpecsForFreq(calcFreqStr, mode);
                if (!comp.isSystem) {
                    total_op1db_inv_mw += 1.0 / (specs['op1db_mw'] * gain_from_end);
                }
                gain_from_end *= specs['gain_linear'];
            }
        }
        
        const total_op1db_mw = (total_op1db_inv_mw > 0) ? (1.0 / total_op1db_inv_mw) : Infinity;

        // G/T 計算
        let g_ant_db = 0.0;
        let t_ant = 0.0;
        let t_rx = 0.0;
        let t_sys = 0.0;
        let g_over_t = -Infinity;
        const nf_total_db = (nf_cascade_started) ? linear_to_db(cumulative_nf_linear) : 0.0;

        if (mode === "RX") {
            this.calcLog.push(`--- (G/T) G/T 系統計算 ---`);

            for (const comp of this.chain) { 
                if (comp.isSystem) {
                    const specs = comp.getSpecsForFreq(calcFreqStr, mode); 
                    if (specs) {
                        g_ant_db += specs.gain_db;
                    }
                } else {
                    break;
                }
            }
            
            t_ant = this.T0;
            const f_total = db_to_linear(nf_total_db);
            t_rx = this.T0 * (f_total - 1);
            t_sys = t_ant + t_rx;
            const t_sys_dbk = (t_sys > 0) ? (10 * Math.log10(t_sys)) : -Infinity;
            g_over_t = g_ant_db - t_sys_dbk;

            this.calcLog.push(`  G_ant: ${formatNum(g_ant_db, 2)} dB, T_sys: ${formatNum(t_sys, 2)} K`);
            this.calcLog.push(`  G/T: ${formatNum(g_over_t, 2)} dB/K`);
            this.calcLog.push(``);
        }

        this.results['chain'] = {
            'total_gain_db': linear_to_db(cumulative_gain_linear),
            'total_nf_db': nf_total_db,
            'total_op1db_dbm': mw_to_dbm(total_op1db_mw),
            'final_pout_dbm': cumulative_pout_dbm,
            'total_active_gain_db': total_active_gain_db,
            'total_passive_gain_db': total_passive_gain_db,
            'total_system_gain_db': total_system_gain_db,
            'g_ant_db': g_ant_db,
            't_ant': t_ant,
            't_rx': t_rx,
            't_sys': t_sys,
            'g_over_t': g_over_t
        };
    }

    getReport(calcFreqStr, mode = "TX") {
        const p_in_dbm = this.systemParams.p_in_dbm || 0;
        const chain_res = this.results.chain;
        if (!chain_res) return "尚未計算。";

        const total_gain_db = chain_res['total_gain_db'];
        const total_active_gain_db = chain_res['total_active_gain_db'];
        const total_passive_gain_db = chain_res['total_passive_gain_db'];
        const total_system_gain_db = chain_res['total_system_gain_db'];
        const total_positive_gain_db = total_active_gain_db + total_system_gain_db;
        
        let report_str = "======================================================================\n";
        report_str += `--- 📈 1. 級聯鏈路分析 (@ ${calcFreqStr} GHz, Mode: ${mode}) ---\n`;
        report_str += "======================================================================\n";
        
        const stage_width = 35, gain_width = 15, nf_width = 15, pout_width = 15;

        if (mode === "TX") {
            let header = "Stage".padEnd(stage_width) + " | " + "Cum. Gain (dB)".padStart(gain_width) + " | " + "Cum. NF (dB)".padStart(nf_width) + " | " + "Cum. Pout (dBm)".padStart(pout_width) + "\n";
            report_str += header;
            report_str += "-".repeat(header.length - 1) + "\n";
            for (const stage of this.cascadeTable) {
                report_str += stage['Stage'].padEnd(stage_width) + " | " +
                    formatNum(stage['Cum. Gain (dB)'], 2).padStart(gain_width) + " | " +
                    formatNum(stage['Cum. NF (dB)'], 2).padStart(nf_width) + " | " +
                    formatNum(stage['Cum. Pout (dBm)'], 2).padStart(pout_width) + "\n";
            }
        } else { // RX
            let header = "Stage".padEnd(stage_width) + " | " + "Cum. Gain (dB)".padStart(gain_width) + " | " + "Cum. NF (dB)".padStart(nf_width) + "\n";
            report_str += header;
            report_str += "-".repeat(header.length - 1) + "\n";
            for (const stage of this.cascadeTable) {
                report_str += stage['Stage'].padEnd(stage_width) + " | " +
                    formatNum(stage['Cum. Gain (dB)'], 2).padStart(gain_width) + " | " +
                    formatNum(stage['Cum. NF (dB)'], 2).padStart(nf_width) + "\n";
            }
        }

        report_str += "\n" + "=".repeat(50) + "\n";

        if (mode === "TX") {
            const total_output_power_dbm = chain_res['final_pout_dbm'];
            report_str += `--- 🛰️ 2. 系統總結 (TX @ ${calcFreqStr} GHz) ---\n` + "=".repeat(50) + "\n";
            report_str += `  輸入功率 (P_in):         ${formatNum(p_in_dbm, 2).padStart(7)} dBm\n`;
            report_str += `  總系統增益 (G_system):  ${formatNum(total_gain_db, 2).padStart(7)} dB\n`;
            report_str += `  (主動/系統 增益):       ${formatNum(total_positive_gain_db, 2).padStart(7)} dB\n`;
            report_str += `  (被動元件 損耗):       ${formatNum(total_passive_gain_db, 2).padStart(7)} dB\n`;
            report_str += "  --------------------------------------------------\n";
            report_str += `  **最終輸出功率 (P_out/EIRP):** **${formatNum(total_output_power_dbm, 2).padStart(7)} dBm**\n`;
        
        } else { // RX
            const g_ant_db = chain_res['g_ant_db'];
            const t_ant = chain_res['t_ant'];
            const nf_total_db = chain_res['total_nf_db'];
            const t_rx = chain_res['t_rx'];
            const t_sys = chain_res['t_sys'];
            const g_over_t = chain_res['g_over_t'];
            const t_sys_dbk = (t_sys > 0) ? (10 * Math.log10(t_sys)) : -Infinity;

            report_str += `--- 🛰️ 2. 系統總結 (RX G/T @ ${calcFreqStr} GHz) ---\n` + "=".repeat(50) + "\n";
            report_str += `  天線增益 (G_ant) [自動]: ${formatNum(g_ant_db, 2).padStart(7)} dB\n`;
            report_str += `  天線雜訊溫度 (T_ant):   ${formatNum(t_ant, 2).padStart(7)} K\n`;
            report_str += `  鏈路總雜訊 (NF_total):    ${formatNum(nf_total_db, 2).padStart(7)} dB\n`;
            report_str += `  鏈路總增益 (G_link):      ${formatNum(total_gain_db, 2).padStart(7)} dB\n`;
            report_str += `    (主動/系統 增益):   ${formatNum(total_positive_gain_db, 2).padStart(7)} dB\n`;
            report_str += `    (被動元件 損耗):   ${formatNum(total_passive_gain_db, 2).padStart(7)} dB\n`;
            report_str += `  接收機雜訊溫度 (T_rx):    ${formatNum(t_rx, 2).padStart(7)} K\n`;
            report_str += `  系統雜訊溫度 (T_sys):     ${formatNum(t_sys, 2).padStart(7)} K (${formatNum(t_sys_dbk, 2)} dBK)\n`;
            report_str += "  --------------------------------------------------\n";
            report_str += `  **系統 G/T:** **${formatNum(g_over_t, 2).padStart(7)} dB/K**\n`;
        }
        report_str += "=".repeat(50) + "\n";
        return report_str;
    }
}

// --- 模組 2：GUI 控制介面 (Web App 主邏輯) ---
(function() {
    // --- 應用程式狀態 ---
    const calculator = new RFLInkBudget();
    let blocks = []; 
    let connections_TX = new Map(); 
    let connections_RX = new Map(); 
    let currentConnections = connections_TX; 
    
    // v8.1 合併功能: 相關狀態
    let isMergeSelectMode = false; 
    let mergeSelection = [];      

    let currentCalcMode = "TX";
    
    let lastCalcFreq = null;
    let lastCalcMode = null;
    
    // --- Canvas 相關狀態 ---
    let canvas, ctx;
    let canvasWidth, canvasHeight;
    let dragData = { item: null, offsetX: 0, offsetY: 0 };
    let lineData = { startComp: null, tempLineId: null, mouseX: 0, mouseY: 0 };
    let poutLabels = []; 

    // --- (v2.0) 縮放/平移狀態 ---
    let canvasZoom = 1.0;
    let canvasPan = { x: 0, y: 0 };
    let panData = { isPanning: false, startX: 0, startY: 0 };
    const MAX_ZOOM = 3.0;
    const MIN_ZOOM = 0.3;
    
    // --- 右鍵選單狀態 ---
    let rightClickedComp = null;
    let rightClickedLine = null;
    
    // --- 編輯視窗狀態 ---
    let editingComp = null;
    let editingSpecsCopy = null;
    let editingCurrentFreq = null;

    // --- DOM 元素 ---
    let dom = {};

    function init() {
        // --- 抓取 DOM 元素 ---
        dom.canvas = document.getElementById('rf-canvas');
        dom.ctx = dom.canvas.getContext('2d');
        canvas = dom.canvas;
        ctx = dom.ctx;
        
        dom.resultText = document.getElementById('result-text');
        dom.calcLogText = document.getElementById('calc-log-text'); 
        
        dom.entryFreq = document.getElementById('entry-freq'); 
        dom.entryPin = document.getElementById('entry-pin');
        dom.t0Label = document.getElementById('t0-label');
        dom.t0Label.textContent = `T0 (K): ${calculator.T0}`;
        dom.tabButtons = document.querySelectorAll('.tab-button');
        dom.tabContents = document.querySelectorAll('.tab-content');
        
        dom.calcButton = document.getElementById('calc-button');
        dom.clearButton = document.getElementById('clear-button');
        dom.clearLinesButton = document.getElementById('clear-lines-button'); 
        
        dom.loadCompBtn = document.getElementById('load-component');
        dom.fileLoaderInput = document.getElementById('file-loader-input');

        try {
            dom.exportButton = document.createElement('button');
            dom.exportButton.id = 'export-button';
            dom.exportButton.className = 'tool-button';
            dom.exportButton.textContent = '匯出報告 (Export)';
            dom.exportButton.title = '將目前的方塊圖和計算結果匯出為 HTML 檔案';
            dom.calcButton.parentNode.insertBefore(dom.exportButton, dom.calcButton.nextSibling);
            const spacer = document.createTextNode(' ');
            dom.calcButton.parentNode.insertBefore(spacer, dom.exportButton);
        } catch (e) {
            console.error("無法建立 '匯出報告' 按鈕:", e);
        }

        // --- 綁定事件 ---
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

        try {
            const unmergeLi = document.createElement('li');
            unmergeLi.id = 'menu-unmerge-comp';
            unmergeLi.textContent = '拆分元件 (Unmerge)';
            unmergeLi.style.display = 'none'; 
            
            const duplicateCompMenu = document.getElementById('menu-duplicate-comp');
            if (duplicateCompMenu) {
                duplicateCompMenu.parentNode.insertBefore(unmergeLi, duplicateCompMenu.nextSibling);
            } else {
                dom.blockContextMenu.appendChild(unmergeLi);
            }
        } catch (e) {
            console.error("無法建立 '拆分元件' 選單:", e);
        }

        // --- 注入 CSS ---
        try {
            const styleSheet = document.createElement("style");
            styleSheet.innerHTML = `
                #result-text, #calc-log-text {
                    height: 300px !important; 
                    overflow-y: auto !important;
                    font-size: 11px;
                }
                div.spec-tab-content {
                    max-height: 40vh; 
                    overflow-y: auto; 
                    padding: 10px;    
                    background: #222; 
                    border: 1px solid #555; 
                    border-radius: 3px;
                    margin-top: 5px; 
                }
            `;
            document.head.appendChild(styleSheet);
        } catch (e) {
            console.warn("無法注入 CSS: ", e);
        }

        // --- 綁定事件 ---
        window.addEventListener('resize', resizeCanvas); 
        dom.tabButtons.forEach(btn => btn.addEventListener('click', onTabChange));
        bindToolboxEvents(); 
        dom.calcButton.addEventListener('click', calculateLink);
        dom.clearButton.addEventListener('click', clearAll); 
        dom.clearLinesButton.addEventListener('click', clearAllLines); 
        dom.exportButton.addEventListener('click', exportFullReport);

        // Canvas 事件
        canvas.addEventListener('mousedown', onMouseDown);
        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('dblclick', onDoubleClick);
        canvas.addEventListener('contextmenu', onContextMenu);
        canvas.addEventListener('mouseleave', onMouseLeave);
        canvas.addEventListener('wheel', onMouseWheel);
        
        // Modal 事件
        dom.modalCloseBtn.addEventListener('click', closeEditModal);
        dom.modalCancelBtn.addEventListener('click', closeEditModal);
        dom.modalSaveBtn.addEventListener('click', saveEditModal);
        dom.modalAddFreqBtn.addEventListener('click', modalAddFreq);
        dom.modalDelFreqBtn.addEventListener('click', modalDelFreq);
        dom.modalFreqList.addEventListener('change', modalOnFreqSelect);
        
        // 右鍵選單事件
        bindContextMenuEvents();
        document.getElementById('menu-delete-comp').addEventListener('click', deleteComponent);
        document.getElementById('menu-duplicate-comp').addEventListener('click', duplicateComponent); 
        document.getElementById('menu-unmerge-comp').addEventListener('click', unmergeComponent); 
        document.getElementById('menu-cancel-block').addEventListener('click', () => dom.blockContextMenu.style.display = 'none');

        // 檔案載入
        dom.loadCompBtn.addEventListener('click', () => dom.fileLoaderInput.click());
        dom.fileLoaderInput.addEventListener('change', loadComponentFromFile);
        dom.mergeButton.addEventListener('click', onMergeComponents); 

        // --- 初始繪製 ---
        setTimeout(resizeCanvas, 0);
    }
    
    function bindToolboxEvents() {
        document.getElementById('add-lna').addEventListener('click', () => addBlock("LNA", false, false, {'1.0': {'TX': {'gain_db': 15, 'nf_db': 1.5, 'op1db_dbm': 20}, 'RX': {'gain_db': 15, 'nf_db': 1.5, 'op1db_dbm': 20}}}));
        document.getElementById('add-pa').addEventListener('click', () => addBlock("PA", false, false, {'1.0': {'TX': {'gain_db': 20, 'nf_db': 5, 'op1db_dbm': 33}, 'RX': {'gain_db': 20, 'nf_db': 5, 'op1db_dbm': 33}}}));
        document.getElementById('add-mixer').addEventListener('click', () => addBlock("Mixer", false, false, {'1.0': {'TX': {'gain_db':-7, 'nf_db': 7, 'op1db_dbm': 15}, 'RX': {'gain_db':-7, 'nf_db': 7, 'op1db_dbm': 15}}}));
        document.getElementById('add-filter').addEventListener('click', () => addBlock("Filter", true, false, {'1.0': {'TX': {'loss_db': 1.5}, 'RX': {'loss_db': 1.5}}}));
        document.getElementById('add-atten').addEventListener('click', () => addBlock("Atten", true, false, {'1.0': {'TX': {'loss_db': 6.0}, 'RX': {'loss_db': 6.0}}}));
        document.getElementById('add-div2').addEventListener('click', () => addBlock("1-2 Div", true, false, {'1.0': {'TX': {'loss_db': 3.5}, 'RX': {'loss_db': 3.5}}}));
        document.getElementById('add-div4').addEventListener('click', () => addBlock("1-4 Div", true, false, {'1.0': {'TX': {'loss_db': 7.0}, 'RX': {'loss_db': 7.0}}}));
        document.getElementById('add-trace').addEventListener('click', () => addBlock("Trace", true, false, {'1.0': {'TX': {'loss_db': 0.5}, 'RX': {'loss_db': 0.5}}}));
        
        document.getElementById('add-antenna').addEventListener('click', () => addBlock("Antenna", false, true, {'1.0': {'TX': {'gain_db': 12, 'nf_db': 0.0, 'op1db_dbm': 99}, 'RX': {'gain_db': 12, 'nf_db': 0.0, 'op1db_dbm': 99}}}));
        document.getElementById('add-array').addEventListener('click', () => addBlock("Array (N=16)", false, true, {'1.0': {'TX': {'gain_db': 12.04, 'nf_db': 0.0, 'op1db_dbm': 99}, 'RX': {'gain_db': 12.04, 'nf_db': 0.0, 'op1db_dbm': 99}}}));

        // v10.0: 新增 Air Loss 按鈕事件
        // 假設 HTML 中有 id="add-airloss" 的按鈕 (如果沒有請在 HTML 中新增)
        const airBtn = document.getElementById('add-airloss');
        if (airBtn) {
            airBtn.addEventListener('click', () => {
                 const defaultLoss = calculateFSPL(1.0, 100); 
                 addBlock("Air Loss", true, false, 
                    {'1.0': {'TX': {'loss_db': defaultLoss}, 'RX': {'loss_db': defaultLoss}}},
                    true // isAirLoss = true
                 );
            });
        }
    }

    function bindContextMenuEvents() {
        document.addEventListener('click', () => {
            dom.blockContextMenu.style.display = 'none';
            dom.lineContextMenu.style.display = 'none';
        });
        
        document.getElementById('menu-save-comp').addEventListener('click', saveComponent);
        document.getElementById('menu-delete-comp').addEventListener('click', deleteComponent);
        document.getElementById('menu-duplicate-comp').addEventListener('click', duplicateComponent); 
        document.getElementById('menu-unmerge-comp').addEventListener('click', unmergeComponent); 
        document.getElementById('menu-cancel-block').addEventListener('click', () => dom.blockContextMenu.style.display = 'none');
        
        document.getElementById('menu-delete-line').addEventListener('click', deleteSelectedLine);
        document.getElementById('menu-cancel-line').addEventListener('click', () => dom.lineContextMenu.style.display = 'none');
    }

    function resizeCanvas() {
        drawCanvas();
    }

    function getMousePos(e) {
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        return {
            x: (screenX - canvasPan.x) / canvasZoom,
            y: (screenY - canvasPan.y) / canvasZoom
        };
    }
    
    function getBlockAtPos(x, y) {
        for (let i = blocks.length - 1; i >= 0; i--) {
            const comp = blocks[i];
            if (x >= comp.x && x <= comp.x + comp.width &&
                y >= comp.y && y <= comp.y + comp.height) {
                return comp;
            }
        }
        return null;
    }
    
    function getLineAtPos(x, y, tolerance = 8) { 
        const worldTolerance = tolerance / canvasZoom;
        
        for (const [fromId, toId] of currentConnections.entries()) {
            const fromComp = blocks.find(b => b.id === fromId);
            const toComp = blocks.find(b => b.id === toId);
            if (!fromComp || !toComp) continue;
            
            const [x1, y1] = getLineIntersectionPoint(fromComp, toComp);
            const [x2, y2] = getLineIntersectionPoint(toComp, fromComp);

            const dx = x2 - x1;
            const dy = y2 - y1;
            const len = Math.sqrt(dx*dx + dy*dy);
            if (len === 0) continue;
            
            const nx = dx / len;
            const ny = dy / len;
            const apx = x - x1;
            const apy = y - y1;
            
            const projLen = apx * nx + apy * ny;
            if (projLen < -worldTolerance || projLen > len + worldTolerance) continue;

            const projX = x1 + projLen * nx;
            const projY = y1 + projLen * ny;
            const dist = Math.sqrt((x-projX)**2 + (y-projY)**2);

            if (dist <= worldTolerance) {
                return { fromComp, toComp, lineId: fromComp.id };
            }
        }
        return null;
    }
    
    function getLineIntersectionPoint(compA, compB) {
        const cxA = compA.x + compA.width / 2;
        const cyA = compA.y + compA.height / 2;
        const cxB = compB.x + compB.width / 2;
        const cyB = compB.y + compB.height / 2;
        
        const dx = cxB - cxA;
        const dy = cyB - cyA;
        
        if (dx === 0 && dy === 0) return [cxA, cyA];

        const halfW = compA.width / 2;
        const halfH = compA.height / 2;
        
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        let t = 1;
        const ratioX = (absDx > 0) ? halfW / absDx : Infinity;
        const ratioY = (absDy > 0) ? halfH / absDy : Infinity;

        let x, y;
        
        if (ratioX < ratioY) {
            t = ratioX;
            x = cxA + Math.sign(dx) * halfW;
            y = cyA + dy * t;
        } else {
            t = ratioY;
            x = cxA + dx * t;
            y = cyA + Math.sign(dy) * halfH;
        }

        return [x, y];
    }
    
    function clearAllHighlights() {
        let needsRedraw = false;
        blocks.forEach(comp => {
            if (comp.isHighlighted) {
                comp.isHighlighted = false;
                needsRedraw = true;
            }
        });
        if (needsRedraw) drawCanvas();
    }
    
    function clearAllSelections() {
        let needsRedraw = false;
        blocks.forEach(comp => {
            if (comp.isSelected) {
                comp.isSelected = false;
                needsRedraw = true;
            }
        });
        if (needsRedraw) drawCanvas();
    }

    function highlightBlock(comp, color) { 
        if (comp) {
            comp.isHighlighted = true;
            drawCanvas();
        }
    }

    // --- 主繪圖函式 ---
    function drawCanvas() {
        if (!ctx) return;
        
        const newWidth = canvas.clientWidth;
        const newHeight = canvas.clientHeight;
    
        if (canvas.width !== newWidth || canvas.height !== newHeight) {
            canvas.width = newWidth;
            canvas.height = newHeight;
            canvasWidth = canvas.width;
            canvasHeight = canvas.height;
        }
        
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        
        ctx.translate(canvasPan.x, canvasPan.y);
        ctx.scale(canvasZoom, canvasZoom);

        // 1. 繪製連線
        ctx.strokeStyle = "#F0F0F0"; 
        ctx.lineWidth = 2;
        for (const [fromId, toId] of currentConnections.entries()) {
            const fromComp = blocks.find(b => b.id === fromId);
            const toComp = blocks.find(b => b.id === toId);
            if (fromComp && toComp) {
                const [x1, y1] = getLineIntersectionPoint(fromComp, toComp);
                const [x2, y2] = getLineIntersectionPoint(toComp, fromComp);
                drawArrow(x1, y1, x2, y2, 'end');
            }
        }
        
        // 2. 繪製拖曳中的暫時線條
        if (lineData.startComp) {
            ctx.strokeStyle = "blue";
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 2]);
            const [x1, y1] = [lineData.startComp.x + lineData.startComp.width / 2, lineData.startComp.y + lineData.startComp.height / 2];
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(lineData.mouseX, lineData.mouseY);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // 3. 繪製方塊
        const shadowOffset = 3 * (1 / canvasZoom);
        const lightBorder = "#FFFFFF33"; 
        const darkBorder = "#00000088"; 
        const shadowColor = "#00000055"; 
        
        ctx.lineWidth = 1;

        for (const comp of blocks) {
            let mainColor;
            
            if (comp.isMerged) {
                mainColor = "#C8A2C8"; 
            } else if (comp.isSystem) { 
                mainColor = "#FFEAA7"; 
            } else if (comp.isPassive) { 
                mainColor = "#A8E6CF"; 
            } else { 
                mainColor = "#BDE0FE"; 
            }

            const specLines = comp.getDisplaySpecsLines(lastCalcFreq, lastCalcMode); 
            
            let childrenLinesCount = 0;
            let childrenNames = [];
            if (comp.isMerged && comp.childrenData.length > 0) {
                childrenNames = comp.childrenData.map(c => c.name); 
                childrenLinesCount = childrenNames.length;
            }
            
            let specLinesHeight = 0;
            if (specLines.length > 0) {
                 specLinesHeight = 10 + (specLines.length * 15);
                 if (comp.isMerged) specLinesHeight += 15; 
            }
            
            const childrenHeight = (childrenLinesCount > 0) ? (10 + childrenLinesCount * 15) : 0; 
            comp.height = 60 + specLinesHeight + childrenHeight;
            
            ctx.font = "bold 13px Arial";
            const nameWidth = ctx.measureText(comp.getDisplayName()).width;
            ctx.font = "12px Arial";
            const freqListWidth = ctx.measureText(comp.getDisplaySpecs()).width;
            
            let maxSpecWidth = 0;
            for(const line of specLines) {
                 ctx.font = line.startsWith("(") ? "italic 11px Arial" : "bold 12px Arial";
                maxSpecWidth = Math.max(maxSpecWidth, ctx.measureText(line).width);
            }

            if (childrenLinesCount > 0) {
                ctx.font = "italic bold 11px Arial";
                maxSpecWidth = Math.max(maxSpecWidth, ctx.measureText("--- (Original) ---").width);
                ctx.font = "italic 11px Arial";
                for (const childName of childrenNames) {
                    maxSpecWidth = Math.max(maxSpecWidth, ctx.measureText(childName).width);
                }
            }
            
            comp.width = Math.max(110, nameWidth + 40, freqListWidth + 40, maxSpecWidth + 40);
            
            // a. 陰影
            ctx.fillStyle = shadowColor;
            ctx.fillRect(comp.x + shadowOffset, comp.y + shadowOffset, comp.width, comp.height);
            
            // b. 主體
            ctx.fillStyle = mainColor;
            ctx.fillRect(comp.x, comp.y, comp.width, comp.height);
            
            // c. 邊框
            ctx.strokeStyle = lightBorder;
            ctx.beginPath();
            ctx.moveTo(comp.x, comp.y + comp.height);
            ctx.lineTo(comp.x, comp.y);
            ctx.lineTo(comp.x + comp.width, comp.y);
            ctx.stroke();
            
            ctx.strokeStyle = darkBorder;
            ctx.beginPath();
            ctx.moveTo(comp.x + comp.width, comp.y);
            ctx.lineTo(comp.x + comp.width, comp.y + comp.height);
            ctx.lineTo(comp.x, comp.y + comp.height);
            ctx.stroke();

            // e. 繪製文字
            ctx.fillStyle = "#111111"; 
            ctx.font = "bold 13px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            
            let y_pos = comp.y + 20;
            ctx.fillText(comp.getDisplayName(), comp.x + comp.width / 2, y_pos);
            
            y_pos += 18;
            ctx.fillStyle = "#222222"; 
            ctx.font = "12px Arial";
            ctx.fillText(comp.getDisplaySpecs(), comp.x + comp.width / 2, y_pos);

            if (specLines.length > 0) {
                y_pos += 12; // 分隔線
                ctx.fillStyle = "#555"; 
                ctx.fillText("---", comp.x + comp.width / 2, y_pos);
                
                for(const line of specLines) {
                    // v10.0: 顏色判斷
                    if (line.startsWith("Pin:") || line.startsWith("Pout:")) {
                        ctx.fillStyle = "#FFD700"; // 金黃色 (Power)
                        ctx.font = "bold 12px Consolas, monospace";
                    } else if (line.startsWith("Dist:")) {
                        ctx.fillStyle = "#2E8B57"; // 深綠色 (Distance)
                        ctx.font = "italic 11px Arial";
                    } else if (comp.isMerged) {
                         ctx.font = line.startsWith("(") ? "italic 11px Arial" : "bold 12px Arial";
                         ctx.fillStyle = line.startsWith("(") ? "#005A9E" : "#003366";
                    } else {
                        ctx.font = "bold 12px Arial";
                        ctx.fillStyle = "#005A9E";
                    }
                    y_pos += 15;
                    ctx.fillText(line, comp.x + comp.width / 2, y_pos);
                }
            }

            if (comp.isMerged && childrenNames.length > 0) {
                y_pos += 12; 
                ctx.fillStyle = "#222222"; 
                ctx.font = "italic bold 11px Arial";
                ctx.fillText("--- (Original) ---", comp.x + comp.width / 2, y_pos);
                
                ctx.fillStyle = "#111111"; 
                ctx.font = "italic 11px Arial";
                
                for(const childName of childrenNames) {
                    y_pos += 15;
                    ctx.fillText(childName, comp.x + comp.width / 2, y_pos);
                }
            }

            if(comp.isSelected) {
                ctx.strokeStyle = "#00FFFF"; 
                ctx.lineWidth = 3;
                ctx.setLineDash([8, 3]);
                ctx.strokeRect(comp.x - 2, comp.y - 2, comp.width + 4, comp.height + 4);
                ctx.setLineDash([]);
                ctx.lineWidth = 1;
            }
            
            if(comp.isHighlighted) {
                ctx.strokeStyle = "red";
                ctx.lineWidth = 3;
                ctx.strokeRect(comp.x - 1, comp.y - 1, comp.width + 2, comp.height + 2);
                ctx.lineWidth = 1;
            }
	    // --- v10.3 Updated: Pin/Pout 顯示優化 (RX 模式反向顯示 & P1dB 警示) ---
            if (comp.runtimeResults && comp.runtimeResults.freq === lastCalcFreq && comp.runtimeResults.mode === lastCalcMode) {
                 const pinVal = comp.runtimeResults.pin_dbm;
                 const poutVal = comp.runtimeResults.pout_dbm;
                 const pinText = `Pin: ${formatNum(pinVal, 1)} dBm`;
                 const poutText = `Pout: ${formatNum(poutVal, 1)} dBm`;

                 // 1. 判斷是否發生 P1dB 壓縮 (僅 TX 模式 & 非被動元件 & 非系統元件)
                 let isCompressed = false;
                 if (lastCalcMode === "TX" && !comp.isPassive && !comp.isSystem) {
                     const specs = comp.getSpecsForFreq(lastCalcFreq, lastCalcMode);
                     if (specs) {
                         const op1db = specs.op1db_dbm || 99.0;
                         if (poutVal > op1db) isCompressed = true;
                     }
                 }

                 ctx.font = "bold 12px Consolas, monospace";
                 ctx.textBaseline = "bottom"; 
                 const textY = comp.y + comp.height / 2 - 5; 

                 // 2. 根據模式決定顯示位置
                 let pinX, pinAlign, poutX, poutAlign;

                 if (lastCalcMode === "RX") {
                     // RX 模式：訊號由右向左，故 Pin 在右，Pout 在左
                     pinX = comp.x + comp.width + 6;
                     pinAlign = "left";
                     
                     poutX = comp.x - 6;
                     poutAlign = "right";
                 } else {
                     // TX 模式 (預設)：訊號由左向右，故 Pin 在左，Pout 在右
                     pinX = comp.x - 6;
                     pinAlign = "right";
                     
                     poutX = comp.x + comp.width + 6;
                     poutAlign = "left";
                 }

                 // 3. 繪製 Pin
                 ctx.textAlign = pinAlign;
                 ctx.fillStyle = "#FFD700"; 
                 ctx.fillText(pinText, pinX, textY);
                 
                 // 4. 繪製 Pout (含警示處理)
                 ctx.textAlign = poutAlign;

                 if (isCompressed) {
                     // P1dB 警示：紅字黃底
                     const textWidth = ctx.measureText(poutText).width;
                     ctx.fillStyle = "#FFFF00"; // 黃底
                     
                     // 計算背景框位置 (需根據對齊方向調整 x)
                     let rectX = (poutAlign === "left") ? poutX : (poutX - textWidth);
                     
                     ctx.fillRect(rectX - 2, textY - 14, textWidth + 4, 18);
                     
                     ctx.fillStyle = "#FF0000"; // 紅字
                     ctx.fillText(poutText, poutX, textY);
                 } else {
                     // 正常顯示
                     ctx.fillStyle = "#FFD700"; 
                     ctx.fillText(poutText, poutX, textY);
                 }
            }
        }
        
        ctx.restore();
    }
    
    function drawArrow(x1, y1, x2, y2, arrowType = 'end') {
        const headlen = 10; 
        const dx = x2 - x1;
        const dy = y2 - y1;
        const angle = Math.atan2(dy, dx);
        
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        
        const arrowHeadX = (arrowType === 'end') ? x2 : x1;
        const arrowHeadY = (arrowType === 'end') ? y2 : y1;
        const sign = (arrowType === 'end') ? -1 : 1;
        
        const angle1 = angle - Math.PI / 6;
        const angle2 = angle + Math.PI / 6;
        
        ctx.moveTo(arrowHeadX, arrowHeadY);
        ctx.lineTo(arrowHeadX + sign * headlen * Math.cos(angle1), arrowHeadY + sign * headlen * Math.sin(angle1));
        ctx.moveTo(arrowHeadX, arrowHeadY);
        ctx.lineTo(arrowHeadX + sign * headlen * Math.cos(angle2), arrowHeadY + sign * headlen * Math.sin(angle2));
        
        ctx.stroke();
    }
    
    // v10.0: 因為已直接顯示在方塊上，drawPoutLabels 仍保留作為 TX 模式下連線上的額外標示 (可選)
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
                        
                        poutLabels.push({
                            x: (x1 + x2) / 2,
                            y: (y1 + y2) / 2 - 10,
                            text: `${formatNum(pout_dbm, 2)} dBm`
                        });
                    }
                }
            }
        } catch (e) {
            console.error("繪製 Pout 標籤時出錯:", e);
        }
        drawCanvas();
    }

    // --- GUI 核心功能 ---
    
    // v10.0: 修改 addBlock 支援 isAirLoss
    function addBlock(name, isPassive, isSystem, defaultSpecs, isAirLoss = false) {
        const comp = new RFComponent(name, isPassive, isSystem, defaultSpecs, isAirLoss);
        const viewCenterX = (canvasWidth / 2 - canvasPan.x) / canvasZoom;
        const viewCenterY = (canvasHeight / 2 - canvasPan.y) / canvasZoom;
        
        comp.x = viewCenterX - comp.width / 2 + (Math.random() - 0.5) * 50;
        comp.y = viewCenterY - comp.height / 2 + (Math.random() - 0.5) * 50;
        
        blocks.push(comp);
        drawCanvas();
    }
    
    function clearAllLines() {
        if (confirm(`您確定要清除 ${currentCalcMode} 模式下的所有連線嗎？ (元件將會保留)`)) {
            currentConnections.clear(); 
            poutLabels = [];
            lastCalcFreq = null;
            dom.resultText.textContent = `(${currentCalcMode} 連線已清除，請重新計算)`;
            dom.calcLogText.textContent = `(${currentCalcMode} 連線已清除)`; 
            drawCanvas();
        }
    }

    function clearAll() {
        if (confirm("您確定要清除所有方塊和連線嗎？")) {
            calculator.clear();
            blocks = [];
            connections_TX.clear(); 
            connections_RX.clear(); 
            lineData = { startComp: null, tempLineId: null, mouseX: 0, mouseY: 0 };
            poutLabels = [];
            canvasZoom = 1.0;
            canvasPan = { x: 0, y: 0 };
            lastCalcFreq = null;
            lastCalcMode = null;
            dom.resultText.textContent = "(尚未計算)";
            dom.calcLogText.textContent = "(尚未計算)"; 
            drawCanvas();
        }
    }
    
    function onTabChange(e) {
        const targetTab = e.target.dataset.tab;
        
        dom.tabButtons.forEach(btn => btn.classList.remove('active'));
        e.target.classList.add('active');
        
        dom.tabContents.forEach(content => {
            content.classList.remove('active');
            if (content.id === targetTab) {
                content.classList.add('active');
            }
        });
        
        currentCalcMode = (targetTab === 'tx-tab') ? "TX" : "RX";
        
        if (currentCalcMode === "TX") {
            currentConnections = connections_TX;
        } else {
            currentConnections = connections_RX;
        }
        
        if (lastCalcFreq) {
            lastCalcMode = currentCalcMode;
        }
        
        if (currentCalcMode !== "TX") {
            poutLabels = [];
        }
        
        drawCanvas();
    }
    
    // --- Canvas 事件處理 ---
    function onMouseDown(e) {
        dom.blockContextMenu.style.display = 'none';
        dom.lineContextMenu.style.display = 'none';
        
        const { x, y } = getMousePos(e); 
        
        if (e.button === 1) { 
            panData.isPanning = true;
            panData.startX = e.clientX;
            panData.startY = e.clientY;
            canvas.classList.add('panning');
            e.preventDefault();
            return;
        }

        if (e.button === 0) { 
            const clickedBlock = getBlockAtPos(x, y);

            if (isMergeSelectMode) {
                if (clickedBlock) {
                    const compId = clickedBlock.id;
                    const index = mergeSelection.indexOf(compId);
                    
                    if (index > -1) {
                        mergeSelection.splice(index, 1);
                        clickedBlock.isSelected = false;
                    } else {
                        mergeSelection.push(compId);
                        clickedBlock.isSelected = true;
                    }
                    drawCanvas();
                }
                return; 
            }

            if (!clickedBlock && !e.ctrlKey && !e.metaKey) {
                 clearAllSelections();
            }

            if (e.ctrlKey || e.metaKey) { 
                if (clickedBlock) {
                    if (currentConnections.has(clickedBlock.id)) {
                        alert(`元件 '${clickedBlock.name}' 已經有輸出了。`);
                        return;
                    }
                    lineData.startComp = clickedBlock;
                    lineData.mouseX = x;
                    lineData.mouseY = y;
                }
            } else { 
                if (clickedBlock) {
                    clearAllSelections(); 
                    clickedBlock.isSelected = true; 
                    drawCanvas(); 

                    dragData.item = clickedBlock;
                    dragData.offsetX = x - clickedBlock.x;
                    dragData.offsetY = y - clickedBlock.y;
                    
                    blocks = blocks.filter(b => b.id !== clickedBlock.id);
                    blocks.push(clickedBlock);
                }
            }
        }
    }
    
    function onMouseMove(e) {
        if (panData.isPanning) {
            const dx = e.clientX - panData.startX;
            const dy = e.clientY - panData.startY;
            canvasPan.x += dx;
            canvasPan.y += dy;
            panData.startX = e.clientX;
            panData.startY = e.clientY;
            drawCanvas();
            return;
        }
        
        const { x, y } = getMousePos(e);

        if (dragData.item) {
            dragData.item.x = x - dragData.offsetX;
            dragData.item.y = y - dragData.offsetY;
            
            if (currentCalcMode === "TX" && poutLabels.length > 0) {
                drawPoutLabels();
            } else {
                drawCanvas();
            }
        } else if (lineData.startComp) {
            lineData.mouseX = x;
            lineData.mouseY = y;
            drawCanvas();
        } else {
            const block = getBlockAtPos(x, y);
            const line = getLineAtPos(x, y);
            if (block) {
                canvas.style.cursor = (e.ctrlKey || e.metaKey) ? 'crosshair' : 'move';
            } else if (line) {
                canvas.style.cursor = 'pointer';
            } else {
                canvas.style.cursor = 'default';
            }
        }
    }
    
    function onMouseUp(e) {
        if (panData.isPanning && e.button === 1) {
            panData.isPanning = false;
            canvas.classList.remove('panning');
            return;
        }

        const { x, y } = getMousePos(e);

        if (dragData.item) {
            dragData.item = null;
        } else if (lineData.startComp) {
            const endComp = getBlockAtPos(x, y);
            
            if (endComp && endComp.id !== lineData.startComp.id) {
                let hasInput = false;
                for (const toId of currentConnections.values()) {
                    if (toId === endComp.id) {
                        hasInput = true;
                        break;
                    }
                }
                
                if (hasInput) {
                    alert(`元件 '${endComp.name}' 已經有輸入了。`);
                } else {
                    currentConnections.set(lineData.startComp.id, endComp.id);
                }
            }
            lineData.startComp = null;
            drawCanvas();
        }
        canvas.style.cursor = 'default';
    }
    
    function onMouseLeave(e) {
        dragData.item = null;
        panData.isPanning = false;
        canvas.classList.remove('panning');
        
        if (lineData.startComp) {
            lineData.startComp = null;
            drawCanvas();
        }
    }

    function onDoubleClick(e) {
        dragData.item = null;
        
        if (isMergeSelectMode) return; 

        const { x, y } = getMousePos(e);
        const clickedBlock = getBlockAtPos(x, y);
        if (clickedBlock) {
            openEditModal(clickedBlock);
        }
    }
    
    function onContextMenu(e) {
        e.preventDefault();
        dragData.item = null;

        if (isMergeSelectMode) return;

        const { x, y } = getMousePos(e); 
        
        dom.blockContextMenu.style.display = 'none';
        dom.lineContextMenu.style.display = 'none';
        
        const clickedBlock = getBlockAtPos(x, y);
        const clickedLine = getLineAtPos(x, y);
        
        if (clickedBlock) {
            rightClickedComp = clickedBlock;
            showContextMenu(dom.blockContextMenu, e.clientX, e.clientY);
            const unmergeOption = document.getElementById('menu-unmerge-comp');
            if (unmergeOption) {
                if (clickedBlock.isMerged) {
                    unmergeOption.style.display = 'list-item'; 
                } else {
                    unmergeOption.style.display = 'none';
                }
            }
        } else if (clickedLine) {
            rightClickedLine = clickedLine;
            showContextMenu(dom.lineContextMenu, e.clientX, e.clientY);
        }
    }
    
    function onMouseWheel(e) {
        e.preventDefault(); 
        
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        const worldX = (screenX - canvasPan.x) / canvasZoom;
        const worldY = (screenY - canvasPan.y) / canvasZoom;
        
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        let newZoom = canvasZoom * delta;
        newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));

        if (newZoom === canvasZoom) return;

        canvasPan.x = screenX - (worldX * newZoom);
        canvasPan.y = screenY - (worldY * newZoom);

        canvasZoom = newZoom;
        drawCanvas();
    }
    
    function showContextMenu(menu, x, y) {
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.style.display = 'block';
    }

    // --- 右鍵選單功能 ---
    function saveComponent() {
        if (!rightClickedComp) return;
        
        const comp = rightClickedComp;
        const data = comp.toDict();
        const jsonString = JSON.stringify(data, null, 4);
        const blob = new Blob([jsonString], { type: 'application/json' });
        
        const defaultName = `${comp.name.replace(/ /g, "_").replace(/[()=]/g, "")}.json`;
        
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = prompt("請輸入檔名：", defaultName) || defaultName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        rightClickedComp = null;
    }
    
    function deleteComponent() {
        if (!rightClickedComp) return;
        
        const comp = rightClickedComp;
        if (confirm(`您確定要刪除元件 '${comp.name}' 嗎？\n(相關連線也會被刪除)`)) {
            blocks = blocks.filter(b => b.id !== comp.id);
            
            [connections_TX, connections_RX].forEach(map => {
                map.delete(comp.id); 
                let inKey = null;
                for (const [fromId, toId] of map.entries()) {
                    if (toId === comp.id) {
                        inKey = fromId;
                        break;
                    }
                }
                if (inKey) map.delete(inKey);
            });
            
            poutLabels = [];
            drawCanvas(); 
        }
        rightClickedComp = null;
    }
    
    function deleteSelectedLine() {
        if (!rightClickedLine) return;
        
        const { fromComp, toComp, lineId } = rightClickedLine;
        if (confirm(`您確定要刪除從 '${fromComp.name}' 到 '${toComp.name}' 的連接線嗎？`)) {
            if (currentConnections.has(lineId)) {
                currentConnections.delete(lineId);
                poutLabels = [];
                drawCanvas();
            }
        }
        rightClickedLine = null;
    }

    function duplicateComponent() {
        if (!rightClickedComp) return;
        
        try {
            const originalComp = rightClickedComp;
            const data = originalComp.toDict();
            const newComp = RFComponent.fromDict(data);
            
            newComp.name = `${originalComp.name} (Copy)`;
            newComp.x = originalComp.x + 20; 
            newComp.y = originalComp.y + 20;
            
            newComp.isSelected = false;
            newComp.isHighlighted = false;

            blocks.push(newComp);
            drawCanvas();

        } catch (e) {
            alert("複製元件時發生錯誤: " + e.message);
            console.error("Duplicate error:", e);
        }
        rightClickedComp = null;
    }

    function unmergeComponent() {
        if (!rightClickedComp || !rightClickedComp.isMerged) return;
        
        const mergedComp = rightClickedComp;
        rightClickedComp = null; 

        if (!confirm(`您確定要將 '${mergedComp.name}' 拆分為 ${mergedComp.childrenData.length} 個原始元件嗎？`)) {
            return;
        }

        try {
            const childrenData = mergedComp.childrenData;
            if (!childrenData || childrenData.length === 0) {
                throw new Error("此合併元件沒有子元件資料。");
            }

            const newComps = [];
            let totalWidth = 0;
            const h_spacing = 30; 
            
            for (const childData of childrenData) {
                const newComp = RFComponent.fromDict(childData);
                newComp.isSelected = false;
                newComp.isHighlighted = false;
                newComps.push(newComp);
                totalWidth += newComp.width;
            }
            totalWidth += (newComps.length - 1) * h_spacing;

            let currentX = mergedComp.x + (mergedComp.width / 2) - (totalWidth / 2);
            const startY = mergedComp.y;
            for (const comp of newComps) {
                comp.x = currentX;
                comp.y = startY;
                currentX += comp.width + h_spacing;
            }

            let inKeyTX = null, outKeyTX = null;
            let inKeyRX = null, outKeyRX = null;
            
            outKeyTX = connections_TX.get(mergedComp.id) || null;
            outKeyRX = connections_RX.get(mergedComp.id) || null;
            
            for (const [from, to] of connections_TX.entries()) {
                if (to === mergedComp.id) inKeyTX = from;
            }
            for (const [from, to] of connections_RX.entries()) {
                if (to === mergedComp.id) inKeyRX = from;
            }

            blocks = blocks.filter(b => b.id !== mergedComp.id);
            [connections_TX, connections_RX].forEach(map => {
                map.delete(mergedComp.id); 
                let inKey = null;
                for (const [from, to] of map.entries()) {
                    if (to === mergedComp.id) inKey = from;
                }
                if (inKey) map.delete(inKey);
            });
            
            blocks.push(...newComps);

            const firstChild = newComps[0];
            const lastChild = newComps[newComps.length - 1];

            if (inKeyTX) connections_TX.set(inKeyTX, firstChild.id);
            if (outKeyTX) connections_TX.set(lastChild.id, outKeyTX);
            if (inKeyRX) connections_RX.set(inKeyRX, firstChild.id);
            if (outKeyRX) connections_RX.set(lastChild.id, outKeyRX);

            for (let i = 0; i < newComps.length - 1; i++) {
                const fromComp = newComps[i];
                const toComp = newComps[i + 1];
                connections_TX.set(fromComp.id, toComp.id);
                connections_RX.set(fromComp.id, toComp.id);
            }

            drawCanvas();
            alert(`'${mergedComp.name}' 已成功拆分。`);

        } catch (e) {
            alert("拆分元件時發生錯誤: " + e.message);
            console.error("Unmerge error:", e);
        }
    }

    // --- 檔案 I/O ---
    function loadComponentFromFile(e) {
        const files = e.target.files;
        if (!files || files.length === 0) return;
        
        let loadedCount = 0;
        let totalToLoad = 0;
        const filesToProcess = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (file.type.match('application/json')) {
                filesToProcess.push(file);
            } else {
                console.warn(`檔案 ${file.name} 不是 JSON，已略過。`);
            }
        }
        totalToLoad = filesToProcess.length;
        if(totalToLoad === 0) {
             dom.fileLoaderInput.value = null;
             return;
        }

        filesToProcess.forEach((file, index) => {
            const reader = new FileReader();
            
            reader.onload = (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    const comp = RFComponent.fromDict(data); 
                    
                    const viewCenterX = (canvasWidth / 2 - canvasPan.x) / canvasZoom;
                    const viewCenterY = (canvasHeight / 2 - canvasPan.y) / canvasZoom;
                    
                    comp.x = viewCenterX - comp.width / 2 + (index * 20) % 200 - 100;
                    comp.y = viewCenterY - comp.height / 2 + (index * 20) % 200 - 100;
                    
                    blocks.push(comp);
                    loadedCount++;
                    
                } catch (err) {
                    alert(`無法載入檔案 ${file.name}: ${err.message}`);
                    loadedCount++;
                }
                
                if (loadedCount === totalToLoad) {
                    drawCanvas();
                }
            };
            
            reader.readAsText(file);
        });
        
        dom.fileLoaderInput.value = null;
    }
    
    // --- 編輯 Modal 邏輯 ---
    function openEditModal(comp) {
        editingComp = comp;
        editingSpecsCopy = JSON.parse(JSON.stringify(comp.specsByFreq));
        editingCurrentFreq = null;
        
        dom.modalTitle.textContent = `編輯元件: ${comp.name}`;
        dom.modalCompName.value = comp.name;
        
        modalRefreshFreqList();
        
        if (dom.modalFreqList.options.length > 0) {
            dom.modalFreqList.selectedIndex = 0;
            modalOnFreqSelect();
        } else {
            modalToggleSpecEntries(false);
        }
        
        dom.modal.style.display = 'flex';
    }
    
    function closeEditModal() {
        dom.modal.style.display = 'none';
        editingComp = null;
        editingSpecsCopy = null;
        editingCurrentFreq = null;
    }
    
    function saveEditModal() {
        if (editingCurrentFreq) {
            if (!modalSaveSpecsFromEntries(editingCurrentFreq)) {
                return; 
            }
        }
        
        const newName = dom.modalCompName.value;
        if (!newName) {
            alert("元件名稱不可為空。");
            return;
        }
        
        editingComp.name = newName;
        
        if (!editingComp.isMerged) {
             editingComp.specsByFreq = JSON.parse(JSON.stringify(editingSpecsCopy));
        }
       
        closeEditModal();
        drawCanvas();
    }
    
    function modalRefreshFreqList() {
        dom.modalFreqList.innerHTML = "";
        const freqs = Object.keys(editingSpecsCopy).sort((a, b) => parseFloat(a) - parseFloat(b));
        freqs.forEach(freq => {
            const option = document.createElement('option');
            option.value = freq;
            option.textContent = freq;
            dom.modalFreqList.appendChild(option);
        });
    }
    
    function modalOnFreqSelect() {
        if (editingCurrentFreq) {
            if (!modalSaveSpecsFromEntries(editingCurrentFreq)) {
                dom.modalFreqList.value = editingCurrentFreq;
                return;
            }
        }
        
        const selectedFreq = dom.modalFreqList.value;
        if (selectedFreq) {
            editingCurrentFreq = selectedFreq;
            modalToggleSpecEntries(true); 
            
            if (!editingComp.isMerged) {
                 modalLoadSpecsToEntries(selectedFreq);
            }
        } else {
            editingCurrentFreq = null;
            modalToggleSpecEntries(false);
        }
    }
    
    function modalAddFreq() {
        if (editingComp.isMerged) {
            alert("「合併元件」的頻點由其內部元件決定，無法手動新增。");
            return;
        }

        const newFreq = prompt("請輸入新的頻點 (例如 6.0):");
        if (!newFreq) return;
        
        try {
            parseFloat(newFreq);
            const newFreqStr = String(newFreq);
            if (newFreqStr in editingSpecsCopy) {
                alert("這個頻點已經存在。");
                return;
            }
            
            if (editingCurrentFreq) {
                modalSaveSpecsFromEntries(editingCurrentFreq);
            }
            
            let defaultSpecs = {};
            if (editingComp.isPassive) defaultSpecs = { 'loss_db': 0.0 };
            else defaultSpecs = { 'gain_db': 0.0, 'nf_db': 0.0, 'op1db_dbm': 99.0 };
            
            const tempComp = new RFComponent("temp", editingComp.isPassive, editingComp.isSystem);
            editingSpecsCopy[newFreqStr] = {
                "TX": tempComp.calculateSpecs(newFreqStr, "TX", defaultSpecs),
                "RX": tempComp.calculateSpecs(newFreqStr, "RX", defaultSpecs)
            };
            
            modalRefreshFreqList();
            dom.modalFreqList.value = newFreqStr;
            modalOnFreqSelect();
            
        } catch (e) {
            alert("請輸入一個有效的數字。");
        }
    }
    
    function modalDelFreq() {
        if (editingComp.isMerged) {
            alert("「合併元件」的頻點由其內部元件決定，無法手動刪除。");
            return;
        }

        if (!editingCurrentFreq) {
            alert("請先選擇一個要刪除的頻點。");
            return;
        }
        if (Object.keys(editingSpecsCopy).length <= 1) {
            alert("至少必須保留一個頻點。");
            return;
        }
        
        if (confirm(`您確定要刪除 ${editingCurrentFreq} GHz 嗎？`)) {
            delete editingSpecsCopy[editingCurrentFreq];
            editingCurrentFreq = null;
            modalRefreshFreqList();
            dom.modalFreqList.selectedIndex = 0;
            modalOnFreqSelect();
        }
    }
    
    // v10.0 Updated: Air Loss 儲存邏輯
    function modalSaveSpecsFromEntries(freqStr) {
        if (editingComp.isMerged) return true;
        if (!freqStr) return true;
        
        try {
            const fullSpecsDict = {};

            // --- v10.0: Air Loss 專用處理 ---
            if (editingComp.isAirLoss) {
                const mode = editingComp.airLossConfig.mode;
                let loss_db = 0.0;
                
                if (mode === 'calc') {
                    // 讀取距離
                    const distInput = document.getElementById('airloss-dist');
                    let distCm = parseFloat(distInput ? distInput.value : editingComp.airLossConfig.dist_cm);
                    if (isNaN(distCm) || distCm < 0) distCm = 0;
                    
                    // 更新全域設定
                    editingComp.airLossConfig.dist_cm = distCm;
                    
                    // 執行計算
                    loss_db = calculateFSPL(parseFloat(freqStr), distCm);
                } else {
                    // 手動模式
                    loss_db = parseFloat(document.getElementById('spec-tx-loss_db').value || 0.0);
                }
                
                // 儲存為被動元件規格
                const tempComp = new RFComponent("temp", true, false); // isPassive=true
                fullSpecsDict["TX"] = tempComp.calculateSpecs(freqStr, "TX", { 'loss_db': loss_db });
                fullSpecsDict["RX"] = fullSpecsDict["TX"]; // 鏡像
                
                editingSpecsCopy[freqStr] = fullSpecsDict;
                return true;
            }
            // ------------------------------------
            
            if (editingComp.isPassive) {
                const specsDict = {};
                specsDict['loss_db'] = parseFloat(document.getElementById('spec-tx-loss_db').value || 0.0);
                
                const tempComp = new RFComponent("temp", editingComp.isPassive, false);
                fullSpecsDict["TX"] = tempComp.calculateSpecs(freqStr, "TX", specsDict);
                fullSpecsDict["RX"] = fullSpecsDict["TX"];
            } else {
                let txSpecs = {};
                let rxSpecs = {};

                if (editingComp.isSystem) {
                    txSpecs = {
                        'gain_db': parseFloat(document.getElementById('spec-tx-gain_db').value || 0.0),
                        'nf_db': 0.0,
                        'op1db_dbm': 99.0
                    };
                    rxSpecs = {
                        'gain_db': parseFloat(document.getElementById('spec-rx-gain_db').value || 0.0),
                        'nf_db': 0.0
                    };
                } else {
                    txSpecs = {
                        'gain_db': parseFloat(document.getElementById('spec-tx-gain_db').value || 0.0),
                        'nf_db': parseFloat(document.getElementById('spec-tx-nf_db').value || 0.0),
                        'op1db_dbm': parseFloat(document.getElementById('spec-tx-op1db_dbm').value || 99.0)
                    };
                    rxSpecs = {
                        'gain_db': parseFloat(document.getElementById('spec-rx-gain_db').value || 0.0),
                        'nf_db': parseFloat(document.getElementById('spec-rx-nf_db').value || 0.0)
                    };
                }

                const tempComp = new RFComponent("temp", false, editingComp.isSystem);
                fullSpecsDict["TX"] = tempComp.calculateSpecs(freqStr, "TX", txSpecs);
                fullSpecsDict["RX"] = tempComp.calculateSpecs(freqStr, "RX", rxSpecs);
            }
            
            editingSpecsCopy[freqStr] = fullSpecsDict;
            return true;
        } catch (e) {
            alert("輸入錯誤：請在所有欄位輸入有效的數字。");
            return false;
        }
    }
        // v10.0 Fix: 修正 Air Loss 元件報錯問題
    function modalLoadSpecsToEntries(freqStr) {
        // 合併元件不需要載入
        if (editingComp.isMerged) return;
        
        // --- (新增) Air Loss 元件已經在介面生成時填入數值，不需由此載入，避免找不到欄位報錯 ---
        if (editingComp.isAirLoss) return;
        // ---------------------------------------------------------------------------------

        const freqData = editingSpecsCopy[freqStr];
        if (!freqData) return;

        const tempComp = new RFComponent("temp", editingComp.isPassive, editingComp.isSystem);
        tempComp.specsByFreq = editingSpecsCopy;
        
        const txRaw = tempComp.getRawSpecsForFreq(freqStr, "TX");
        const rxRaw = tempComp.getRawSpecsForFreq(freqStr, "RX");

        if (editingComp.isPassive) {
            const lossInput = document.getElementById('spec-tx-loss_db');
            if (lossInput) lossInput.value = txRaw.loss_db;
        } else {
            if (editingComp.isSystem) {
                document.getElementById('spec-tx-gain_db').value = txRaw.gain_db;
                document.getElementById('spec-rx-gain_db').value = rxRaw.gain_db;
            } else {
                document.getElementById('spec-tx-gain_db').value = txRaw.gain_db;
                document.getElementById('spec-tx-nf_db').value = txRaw.nf_db;
                document.getElementById('spec-tx-op1db_dbm').value = txRaw.op1db_dbm;
                document.getElementById('spec-rx-gain_db').value = rxRaw.gain_db;
                document.getElementById('spec-rx-nf_db').value = rxRaw.nf_db;
            }
        }
    }

    
    function buildMergedSpecDisplay(mode, freqStr) {
        const children = editingComp.childrenData;
        if (!children || children.length === 0) return " (內部元件資料遺失)";

        let html = `
            <div style="padding: 5px; background: #2A2A2A; border-radius: 3px; margin-bottom: 10px;">
                <h4 style="margin: 0 0 5px 0; color: #C8A2C8;">原始元件規格 (唯讀)</h4>
                <div class="spec-merged-list" style="font-size: 13px; line-height: 1.6;">
        `;

        children.forEach((child, index) => {
            const childFreqData = child.specs_by_freq[freqStr];
            const rawSpecs = childFreqData ? childFreqData[mode] : null; 

            html += `<div class="spec-merged-item" style="border-top: 1px solid #444; padding: 4px 0;">`;
            html += `<strong style="color: #E0E0E0;">${index + 1}. ${child.name}</strong><br>`;
            
            if (rawSpecs) {
                if (child.isPassive) {
                    html += `&nbsp;&nbsp;&nbsp;L (TX/RX): ${formatNum(rawSpecs.loss_db || 0, 1)} dB`;
                    html += ` | NF: ${formatNum(rawSpecs.loss_db || 0, 1)} dB`;
                } else {
                    let specLine = `&nbsp;&nbsp;&nbsp;G: ${formatNum(rawSpecs.gain_db || 0, 1)} dB | NF: ${formatNum(rawSpecs.nf_db || 0, 1)} dB`;
                    
                    if (mode === "TX" && !child.isPassive && !child.isSystem) {
                         specLine += ` | P1: ${formatNum(rawSpecs.op1db_dbm || 99, 1)} dBm`;
                    }
                    
                    html += specLine;
                }
            } else {
                html += `&nbsp;&nbsp;&nbsp;<span style="color: #AAA;">(無 ${freqStr} GHz / ${mode} 模式資料)</span>`;
            }
            html += `</div>`;
        });

        html += '</div></div>';
        
        const cascadedSpecs = editingSpecsCopy[freqStr] ? editingSpecsCopy[freqStr][mode] : null;
        if (cascadedSpecs) {
            const active_gain_db = (cascadedSpecs.active_gain_db || 0);
            const system_gain_db_orig = (cascadedSpecs.system_gain_db || 0);
            const passive_gain_db_orig = (cascadedSpecs.passive_gain_db || 0);
            const passive_gain_db_display = passive_gain_db_orig + system_gain_db_orig;
                
            const labelStyle = "display: inline-block; width: 160px; text-align: right; padding-right: 5px;";
            const gainDigits = 1;
            const nfDigits = 1;
            const p1dbDigits = 1;
                
             html += `
                <div style="padding: 5px; background: #2A2A2A; border-radius: 3px; margin-top: 15px;">
                    <h4 style="margin: 0 0 5px 0; color: #A8E6CF;">合併後總規格 (唯讀)</h4>
                                        <div style="font-size: 13px; line-height: 1.6; font-family: 'Courier New', monospace;">
                                                <strong>Gain list (dB):</strong><br>
                        &nbsp;&nbsp;<span style="${labelStyle}">Active Gain(dB)</span> ${formatNum(active_gain_db, gainDigits).padStart(6)} dB<br>
                        &nbsp;&nbsp;<span style="${labelStyle}">Passive Gain(dB)</span> ${formatNum(passive_gain_db_display, gainDigits).padStart(6)} dB<br>
                        &nbsp;&nbsp;<strong style="color: #FFF;"><span style="${labelStyle}">System Gain(dB)</span> ${formatNum(cascadedSpecs.gain_db, gainDigits).padStart(6)} dB</strong><br>
                                                <strong style="margin-top: 5px; display: inline-block;">總規格:</strong><br>
                        &nbsp;&nbsp;<span style="${labelStyle}">Total NF:</span> ${formatNum(cascadedSpecs.nf_db, nfDigits).padStart(6)} dB<br>
            `;
            if (mode === "TX") {
                 html += `&nbsp;&nbsp;<span style="${labelStyle}">P1dB:</span> ${formatNum(cascadedSpecs.op1db_dbm, p1dbDigits).padStart(6)} dBm`;
            }
            html += `
                    </div>
                </div>
            `;
        }

        return html;
    }

    // v10.0 Fix: 修改 modalToggleSpecEntries，讓 Air Loss 距離改變時即時更新計算結果
    function modalToggleSpecEntries(freqSelected) {
        dom.modalSpecEditors.innerHTML = "";
        
        if (!freqSelected) {
            dom.modalSpecEditors.innerHTML = `<div id="spec-status-label">請選擇或新增一個頻點</div>`;
            return;
        }
        
        dom.modalSpecEditors.innerHTML = `<div id="spec-status-label" style="margin-bottom: 10px;">正在編輯: ${editingCurrentFreq} GHz</div>`;
        
        if (editingComp && editingComp.isMerged) {
            dom.modalSpecEditors.innerHTML += `<div style="color: #C8A2C8; font-weight: bold; margin-bottom: 10px; padding: 5px; background: #444; border-radius: 3px;">
                注意：您正在編輯一個「合併元件」。
            </div>`;
        }

        // --- v10.0 Updated: Air Loss 專用介面 (加入即時計算) ---
        if (editingComp.isAirLoss) {
             const fieldset = document.createElement('fieldset');
             fieldset.innerHTML = `<legend>Air Loss 設定 (@ ${editingCurrentFreq} GHz)</legend>`;
             
             const mode = editingComp.airLossConfig.mode; // 'calc' or 'manual'
             const dist = editingComp.airLossConfig.dist_cm;
             
             const currentLoss = editingComp.getRawSpecsForFreq(editingCurrentFreq, "TX").loss_db || 0;

             fieldset.innerHTML += `
                <div style="margin-bottom: 10px;">
                    <label>計算模式:</label>
                    <select id="airloss-mode-select" style="width: 100%; padding: 5px; margin-top: 5px;">
                        <option value="calc" ${mode === 'calc' ? 'selected' : ''}>自動計算 (依距離 & 頻率)</option>
                        <option value="manual" ${mode === 'manual' ? 'selected' : ''}>手動輸入 Loss</option>
                    </select>
                </div>
             `;
             
             if (mode === 'calc') {
                 // 為計算結果輸入框加入 id="airloss-calc-result" 以便 JS 抓取
                 fieldset.innerHTML += `
                    <div class="spec-grid">
                        <label for="airloss-dist">距離 (cm):</label>
                        <input type="number" id="airloss-dist" value="${dist}" step="1">
                        <label>計算結果 (Loss):</label>
                        <input type="text" id="airloss-calc-result" value="${formatNum(currentLoss, 2)} dB" disabled style="background:#444; color:#aaa;">
                    </div>
                    <div style="font-size: 11px; color: #888; margin-top: 5px;">
                       公式: FSPL = 20log10(4πdf/c)
                    </div>
                 `;
             } else {
                 fieldset.innerHTML += `
                    <div class="spec-grid">
                        <label for="spec-tx-loss_db">損耗 (Loss) (dB):</label>
                        <input type="text" id="spec-tx-loss_db" value="${currentLoss}">
                    </div>
                 `;
             }
             
             dom.modalSpecEditors.appendChild(fieldset);
             
             // 綁定模式切換事件
             document.getElementById('airloss-mode-select').addEventListener('change', (e) => {
                 editingComp.airLossConfig.mode = e.target.value;
                 modalToggleSpecEntries(editingCurrentFreq); 
             });

             // --- (新增) 綁定距離輸入事件，實現即時計算 ---
             if (mode === 'calc') {
                 const distInput = document.getElementById('airloss-dist');
                 const resultInput = document.getElementById('airloss-calc-result');
                 
                 if (distInput && resultInput) {
                     distInput.addEventListener('input', () => {
                         const val = parseFloat(distInput.value);
                         if (!isNaN(val) && val >= 0) {
                             // 即時計算 Loss
                             const newLoss = calculateFSPL(parseFloat(editingCurrentFreq), val);
                             // 更新顯示
                             resultInput.value = `${formatNum(newLoss, 2)} dB`;
                         } else {
                             resultInput.value = "---";
                         }
                     });
                 }
             }
             // -------------------------------------------
             
             return; 
        }
        // --------------------------------

        // ... (以下維持原有的 Passive / Active / System 邏輯不變) ...
        if (editingComp.isPassive) {
             // ... (原程式碼) ...
             const fieldset = document.createElement('fieldset');
             fieldset.innerHTML = `<legend>規格 (TX/RX 共用)</legend>`;
             // ... (略) ...
             const grid = document.createElement('div');
             grid.className = 'spec-grid';
             grid.innerHTML = `
                <label for="spec-tx-loss_db">損耗 (Loss) (dB):</label>
                <input type="text" id="spec-tx-loss_db">
            `;
            fieldset.appendChild(grid);
            dom.modalSpecEditors.appendChild(fieldset);
        } else {
             // ... (原程式碼 Active/System 部分) ...
             dom.modalSpecEditors.innerHTML += `
                <div class="spec-tabs">
                    <button class="spec-tab-btn active" data-tab="tx">TX</button>
                    <button class="spec-tab-btn" data-tab="rx">RX</button>
                </div>
                <div id="spec-tab-tx" class="spec-tab-content"></div>
                <div id="spec-tab-rx" class="spec-tab-content hidden"></div>
            `;
            // ... (略: 這部分請保持原本的樣子) ...
            
            // 為了完整性，這裡簡略帶過原本的 Active 邏輯，請確保沒有刪除這部分
            if (editingComp.isMerged && editingComp.childrenData.length > 0) {
                 document.getElementById('spec-tab-tx').innerHTML = buildMergedSpecDisplay('TX', editingCurrentFreq);
                 document.getElementById('spec-tab-rx').innerHTML = buildMergedSpecDisplay('RX', editingCurrentFreq);
            } else {
                if (editingComp.isSystem) {
                    // System logic...
                    document.getElementById('spec-tab-tx').innerHTML = `<div class="spec-grid"><label for="spec-tx-gain_db">增益 (Gain) (dB):</label><input type="text" id="spec-tx-gain_db"></div>`;
                    document.getElementById('spec-tab-rx').innerHTML = `<div class="spec-grid"><label for="spec-rx-gain_db">增益 (Gain) (dB):</label><input type="text" id="spec-rx-gain_db"></div>`;
                } else {
                    // Active logic...
                    document.getElementById('spec-tab-tx').innerHTML = `<div class="spec-grid"><label for="spec-tx-gain_db">增益 (Gain) (dB):</label><input type="text" id="spec-tx-gain_db"><label for="spec-tx-nf_db">雜訊指數 (NF) (dB):</label><input type="text" id="spec-tx-nf_db"><label for="spec-tx-op1db_dbm">輸出 P1dB (dBm):</label><input type="text" id="spec-tx-op1db_dbm"></div>`;
                    document.getElementById('spec-tab-rx').innerHTML = `<div class="spec-grid"><label for="spec-rx-gain_db">增益 (Gain) (dB):</label><input type="text" id="spec-rx-gain_db"><label for="spec-rx-nf_db">雜訊指數 (NF) (dB):</label><input type="text" id="spec-rx-nf_db"></div>`;
                }
            }

            dom.modalSpecEditors.querySelectorAll('.spec-tab-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    dom.modalSpecEditors.querySelectorAll('.spec-tab-btn').forEach(b => b.classList.remove('active'));
                    dom.modalSpecEditors.querySelectorAll('.spec-tab-content').forEach(c => c.classList.add('hidden'));
                    e.target.classList.add('active');
                    document.getElementById(`spec-tab-${e.target.dataset.tab}`).classList.remove('hidden');
                });
            });
        }
    }
    
    // --- 計算邏輯 (拓撲排序) ---
    
    function topologicalSortChain() {
        const allCompsInMap = new Set();
        const allBlocksInCurrentChain = new Set();
        
        for (const [fromId, toId] of currentConnections.entries()) {
            allCompsInMap.add(fromId);
            allCompsInMap.add(toId);
            allBlocksInCurrentChain.add(fromId);
            allBlocksInCurrentChain.add(toId);
        }
        
        const allBlocksInMapAsObjs = new Set(blocks.filter(b => allBlocksInCurrentChain.has(b.id)));
        
        const destinationComps = new Set();
        for (const toId of currentConnections.values()) {
            destinationComps.add(toId);
        }

        const startNodes = new Set();
        for (const comp of allBlocksInMapAsObjs) {
            if (!destinationComps.has(comp.id)) {
                startNodes.add(comp.id);
            }
        }
        
        if (allBlocksInMapAsObjs.size === 0) {
            alert(`目前 ${currentCalcMode} 模式下沒有連線，請先繪製鏈路。`);
            return null;
        }
        if (startNodes.size === 0) {
            alert(`拓撲錯誤：找不到起始元件（${currentCalcMode} 模式）。\n請檢查是否有迴路。`);
            return null;
        }
        if (startNodes.size > 1) {
            alert(`拓撲警告：發現 ${startNodes.size} 個起始元件，將隨機選一個開始計算。`);
        }
        
        const startNodeId = [...startNodes][0];
        const sortedChain = [];
        let currentId = startNodeId;
        
        while (currentId) {
            const currentComp = blocks.find(b => b.id === currentId);
            if (!currentComp) break; 
            
            if (sortedChain.includes(currentComp)) {
                alert(`拓撲錯誤：檢測到迴路！元件 '${currentComp.name}' 被重複訪問。`);
                return null;
            }
            sortedChain.push(currentComp);
            currentId = currentConnections.get(currentId);
        }
        return sortedChain;
    }
    
    function getFloat(value, defaultVal = 0.0) {
        try {
            const f = parseFloat(value);
            return isNaN(f) ? defaultVal : f;
        } catch (e) {
            return defaultVal;
        }
    }
    
    function calculateLink() {
        dragData.item = null;
        
        clearAllHighlights();
        poutLabels = [];
        
        try {
            let sortedChain = topologicalSortChain();
            if (!sortedChain) return;
            
            const calcFreq = dom.entryFreq.value;
            if (!calcFreq) {
                alert("請在頂部輸入計算頻率 (GHz)");
                dom.entryFreq.focus();
                return;
            }
            const calcFreqStr = String(calcFreq);
            
            const p_in = getFloat(dom.entryPin.value, -100.0);
            
            calculator.setSystemParams(p_in);
            calculator.setChain(sortedChain);
            calculator.calculate(calcFreqStr, currentCalcMode);
            
            const report = calculator.getReport(calcFreqStr, currentCalcMode);
            const calcLog = calculator.getCalcLog(); 
            
            dom.resultText.textContent = report;
            dom.calcLogText.textContent = calcLog; 
            
            lastCalcFreq = calcFreqStr;
            lastCalcMode = currentCalcMode;
            
            if (currentCalcMode === "TX") {
                drawPoutLabels(); 
            } else {
                drawCanvas(); 
            }
            
        } catch (e) {
            if (e instanceof CompressionError) {
                alert(`計算錯誤 (P1dB 壓縮):\n${e.message}`);
                highlightBlock(e.component, "red");
            } else {
                alert(`計算錯誤: ${e.message}`);
                console.error(e);
            }
        }
    }

    // --- (v8.1 合併功能) 核心邏輯 ---

    function topologicalSortComponents(components, connections) {
        const compIds = new Set(components.map(c => c.id));
        const inDegree = new Map();
        const adj = new Map();
        
        components.forEach(c => {
            inDegree.set(c.id, 0);
            adj.set(c.id, []);
        });
        
        for (const [fromId, toId] of connections.entries()) {
            if (compIds.has(fromId) && compIds.has(toId)) {
                adj.get(fromId).push(toId);
                inDegree.set(toId, inDegree.get(toId) + 1);
            }
        }
        
        const queue = [];
        for (const [id, degree] of inDegree.entries()) {
            if (degree === 0) {
                queue.push(id);
            }
        }

        if (queue.length === 0) throw new Error("合併錯誤：選擇的元件中存在迴路。");
        if (queue.length > 1) throw new Error(`合併錯誤：選擇的元件必須是 *單一* 且 *連續* 的鏈路 (偵測到 ${queue.length} 個起始點)。`);

        const sortedIds = [];
        while (queue.length > 0) {
            const u = queue.shift();
            sortedIds.push(u);
            
            for (const v of adj.get(u)) {
                inDegree.set(v, inDegree.get(v) - 1);
                if (inDegree.get(v) === 0) {
                    queue.push(v);
                }
            }
        }
        
        if (sortedIds.length !== components.length) {
            throw new Error("合併錯誤：選擇的元件不連續或包含迴路。");
        }
        
        return sortedIds.map(id => components.find(c => c.id === id));
    }

    function executeMerge(selectedIds) {
        if (selectedIds.length < 2) {
            alert("合併錯誤：請至少選擇 2 個元件。");
            return;
        }

        const selectedComps = blocks.filter(b => selectedIds.includes(b.id));

        try {
            const sortedChain = topologicalSortComponents(selectedComps, currentConnections);
            
            const allFreqs = new Set();
            sortedChain.forEach(c => c.getAvailableFreqs().forEach(f => allFreqs.add(f)));
            if (allFreqs.size === 0) throw new Error("所選元件沒有可用的頻點資料。");
            
            const validFreqs = [];
            for (const freq of allFreqs) {
                let isFreqCommon = true;
                for (const comp of sortedChain) {
                    if (!comp.getSpecsForFreq(freq, "TX") || !comp.getSpecsForFreq(freq, "RX")) {
                        isFreqCommon = false;
                        break; 
                    }
                }
                
                if (isFreqCommon) {
                    validFreqs.push(freq);
                }
            }

            if (validFreqs.length === 0) {
                throw new Error("合併失敗：選擇的元件之間沒有任何共同的可用頻點。\n\n(例如：元件 A 只有 3.5 GHz，元件 B 只有 28 GHz)");
            }

            const validFreqsArray = [...validFreqs].sort((a, b) => parseFloat(a) - parseFloat(b));
            const displayFreq = lastCalcFreq && validFreqs.includes(lastCalcFreq) ? lastCalcFreq : validFreqsArray[0];

            let confirmMsg = `您即將合併以下 ${sortedChain.length} 個元件 (依 ${currentCalcMode} 模式排序)：\n`;
            confirmMsg += "========================================\n";
            sortedChain.forEach((comp, index) => {
                confirmMsg += `(${(index + 1)}) ${comp.name}\n`;
            });
            confirmMsg += "========================================\n";
            confirmMsg += `可合併的共同頻點: ${validFreqsArray.join(', ')} GHz\n\n`; 
            confirmMsg += `--- 規格預覽 (@ ${displayFreq} GHz) ---\n`;

            for (const comp of sortedChain) {
                confirmMsg += `\n* ${comp.name}:\n`;
                const txSpecs = comp.getRawSpecsForFreq(displayFreq, "TX");
                const rxSpecs = comp.getRawSpecsForFreq(displayFreq, "RX");

                if (!txSpecs || !rxSpecs) {
                     throw new Error(`(預覽錯誤) 元件 ${comp.name} 在 ${displayFreq} GHz 缺少 TX 或 RX 規格。`);
                }

                if (comp.isPassive) {
                    confirmMsg += `  L (TX/RX): ${formatNum(txSpecs.loss_db, 1)} dB\n`;
                    confirmMsg += `  NF (TX/RX): ${formatNum(txSpecs.loss_db, 1)} dB\n`;
                } else {
                    let txLine = `  TX: G:${formatNum(txSpecs.gain_db, 1)} | NF:${formatNum(txSpecs.nf_db, 1)}`;
                    
                    if (currentCalcMode === "TX" && !comp.isPassive && !comp.isSystem) {
                         txLine += ` | P1:${formatNum(txSpecs.op1db_dbm || 99, 1)}`;
                    }

                    confirmMsg += txLine + '\n';
                    confirmMsg += `  RX: G:${formatNum(rxSpecs.gain_db, 1)} | NF:${formatNum(rxSpecs.nf_db, 1)}\n`; 
                }
            }
            confirmMsg += "\n您確定要繼續合併嗎？";

            if (!confirm(confirmMsg)) {
                return; 
            }
            
            const newName = prompt("請輸入新元件的名稱:", "Merged-" + sortedChain[0].name);
            if (!newName) return; 

            const newSpecsByFreq = {};
            const tempCalculator = new RFLInkBudget();

            for (const freq of validFreqs) {
                
                const chainForTX = sortedChain;
                const chainForRX = sortedChain;
                
                tempCalculator.setChain(chainForTX);
                tempCalculator.setSystemParams(-100); 
                tempCalculator.calculate(freq, "TX");
                const txRes = tempCalculator.results.chain;
                
                tempCalculator.setChain(chainForRX);
                tempCalculator.setSystemParams(-100); 
                tempCalculator.calculate(freq, "RX");
                const rxRes = tempCalculator.results.chain;
                
                newSpecsByFreq[freq] = {
                    "TX": {
                        'gain_db': txRes.total_gain_db,
                        'nf_db': txRes.total_nf_db,
                        'op1db_dbm': txRes.total_op1db_dbm,
                        'active_gain_db': txRes.total_active_gain_db,
                        'passive_gain_db': txRes.total_passive_gain_db,
                        'system_gain_db': txRes.total_system_gain_db
                    },
                    "RX": {
                        'gain_db': rxRes.total_gain_db,
                        'nf_db': rxRes.total_nf_db,
                        'op1db_dbm': rxRes.total_op1db_dbm, 
                        'active_gain_db': rxRes.total_active_gain_db,
                        'passive_gain_db': rxRes.total_passive_gain_db,
                        'system_gain_db': rxRes.total_system_gain_db
                    }
                };
            }

            const startComp = sortedChain[0];
            const endComp = sortedChain[sortedChain.length - 1];

            let inKeyTX = null, outKeyTX = null;
            let inKeyRX = null, outKeyRX = null;
            
            outKeyTX = connections_TX.get(endComp.id) || null;
            outKeyRX = connections_RX.get(endComp.id) || null;
            
            for (const [from, to] of connections_TX.entries()) {
                if (to === startComp.id) inKeyTX = from;
            }
            for (const [from, to] of connections_RX.entries()) {
                if (to === startComp.id) inKeyRX = from;
            }
            
            const mergedComp = new RFComponent(newName, false, false, newSpecsByFreq);
            mergedComp.x = startComp.x; 
            mergedComp.y = startComp.y;
            
            mergedComp.isMerged = true;
            mergedComp.childrenData = sortedChain.map(c => c.toDict());
            
            blocks.push(mergedComp);
            
            const selectedIdsSet = new Set(selectedIds);
            blocks = blocks.filter(b => !selectedIdsSet.has(b.id));
            
            [connections_TX, connections_RX].forEach(map => {
                selectedIds.forEach(id => {
                    map.delete(id); 
                });
                for (const [from, to] of map.entries()) {
                    if (selectedIdsSet.has(to)) {
                        map.delete(from); 
                    }
                }
            });
            
            if (inKeyTX) connections_TX.set(inKeyTX, mergedComp.id);
            if (outKeyTX) connections_TX.set(mergedComp.id, outKeyTX);
            if (inKeyRX) connections_RX.set(inKeyRX, mergedComp.id);
            if (outKeyRX) connections_RX.set(mergedComp.id, outKeyRX);

            alert(`元件 "${newName}" 合併成功！`);

        } catch (e) {
            alert(`合併失敗: ${e.message}`);
            console.error(e);
        }
    }

    function onMergeComponents() {
        if (!isMergeSelectMode) {
            isMergeSelectMode = true;
            mergeSelection = [];
            clearAllSelections(); 
            
            dom.mergeButton.textContent = "完成合併";
            
            alert(`進入「合併選取」模式。\n\n請在畫布上點擊您要合併的元件 (必須是 ${currentCalcMode} 模式下的一條連續鏈路)，完成後請再次點擊「完成合併」。`);

        } else {
            isMergeSelectMode = false;
            dom.mergeButton.textContent = "合併元件";

            try {
                executeMerge(mergeSelection);
            } finally {
                mergeSelection = [];
                clearAllSelections();
                drawCanvas();
            }
        }
    }

    function exportFullReport() {
        if (!lastCalcFreq || !calculator.results.chain) {
            alert("請先執行一次計算 (Calculate)，再匯出報告。");
            return;
        }
        
        let imgDataUrl;
        try {
             const poutLabels_backup = poutLabels;
             poutLabels = [];
             drawCanvas();
             imgDataUrl = canvas.toDataURL('image/png');
             poutLabels = poutLabels_backup;
             drawCanvas();
        } catch (e) {
            alert("無法擷取畫布影像：" + e.message);
            return;
        }

        const resultsText = dom.resultText.textContent;
        const calcLogText = dom.calcLogText.textContent;
        
        const htmlTemplate = `
<!DOCTYPE html>
<html lang="zh-Hant">
<head>
    <meta charset="UTF-8">
    <title>RF 鏈路預算報告</title>
    <style>
        body { 
            font-family: 'Segoe UI', 'Microsoft JhengHei', sans-serif; 
            background-color: #2B2B2B; 
            color: #E0E0E0; 
            margin: 20px; 
            line-height: 1.6;
        }
        h1 { color: #87CEFA; border-bottom: 2px solid #87CEFA; padding-bottom: 5px;}
        h2 { color: #A8E6CF; border-bottom: 1px solid #555; padding-bottom: 3px;}
        div { background-color: #333; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        img { max-width: 100%; border: 1px solid #777; }
        pre { 
            background-color: #222; 
            color: #F0F0F0; 
            padding: 10px; 
            border-radius: 3px; 
            overflow-x: auto; 
            font-family: 'Courier New', monospace; 
            font-size: 13px;
            white-space: pre; 
        }
    </style>
</head>
<body>
    <h1>RF 鏈路預算報告</h1>
    <p>匯出時間: ${new Date().toLocaleString()}</p>

    <div>
        <h2>1. 方塊圖 (Block Diagram)</h2>
        <img src="${imgDataUrl}" alt="RF 鏈路方塊圖">
    </div>

    <div>
        <h2>2. 計算報表 (Results Report)</h2>
        <pre>${resultsText.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
    </div>
    
    <div>
        <h2>3. 計算損益 (Calculation Log)</h2>
        <pre>${calcLogText.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
    </div>

</body>
</html>
        `;

        try {
            const blob = new Blob([htmlTemplate], { type: 'text/html' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            
            const mode = lastCalcMode || "TX";
            const freq = lastCalcFreq || "N_A";
            a.download = `RF_Report_${mode}_${freq}GHz.html`;
            
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
        } catch (e) {
            alert("匯出失敗：" + e.message);
        }
    }
    document.addEventListener('DOMContentLoaded', init);

})();
