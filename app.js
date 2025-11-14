/*
 * RF 鏈路預算 (Web App v9.0 - 複製功能) - 核心 JavaScript
 * v9.0 (使用者需求) 更新:
 * 1. (功能) [Req.2] 新增右鍵選單「複製元件」功能。
 * * v8.9 (使用者需求) 更新:
 * 1. (功能) [Req.1] 恢復被動元件 NF 計算邏輯。
 * - 根據使用者提供的 4.01 dB 計算，將被動元件 NF 恢復為 F=L (nf_db = loss_db)。
 * - 這是對 v8.7 (NF=0) 邏輯的修正。
 *
 * v8.8 (使用者需求) 更新:
 * 1. (介面) 將合併元件視窗中的「主動/系統 G」拆分為「主動 G」和「系統 G」。
 * 2. (介面) 同步更新畫布方塊上的分離增益顯示 (Act/Sys/Pas)。
 *
 * v8.7 (使用者需求) 更新:
 * 1. (功能) 移除主動元件 "RX" 模式下的 P1dB 規格。
 * 2. (介面) 編輯視窗 (Modal) 的 "RX" 分頁移除 P1dB 輸入框。
 * 3. (介面) 畫布方塊 (Canvas) 在 "RX" 模式下不再顯示 OP1dB。
 */

// --- (新) 自訂錯誤類別 ---
class CompressionError extends Error {
    constructor(message, component) {
        super(message);
        this.name = "CompressionError";
        this.component = component;
    }
}

// --- 第 0 部分：輔助工具 (單位轉換) ---
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
 * v6.1: 格式化數字，移除不必要的小數點
 * @param {number} num - 要格式化的數字
 * @param {number} digits - 保留的小數位數 (用於四捨五入)
 * @returns {string} - 格式化後的字串
 */
function formatNum(num, digits = 1) {
    const roundedNum = parseFloat(num.toFixed(digits));
    return String(roundedNum);
}

// --- 模듈 1A：RF 元件類別 ---
class RFComponent {
    constructor(name, isPassive = false, isSystem = false, specsByFreqDict = null) {
        this.name = name;
        this.isPassive = isPassive;
        this.isSystem = isSystem;
        this.specsByFreq = {};
        this.id = `comp_${Date.now()}_${Math.random()}`;

        // 圖形介面 (Canvas) 相關屬性
        this.x = 50;
        this.y = 50;
        this.width = 110;
        this.height = 70; // v6.0: 這是基礎高度，將會動態變化
        this.isHighlighted = false;
        this.isSelected = false; // v8.1 合併功能: 新增選取狀態
        
        // v8.5: 合併功能增強 (Req.1)
        this.isMerged = false;
        this.childrenData = []; // v8.5: 取代 childrenNames

        if (specsByFreqDict) {
            // v4.0 修正: 從 JSON 載入時，必須重新計算規格
            for (const [freq, modes_dict] of Object.entries(specsByFreqDict)) {
                this.specsByFreq[freq] = {};
                
                const raw_tx = modes_dict.TX || {};
                const raw_rx = modes_dict.RX || {};
                
                // v8.6: 傳遞所有規格 (包括分離增益)
                const final_tx_specs = Object.keys(raw_tx).length > 0 ? raw_tx : raw_rx;
                const final_rx_specs = Object.keys(raw_rx).length > 0 ? raw_rx : final_tx_specs;

                this.specsByFreq[freq]["TX"] = this.calculateSpecs(freq, "TX", final_tx_specs);
                this.specsByFreq[freq]["RX"] = this.calculateSpecs(freq, "RX", final_rx_specs);
            }
        } else {
            // 新增元件時的預設值
            let defaultSpecs = {};
            if (isPassive) defaultSpecs = { 'loss_db': 0.0 };
            // v7.2: isSystem 元件現在與 Active 元件相同
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
            // --- *** (v8.9) 變更 (Revert v8.7 Req.1) *** ---
            // 根據使用者的 4.01 dB 計算，恢復 F=L 邏輯
            nf_db = loss_db; 
            // nf_db = 0.0; // v8.7 的邏輯 (F=1)
            // --- *** (v8.9) 變更結束 *** ---
            op1db_dbm = 99.0;
            storage['loss_db'] = loss_db;
        } else { 
            // v7.2: isSystem 和 Active 元件都使用此邏輯
            gain_db = parseFloat(specsDict.gain_db || 0.0);
            nf_db = parseFloat(specsDict.nf_db || 0.0);
            
            // --- *** (v8.7) 變更 (Req.2) *** ---
            // v8.7: (Req.2) RX 模式下 P1dB 永遠為 99
            if (mode === "RX") {
                op1db_dbm = 99.0;
            } else {
                op1db_dbm = parseFloat(specsDict.op1db_dbm || 99.0);
            }
            // --- *** (v8.7) 變更結束 *** ---

            const oip3_dbm = parseFloat(specsDict.oip3_dbm || 99.0);
            storage['gain_db'] = gain_db;
            storage['nf_db'] = nf_db;
            storage['op1db_dbm'] = op1db_dbm;
            storage['oip3_dbm'] = oip3_dbm;
            storage['oip3_mw'] = dbm_to_mw(oip3_dbm);
            
            // v8.6: 儲存來自 newSpecsByFreq 的分離增益 (如果存在)
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

        // v7.2: 修正 Passive/System 元件的 TX/RX 鏡像
        if (this.isPassive) {
            // Passive 元件 TX/RX 永遠鏡像
            this.specsByFreq[freqKey]["TX"] = calculatedSpec;
            this.specsByFreq[freqKey]["RX"] = calculatedSpec;
        }
    }

    // v7.3 修正
    getSpecsForFreq(freqStr, mode) {
        const freqKey = String(freqStr);
        if (!(freqKey in this.specsByFreq)) return null;
        return this.specsByFreq[freqKey][mode] || null;
    }

    getRawSpecsForFreq(freqStr, mode) {
        // v7.2: isSystem 現在依賴於模式
        const specsMode = (this.isPassive) ? "TX" : mode;
        const specs = this.getSpecsForFreq(freqStr, specsMode);
        if (!specs) return {};

        if (this.isPassive) return { 'loss_db': specs.loss_db || 0.0 };
        else { 
            // v8.6: 傳回分離的增益 (如果是合併元件)
            const raw = {
                'gain_db': specs.gain_db || 0.0,
                'nf_db': specs.nf_db || 0.0,
                // v8.7: (Req.2) RX 模式不回傳 P1dB
                // 'op1db_dbm': specs.op1db_dbm || 99.0 
            };
            // v8.7: (Req.2) 只在 TX 模式回傳 P1dB
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

    // v8.8
    getDisplaySpecsLines(freq, mode) {
        if (!freq || !mode) return [];
        const specs = this.getSpecsForFreq(freq, mode);
        if (!specs) return [`(${freq} GHz / ${mode} 未定義)`];

        if (this.isPassive) {
            // v8.9: 恢復顯示 NF (NF=Loss)
            return [
                `L: ${formatNum(specs.loss_db, 1)} dB`,
                `NF: ${formatNum(specs.nf_db, 1)} dB`
            ];
        } else if (this.isSystem) {
             // v7.2
            return [
                `G: ${formatNum(specs.gain_db, 1)} dB`,
                `NF: ${formatNum(specs.nf_db, 1)} dB`
            ];
        } else {
            // v8.6: 如果是合併元件，顯示分離的增益
            if (this.isMerged) {
                // --- *** (v8.8) 變更 (Req.1) *** ---
                const active_gain_db = (specs.active_gain_db || 0);
                const system_gain_db = (specs.system_gain_db || 0);
                let lines = [ 
                    `G_total: ${formatNum(specs.gain_db, 1)} dB`,
                    `(Act: ${formatNum(active_gain_db, 1)} / Sys: ${formatNum(system_gain_db, 1)})`,
                    `(Pas: ${formatNum(specs.passive_gain_db, 1)})`,
                    `NF: ${formatNum(specs.nf_db, 1)} dB`
                ];
                // --- *** (v8.8) 變更結束 *** ---

                // --- *** (v8.7) 變更 (Req.2) *** ---
                if (mode === "TX") {
                    lines.push(`OP1dB: ${formatNum(specs.op1db_dbm, 1)} dBm`);
                }
                // --- *** (v8.7) 變更結束 *** ---
                return lines;
            }
            // --- *** (v8.7) 變更 (Req.2) *** ---
            let lines = [
                `G: ${formatNum(specs.gain_db, 1)} dB`,
                `NF: ${formatNum(specs.nf_db, 1)} dB`
            ];
            if (mode === "TX") {
                lines.push(`OP1dB: ${formatNum(specs.op1db_dbm, 1)} dBm`);
            }
            return lines;
            // --- *** (v8.7) 變更結束 *** ---
        }
    }

    toDict() {
        const specsToSave = {};
        for (const [freq, modes] of Object.entries(this.specsByFreq)) {
            specsToSave[freq] = {
                // v8.6: getRawSpecsForFreq 現在會包含合併元件的分離增益
                "TX": this.getRawSpecsForFreq(freq, "TX"),
                "RX": this.getRawSpecsForFreq(freq, "RX")
            };
        }
        return {
            'name': this.name,
            'isPassive': this.isPassive,
            'isSystem': this.isSystem,
            'specs_by_freq': specsToSave,
            'isMerged': this.isMerged, // v8.3
            'childrenData': this.childrenData // v8.5: 取代 childrenNames
        };
    }
    
    static fromDict(data) {
        const name = data.name || 'LoadedComp';
        const isPassive = data.isPassive || false;
        const isSystem = data.isSystem || false;
        const specsDict = data.specs_by_freq || {};
        
        // v8.6: 傳遞 specsDict，constructor 會呼叫 calculateSpecs
        // calculateSpecs 會處理分離的增益 (如果存在)
        const comp = new RFComponent(name, isPassive, isSystem, specsDict);
        
        // v8.5: 取代 childrenNames
        comp.isMerged = data.isMerged || false;
        comp.childrenData = data.childrenData || [];
        
        return comp;
    }
}

// --- 模듈 1B：核心計算引擎 ---
class RFLInkBudget {
    constructor() {
        this.chain = [];
        this.systemParams = {};
        this.results = {};
        this.cascadeTable = [];
        this.T0 = 290.0;
        this.calcLog = []; // v7.4
    }

    // v5.0
    setSystemParams(pInDbm) {
        this.systemParams = { 'p_in_dbm': pInDbm };
    }

    clear() {
        this.chain = [];
        this.results = {};
        this.cascadeTable = [];
        this.calcLog = []; // v7.4
    }

    // v7.4
    getCalcLog() {
        return this.calcLog.join('\n');
    }

    setChain(sortedChain) { this.chain = sortedChain; }

// v9.10: (使用者需求) 即使 P1dB 壓縮，也要在報表中顯示該級的 Pout
    // v9.8: (使用者需求) 1. 將 G/T 計算過程移至此處並寫入 Log
    calculate(calcFreqStr, mode = "TX") {
        if (!this.chain || this.chain.length === 0) throw new Error("鏈路中沒有元件。");
        calcFreqStr = String(calcFreqStr);

        this.calcLog = [];
        this.calcLog.push(`*** ${mode} 模式 @ ${calcFreqStr} GHz ***`);
        this.calcLog.push(`============================`);

        let cumulative_gain_linear = 1.0;
        let cumulative_pout_dbm = this.systemParams.p_in_dbm || -100.0;
        
        // --- *** (v9.1) NF 計算邏輯修改 *** ---
        let cumulative_nf_linear = 0.0;
        let cumulative_gain_linear_for_nf = 1.0;
        let nf_cascade_started = false; 
        // --- *** (v9.1) 修改結束 *** ---

        // v7.5: (Req.2) 新增增益分離累加器
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
            const stage_pin_dbm = cumulative_pout_dbm;
            cumulative_pout_dbm = stage_pin_dbm + stage_gain_db;
            
            // v7.5: (Req.2) 累加分離的增益
            if (comp.isPassive) {
                total_passive_gain_db += stage_gain_db;
            } else if (comp.isSystem) {
                total_system_gain_db += stage_gain_db;
            } else {
                total_active_gain_db += stage_gain_db;
            }

            // --- Gain Log (v7.4) ---
            this.calcLog.push(`  G_cum: ${formatNum(stage_pin_dbm, 2)} dBm (Pin) + ${formatNum(stage_gain_db, 2)} dB (G) = ${formatNum(cumulative_pout_dbm, 2)} dBm (Pout)`);

            // --- *** (v9.10) P1dB 檢查邏輯被移到 cascadeTable.push 之後 *** ---
            // (此處的 P1dB 檢查已刪除)

            const comp_gain_linear = specs['gain_linear'];
            // v8.9: (Req.1) specs['nf_linear'] 對被動元件現在會是 L (F=L)
            const comp_nf_linear = specs['nf_linear'] ?? 1.0; 

            // --- *** (v9.1) NF 計算邏輯修改 *** ---
            let is_first_nf_stage = false;

            if (mode === "RX") {
                if (comp.isSystem) {
                    // RX 模式下的天線 (isSystem)，跳過 NF 計算
                    this.calcLog.push(`  NF_cum: (RX 模式，跳過天線元件 NF 計算)`);
                } else if (!nf_cascade_started) {
                    // RX 模式下，這是第一個 "非天線" 元件
                    nf_cascade_started = true;
                    is_first_nf_stage = true;
                }
            } else { 
                if (i === 0) {
                    is_first_nf_stage = true;
                }
                nf_cascade_started = true;
            }
            // --- *** (v9.1) 修改結束 *** ---

            // --- NF Log (v7.4) ---
            if (nf_cascade_started) {
                if (is_first_nf_stage) {
                    cumulative_nf_linear = comp_nf_linear;
                    cumulative_gain_linear_for_nf = comp_gain_linear; 
                    this.calcLog.push(`  NF_cum [F]: (NF 串級開始) F_total = F_1`);
                    this.calcLog.push(`    F_total = ${formatNum(comp_nf_linear, 4)}`);
                } else {
                    const F_prev = cumulative_nf_linear;
                    const G_prev_lin = cumulative_gain_linear_for_nf; 
                    const F_stage = comp_nf_linear;
                    const F_contrib = (F_stage - 1) / G_prev_lin;
                    cumulative_nf_linear += F_contrib;
                    cumulative_gain_linear_for_nf *= comp_gain_linear; 
                    this.calcLog.push(`  NF_cum [F]: F_total = F_prev + (F_stage - 1) / G_prev_lin`);
                    this.calcLog.push(`    F_total = ${formatNum(F_prev, 4)} + (${formatNum(F_stage, 4)} - 1) / ${formatNum(G_prev_lin, 2)}`);
                    this.calcLog.push(`    F_total = ${formatNum(F_prev, 4)} + ${formatNum(F_contrib, 4)} = ${formatNum(cumulative_nf_linear, 4)}`);
                }
                this.calcLog.push(`  NF_cum [dB]: 10*log10(${formatNum(cumulative_nf_linear, 4)}) = ${formatNum(linear_to_db(cumulative_nf_linear), 2)} dB`);
            }
            // --- *** (v9.1) 修改結束 *** ---
            
            cumulative_gain_linear *= comp_gain_linear;
            this.calcLog.push(``); // Blank line

            // --- *** (v9.10) 修改點 *** ---
            // 1. 將 'cascadeTable.push' 移到 P1dB 檢查 *之前*
            //    以確保 "4. 計算報表" 總是能顯示所有已計算的級聯。
            // --- *** (v9.10) *** ---
            this.cascadeTable.push({
                "Stage": `(${i + 1}) ${comp.name}`,
                "Cum. Gain (dB)": linear_to_db(cumulative_gain_linear),
                "Cum. NF (dB)": (nf_cascade_started) ? linear_to_db(cumulative_nf_linear) : 0.0,
                "Cum. Pout (dBm)": cumulative_pout_dbm
            });

            // --- *** (v9.10) 修改點 *** ---
            // 2. 現在 'cascadeTable' 已經被填入，可以安全地 'throw'
            // --- *** (v9.10) *** ---
            if (mode === "TX" && cumulative_pout_dbm > stage_op1db_dbm) {
                if (!comp.isSystem) { 
                    const errorMsg = `元件 '${comp.name}' 發生 P1dB 壓縮！\n\nPout: ${cumulative_pout_dbm.toFixed(2)} dBm\nP1dB: ${stage_op1db_dbm.toFixed(2)} dBm`;
                    this.calcLog.push(`  *** 錯誤: ${errorMsg.replace("\n\n", " ")} ***`);
                    throw new CompressionError(errorMsg, comp);
                }
            }
            
        } // --- 迴圈結束 ---

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

        // --- *** (v9.8) G/T 計算邏輯 *** ---
        let g_ant_db = 0.0;
        let t_ant = 0.0;
        let t_rx = 0.0;
        let t_sys = 0.0;
        let g_over_t = -Infinity;
        const nf_total_db = (nf_cascade_started) ? linear_to_db(cumulative_nf_linear) : 0.0;

        if (mode === "RX") {
            this.calcLog.push(`--- (G/T) G/T 系統計算 ---`);

            // 1. 自動計算 G_ant
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
            this.calcLog.push(`  G_ant: 自動累加鏈路開頭 'isSystem' 元件 = ${formatNum(g_ant_db, 2)} dB`);
            
            // 2. T_ant
            t_ant = this.T0;
            this.calcLog.push(`  T_ant: (T0) = ${formatNum(t_ant, 2)} K`);

            // 3. T_rx
            const f_total = db_to_linear(nf_total_db);
            t_rx = this.T0 * (f_total - 1);
            this.calcLog.push(`  T_rx: T0 * (F_total - 1)`);
            this.calcLog.push(`    NF_total (接收機) = ${formatNum(nf_total_db, 2)} dB (F_total = ${formatNum(f_total, 4)})`);
            this.calcLog.push(`    T_rx = 290 * (${formatNum(f_total, 4)} - 1) = ${formatNum(t_rx, 2)} K`);

            // 4. T_sys
            t_sys = t_ant + t_rx;
            const t_sys_dbk = (t_sys > 0) ? (10 * Math.log10(t_sys)) : -Infinity;
            this.calcLog.push(`  T_sys: T_ant + T_rx = ${formatNum(t_ant, 2)} + ${formatNum(t_rx, 2)} = ${formatNum(t_sys, 2)} K`);
            this.calcLog.push(`    T_sys (dBK) = 10*log10(${formatNum(t_sys, 2)}) = ${formatNum(t_sys_dbk, 2)} dBK`);

            // 5. G/T
            g_over_t = g_ant_db - t_sys_dbk;
            this.calcLog.push(`  G/T: G_ant - T_sys(dBK) = ${formatNum(g_ant_db, 2)} - ${formatNum(t_sys_dbk, 2)} = ${formatNum(g_over_t, 2)} dB/K`);
            this.calcLog.push(``); // 結尾空行
        }
        // --- *** (v9.8) 結束 *** ---

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
	// v9.8: (使用者需求) 簡化 G/T 報告，改為從 results.chain 讀取預先算好的值
    	getReport(calcFreqStr, mode = "TX") {
        const p_in_dbm = this.systemParams.p_in_dbm || 0;
        const chain_res = this.results.chain;
        if (!chain_res) return "尚未計算。";

        const total_gain_db = chain_res['total_gain_db'];
        // v7.5: (Req.2) 讀取分離的增益
        const total_active_gain_db = chain_res['total_active_gain_db'];
        const total_passive_gain_db = chain_res['total_passive_gain_db'];
        const total_system_gain_db = chain_res['total_system_gain_db'];
        // 主動+系統 (G > 0)
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
                // v6.1: 使用 formatNum
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
                // v6.1: 使用 formatNum
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
            // v7.5: (Req.2) 新增
            report_str += `  (主動/系統 增益):       ${formatNum(total_positive_gain_db, 2).padStart(7)} dB\n`;
            report_str += `  (被動元件 損耗):       ${formatNum(total_passive_gain_db, 2).padStart(7)} dB\n`;
            report_str += "  --------------------------------------------------\n";
            report_str += `  **最終輸出功率 (P_out/EIRP):** **${formatNum(total_output_power_dbm, 2).padStart(7)} dBm**\n`;
        
        } else { // RX
            // --- *** (v9.8) 關鍵修正 *** ---
            // 1. 從 chain_res 讀取 G/T 計算結果
            const g_ant_db = chain_res['g_ant_db'];
            const t_ant = chain_res['t_ant'];
            const nf_total_db = chain_res['total_nf_db'];
            const t_rx = chain_res['t_rx'];
            const t_sys = chain_res['t_sys'];
            const g_over_t = chain_res['g_over_t'];
            
            // 2. 輔助顯示
            const t_sys_dbk = (t_sys > 0) ? (10 * Math.log10(t_sys)) : -Infinity;
            // --- *** (v9.8) 修正結束 ---

            report_str += `--- 🛰️ 2. 系統總結 (RX G/T @ ${calcFreqStr} GHz) ---\n` + "=".repeat(50) + "\n";
            report_str += `  天線增益 (G_ant) [自動]: ${formatNum(g_ant_db, 2).padStart(7)} dB\n`;
            report_str += `  天線雜訊溫度 (T_ant):   ${formatNum(t_ant, 2).padStart(7)} K\n`;
            report_str += `  鏈路總雜訊 (NF_total):    ${formatNum(nf_total_db, 2).padStart(7)} dB\n`;
            // v7.5: (Req.2) 新增
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
	// --- 模듈 2：GUI 控制介面 (Web App 主邏輯) ---
	(function() {
    // --- 應用程式狀態 ---
    const calculator = new RFLInkBudget();
    let blocks = []; 
    // v7.0
    let connections_TX = new Map(); 
    let connections_RX = new Map(); 
    let currentConnections = connections_TX; 
    
    // v8.1 合併功能: 相關狀態
    let isMergeSelectMode = false; // 標記是否處於合併選取模式
    let mergeSelection = [];       // 儲存被選取的元件 ID

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

    /**
     * 應用程式初始化 (v7.4)
     */
    function init() {
        // --- 抓取 DOM 元素 ---
        dom.canvas = document.getElementById('rf-canvas');
        dom.ctx = dom.canvas.getContext('2d');
        canvas = dom.canvas;
        ctx = dom.ctx;
        
        dom.resultText = document.getElementById('result-text');
        dom.calcLogText = document.getElementById('calc-log-text'); // v7.4
        
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
	// --- *** (v9.14) 新增：建立 '匯出報告' 按鈕 (已修正位置) *** ---
        try {
            dom.exportButton = document.createElement('button');
            dom.exportButton.id = 'export-button';
            dom.exportButton.className = 'tool-button'; // 使用與 'Calculate' 相同的樣式
            dom.exportButton.textContent = '匯出報告 (Export)';
            dom.exportButton.title = '將目前的方塊圖和計算結果匯出為 HTML 檔案';
            
            // 插入到 'Calculate' 按鈕後面
            dom.calcButton.parentNode.insertBefore(dom.exportButton, dom.calcButton.nextSibling);
            
            // 補上一個小間距
            const spacer = document.createTextNode(' ');
            dom.calcButton.parentNode.insertBefore(spacer, dom.exportButton);
        } catch (e) {
            console.error("無法建立 '匯出報告' 按鈕:", e);
        }
        // --- *** (v9.14) 結束 *** ---


        // --- 綁定事件 ---
        dom.mergeButton = document.getElementById('merge-components'); // v8.1 新增
        
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
	// --- *** (v9.13) 新增：動態建立 '拆分元件' 選單按鈕 *** ---
        try {
            const unmergeLi = document.createElement('li');
            unmergeLi.id = 'menu-unmerge-comp';
            unmergeLi.textContent = '拆分元件 (Unmerge)';
            unmergeLi.style.display = 'none'; // 預設隱藏
            
            // 插入到 '複製' (menu-duplicate-comp) 之後
            const duplicateCompMenu = document.getElementById('menu-duplicate-comp');
            if (duplicateCompMenu) {
                duplicateCompMenu.parentNode.insertBefore(unmergeLi, duplicateCompMenu.nextSibling);
            } else {
                // 備用方案：加到選單末尾 (在 '取消' 之前)
                const cancelMenu = document.getElementById('menu-cancel-block');
                if (cancelMenu) {
                    cancelMenu.parentNode.insertBefore(unmergeLi, cancelMenu);
                } else {
                    dom.blockContextMenu.appendChild(unmergeLi);
                }
            }
        } catch (e) {
            console.error("無法建立 '拆分元件' 選單:", e);
        }
        // --- (v9.17) 修正：注入 CSS (增大 log 視窗 + 修正合併視窗溢出) ---
            try {
                const styleSheet = document.createElement("style");
                styleSheet.innerHTML = `
                    /* 修正 1: 增大下方 log 視窗 */
                    #result-text, #calc-log-text {
                        height: 300px !important; 
                        overflow-y: auto !important;
                        font-size: 11px;
                    }
                    
                    /* 修正 2 (v9.17): 修正合併視窗 (modal) 內容溢出 */
                    /* .spec-tab-content (e.g., #spec-tab-tx) 是長列表的容器 */
                    div.spec-tab-content {
                        max-height: 40vh; /* 最大高度為視窗高度的 40% */
                        overflow-y: auto; /* 內容超出時顯示滾動條 */
                        padding: 10px;    /* 增加一點內距 */
                        background: #222; /* 增加背景色 */
                        border: 1px solid #555; /* 增加邊框以示區隔 */
                        border-radius: 3px;
                        margin-top: 5px; /* 與 TX/RX 標籤的間距 */
                    }
                `;
                document.head.appendChild(styleSheet);
            } catch (e) {
                console.warn("無法注入 CSS (v9.17): ", e);
            }
            // --- (v9.17) 結束 ---
        // --- 綁定事件 ---
        window.addEventListener('resize', resizeCanvas); 
        dom.tabButtons.forEach(btn => btn.addEventListener('click', onTabChange));
        bindToolboxEvents(); 
        dom.calcButton.addEventListener('click', calculateLink);
        dom.clearButton.addEventListener('click', clearAll); 
        dom.clearLinesButton.addEventListener('click', clearAllLines); 
        dom.exportButton.addEventListener('click', exportFullReport); // <-- (v9.14) 新增

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
        document.getElementById('menu-duplicate-comp').addEventListener('click', duplicateComponent); // <-- (v9.0)
        document.getElementById('menu-unmerge-comp').addEventListener('click', unmergeComponent); // <-- (v9.13) 新增
        document.getElementById('menu-cancel-block').addEventListener('click', () => dom.blockContextMenu.style.display = 'none');

        // 檔案載入
        dom.loadCompBtn.addEventListener('click', () => dom.fileLoaderInput.click());
        dom.fileLoaderInput.addEventListener('change', loadComponentFromFile);
        dom.mergeButton.addEventListener('click', onMergeComponents); // v8.1 新增 (v8.2 實作)

        // --- 初始繪製 ---
        setTimeout(resizeCanvas, 0);
    }
    
    /**
     * 綁定工具箱按鈕事件 (v7.2)
     */
    function bindToolboxEvents() {
        document.getElementById('add-lna').addEventListener('click', () => addBlock("LNA", false, false, {'1.0': {'TX': {'gain_db': 15, 'nf_db': 1.5, 'op1db_dbm': 20}, 'RX': {'gain_db': 15, 'nf_db': 1.5, 'op1db_dbm': 20}}}));
        document.getElementById('add-pa').addEventListener('click', () => addBlock("PA", false, false, {'1.0': {'TX': {'gain_db': 20, 'nf_db': 5, 'op1db_dbm': 33}, 'RX': {'gain_db': 20, 'nf_db': 5, 'op1db_dbm': 33}}}));
        document.getElementById('add-mixer').addEventListener('click', () => addBlock("Mixer", false, false, {'1.0': {'TX': {'gain_db':-7, 'nf_db': 7, 'op1db_dbm': 15}, 'RX': {'gain_db':-7, 'nf_db': 7, 'op1db_dbm': 15}}}));
        document.getElementById('add-filter').addEventListener('click', () => addBlock("Filter", true, false, {'1.0': {'TX': {'loss_db': 1.5}, 'RX': {'loss_db': 1.5}}}));
        document.getElementById('add-atten').addEventListener('click', () => addBlock("Atten", true, false, {'1.0': {'TX': {'loss_db': 6.0}, 'RX': {'loss_db': 6.0}}}));
        document.getElementById('add-div2').addEventListener('click', () => addBlock("1-2 Div", true, false, {'1.0': {'TX': {'loss_db': 3.5}, 'RX': {'loss_db': 3.5}}}));
        document.getElementById('add-div4').addEventListener('click', () => addBlock("1-4 Div", true, false, {'1.0': {'TX': {'loss_db': 7.0}, 'RX': {'loss_db': 7.0}}}));
        document.getElementById('add-trace').addEventListener('click', () => addBlock("Trace", true, false, {'1.0': {'TX': {'loss_db': 0.5}, 'RX': {'loss_db': 0.5}}}));
        
        // v7.2: 更新 Antenna/Array 的預設值，使其包含 nf_db: 0.0
        document.getElementById('add-antenna').addEventListener('click', () => addBlock("Antenna", false, true, {'1.0': {'TX': {'gain_db': 12, 'nf_db': 0.0, 'op1db_dbm': 99}, 'RX': {'gain_db': 12, 'nf_db': 0.0, 'op1db_dbm': 99}}}));
        document.getElementById('add-array').addEventListener('click', () => addBlock("Array (N=16)", false, true, {'1.0': {'TX': {'gain_db': 12.04, 'nf_db': 0.0, 'op1db_dbm': 99}, 'RX': {'gain_db': 12.04, 'nf_db': 0.0, 'op1db_dbm': 99}}}));
    }

    /**
     * 綁定右鍵選單按鈕事件
     */
    function bindContextMenuEvents() {
        document.addEventListener('click', () => {
            dom.blockContextMenu.style.display = 'none';
            dom.lineContextMenu.style.display = 'none';
        });
        
        document.getElementById('menu-save-comp').addEventListener('click', saveComponent);
        document.getElementById('menu-delete-comp').addEventListener('click', deleteComponent);
        document.getElementById('menu-duplicate-comp').addEventListener('click', duplicateComponent); // <-- (v9.0)
        document.getElementById('menu-unmerge-comp').addEventListener('click', unmergeComponent); // <-- (v9.13) 新增
        document.getElementById('menu-cancel-block').addEventListener('click', () => dom.blockContextMenu.style.display = 'none');
        
        document.getElementById('menu-delete-line').addEventListener('click', deleteSelectedLine);
        document.getElementById('menu-cancel-line').addEventListener('click', () => dom.lineContextMenu.style.display = 'none');
    }

    /**
     * 重設 Canvas 尺寸 (v8.0 修正)
     */
    function resizeCanvas() {
        // v8.0 (BugFix): 呼叫 drawCanvas，它會自動處理尺寸檢查
        drawCanvas();
    }

    /**
     * (v2.0) 取得滑鼠在 Canvas 上的 "世界" 座標
     */
    function getMousePos(e) {
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        return {
            x: (screenX - canvasPan.x) / canvasZoom,
            y: (screenY - canvasPan.y) / canvasZoom
        };
    }
    
    /**
     * 偵測滑鼠是否點擊到方塊
     */
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
    
    /**
     * 偵測滑鼠是否點擊到線條 (v7.0)
     */
    function getLineAtPos(x, y, tolerance = 8) { // v6.2: (Req.3) 增加 tolerance
        const worldTolerance = tolerance / canvasZoom;
        
        // v7.0: 使用 currentConnections
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
    
    /**
     * v3.0: 計算兩個元件中心連線與 compA 邊框的交點
     */
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
    
    /**
     * 清除所有高亮
     */
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
    
    /**
     * (v8.1 合併功能) 清除所有元件的 'isSelected' 狀態
     */
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

    /**
     * 高亮特定方塊
     */
    function highlightBlock(comp, color) { 
        if (comp) {
            comp.isHighlighted = true;
            drawCanvas();
        }
    }

    // --- 主繪圖函式 (v8.8) ---
    function drawCanvas() {
        if (!ctx) return;
        
        // --- *** (v8.0) 關鍵修正 (Req.1) *** ---
        // 每次繪製前，都檢查畫布的 CSS 大小是否與點陣圖大小一致
        // 使用 clientWidth/Height 確保獲取整數像素
        const newWidth = canvas.clientWidth;
        const newHeight = canvas.clientHeight;
    
        if (canvas.width !== newWidth || canvas.height !== newHeight) {
            canvas.width = newWidth;
            canvas.height = newHeight;
            canvasWidth = canvas.width;
            canvasHeight = canvas.height;
        }
        // --- 修正結束 ---
        
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        
        ctx.translate(canvasPan.x, canvasPan.y);
        ctx.scale(canvasZoom, canvasZoom);

        // --- 1. 繪製連線 (v8.0) ---
        ctx.strokeStyle = "#F0F0F0"; // v8.0: 暗色模式線條
        ctx.lineWidth = 2;
        // v7.0: 使用 currentConnections
        for (const [fromId, toId] of currentConnections.entries()) {
            const fromComp = blocks.find(b => b.id === fromId);
            const toComp = blocks.find(b => b.id === toId);
            if (fromComp && toComp) {
                const [x1, y1] = getLineIntersectionPoint(fromComp, toComp);
                const [x2, y2] = getLineIntersectionPoint(toComp, fromComp);
                
                // v7.0: 移除箭頭反轉，永遠是 'end'
                drawArrow(x1, y1, x2, y2, 'end');
            }
        }
        
        // --- 2. 繪製拖曳中的暫時線條 ---
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

        // --- 3. 繪製方塊 (v8.8) ---
        const shadowOffset = 3 * (1 / canvasZoom);
        const lightBorder = "#FFFFFF33"; // v8.0: 暗色模式高光
        const darkBorder = "#00000088"; // v8.0: 暗色模式陰影
        const shadowColor = "#00000055"; // v8.0: 暗色模式陰影
        
        ctx.lineWidth = 1;

        for (const comp of blocks) {
            let mainColor;
            
            // v8.3 (Req.3): 合併元件顏色區分
            if (comp.isMerged) {
                mainColor = "#C8A2C8"; // 淡紫色 (Lilac)
            } else if (comp.isSystem) { 
                mainColor = "#FFEAA7"; // 黃色 (Antenna, Array)
            } else if (comp.isPassive) { 
                mainColor = "#A8E6CF"; // 綠色 (Filter, Div)
            } else { 
                mainColor = "#BDE0FE"; // 藍色 (LNA, PA)
            }

            // --- v6.0: 動態高度 & 寬度 (Req.2) ---
            // v8.7: 顯示的規格基於 lastCalcMode (getDisplaySpecsLines 已更新)
            const specLines = comp.getDisplaySpecsLines(lastCalcFreq, lastCalcMode); 
            
            // v8.5 (Req.1): 為子元件列表計算額外高度 (使用 childrenData)
            let childrenLinesCount = 0;
            let childrenNames = [];
            if (comp.isMerged && comp.childrenData.length > 0) {
                childrenNames = comp.childrenData.map(c => c.name); // v8.5
                childrenLinesCount = childrenNames.length;
            }
            
            // v8.8: 調整高度計算
            let specLinesHeight = 0;
            if (specLines.length > 0) {
                 specLinesHeight = 10 + (specLines.length * 15);
                 // v8.8: 針對合併元件的特殊高度
                 if (comp.isMerged) specLinesHeight += 15; // 增加一行的高度
            }
            
            // 每個子元件行 15px + 分隔線 10px
            const childrenHeight = (childrenLinesCount > 0) ? (10 + childrenLinesCount * 15) : 0; 
            comp.height = 60 + specLinesHeight + childrenHeight;
            
            ctx.font = "bold 13px Arial";
            const nameWidth = ctx.measureText(comp.getDisplayName()).width;
            ctx.font = "12px Arial";
            const freqListWidth = ctx.measureText(comp.getDisplaySpecs()).width;
            
            let maxSpecWidth = 0;
            // v8.6: 規格字體
            for(const line of specLines) {
                 ctx.font = line.startsWith("(") ? "italic 11px Arial" : "bold 12px Arial";
                maxSpecWidth = Math.max(maxSpecWidth, ctx.measureText(line).width);
            }

            // v8.5 (Req.1): 檢查子元件名稱寬度 (使用 childrenNames)
            if (childrenLinesCount > 0) {
                ctx.font = "italic bold 11px Arial";
                maxSpecWidth = Math.max(maxSpecWidth, ctx.measureText("--- (Original) ---").width);
                ctx.font = "italic 11px Arial";
                for (const childName of childrenNames) {
                    maxSpecWidth = Math.max(maxSpecWidth, ctx.measureText(childName).width);
                }
            }
            
            comp.width = Math.max(110, nameWidth + 40, freqListWidth + 40, maxSpecWidth + 40);
            
            // --- End Dynamic ---

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

            // e. 繪製文字 (v8.0: 顏色保持深色)
            ctx.fillStyle = "#111111"; // v8.0
            ctx.font = "bold 13px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            
            let y_pos = comp.y + 20;
            ctx.fillText(comp.getDisplayName(), comp.x + comp.width / 2, y_pos);
            
            y_pos += 18;
            ctx.fillStyle = "#222222"; // v8.0
            ctx.font = "12px Arial";
            ctx.fillText(comp.getDisplaySpecs(), comp.x + comp.width / 2, y_pos);

            // (Req.2) 繪製額外規格
            if (specLines.length > 0) {
                y_pos += 12; // 分隔線
                ctx.fillStyle = "#555"; // v8.0
                ctx.fillText("---", comp.x + comp.width / 2, y_pos);
                
                ctx.fillStyle = "#005A9E"; // 規格使用藍色
                
                for(const line of specLines) {
                    // v8.6: 根據是否為合併元件調整字體
                    if (comp.isMerged) {
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

            // v8.5 (Req.1): 繪製子元件列表 (使用 childrenNames)
            if (comp.isMerged && childrenNames.length > 0) {
                y_pos += 12; // 分隔線
                ctx.fillStyle = "#222222"; // 分隔線文字 (與元件背景色相容)
                ctx.font = "italic bold 11px Arial";
                ctx.fillText("--- (Original) ---", comp.x + comp.width / 2, y_pos);
                
                ctx.fillStyle = "#111111"; // 子元件名稱文字
                ctx.font = "italic 11px Arial";
                
                for(const childName of childrenNames) {
                    y_pos += 15;
                    ctx.fillText(childName, comp.x + comp.width / 2, y_pos);
                }
            }

            // --- *** (v8.1 合併功能) 繪製選取框 *** ---
            if(comp.isSelected) {
                ctx.strokeStyle = "#00FFFF"; // 青色 (Cyan)
                ctx.lineWidth = 3;
                ctx.setLineDash([8, 3]);
                ctx.strokeRect(comp.x - 2, comp.y - 2, comp.width + 4, comp.height + 4);
                ctx.setLineDash([]);
                ctx.lineWidth = 1;
            }
            
            // d. 高亮 (錯誤)
            if(comp.isHighlighted) {
                ctx.strokeStyle = "red";
                ctx.lineWidth = 3;
                ctx.strokeRect(comp.x - 1, comp.y - 1, comp.width + 2, comp.height + 2);
                ctx.lineWidth = 1;
            }
        }
        
        // --- 4. 繪製 Pout 標籤 ---
        if (currentCalcMode === "TX" && poutLabels.length > 0) {
            ctx.font = "bold 12px Arial";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            
            for (const label of poutLabels) {
                const textWidth = ctx.measureText(label.text).width;
                ctx.fillStyle = "#333333E6"; // v8.0: 暗色背景
                ctx.fillRect(label.x - textWidth / 2 - 2, label.y - 14, textWidth + 4, 14);
                
                ctx.fillStyle = "#87CEFA"; // v8.0: 亮藍色文字
                ctx.fillText(label.text, label.x, label.y);
            }
        }
        
        ctx.restore();
    }
    
    /**
     * 繪製帶箭頭的線
     */
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
    
    /**
     * 繪製 Pout 標籤 (v7.0)
     */
    function drawPoutLabels() {
        poutLabels = [];
        try {
            const sortedChain = calculator.chain;
            const cascadeTable = calculator.cascadeTable;
            
            for (let i = 0; i < sortedChain.length; i++) {
                const comp = sortedChain[i];
                // v7.0: 使用 currentConnections
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
                            // v6.1: 使用 formatNum
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
    
    function addBlock(name, isPassive, isSystem, defaultSpecs) {
        const comp = new RFComponent(name, isPassive, isSystem, defaultSpecs);
        const viewCenterX = (canvasWidth / 2 - canvasPan.x) / canvasZoom;
        const viewCenterY = (canvasHeight / 2 - canvasPan.y) / canvasZoom;
        
        comp.x = viewCenterX - comp.width / 2 + (Math.random() - 0.5) * 50;
        comp.y = viewCenterY - comp.height / 2 + (Math.random() - 0.5) * 50;
        
        blocks.push(comp);
        drawCanvas();
    }
    
    /**
     * v7.0 (Req.4) : 清除 *目前* 鏈路
     */
    function clearAllLines() {
        if (confirm(`您確定要清除 ${currentCalcMode} 模式下的所有連線嗎？ (元件將會保留)`)) {
            // v7.0: 只清除當前模式的連線
            currentConnections.clear(); 
            poutLabels = [];
            // v6.0: 清除計算狀態
            lastCalcFreq = null;
            // lastCalcMode 不清除
            dom.resultText.textContent = `(${currentCalcMode} 連線已清除，請重新計算)`;
            dom.calcLogText.textContent = `(${currentCalcMode} 連線已清除)`; // v7.4
            drawCanvas();
        }
    }

    // v7.0: 更新
    function clearAll() {
        if (confirm("您確定要清除所有方塊和連線嗎？")) {
            calculator.clear();
            blocks = [];
            connections_TX.clear(); // v7.0
            connections_RX.clear(); // v7.0
            lineData = { startComp: null, tempLineId: null, mouseX: 0, mouseY: 0 };
            poutLabels = [];
            
            canvasZoom = 1.0;
            canvasPan = { x: 0, y: 0 };
            
            // v6.0: 清除計算狀態
            lastCalcFreq = null;
            lastCalcMode = null;
            
            dom.resultText.textContent = "(尚未計算)";
            dom.calcLogText.textContent = "(尚未計算)"; // v7.4
            drawCanvas();
        }
    }
    
    // v7.0: 核心架構變更
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
        
        // --- *** (v7.0) 關鍵修正 (Req.1) *** ---
        // 切換當前正在編輯/檢視的連線 Map
        if (currentCalcMode === "TX") {
            currentConnections = connections_TX;
        } else {
            currentConnections = connections_RX;
        }
        
        // v7.0: 更新方塊上顯示的模式 (如果已計算過)
        if (lastCalcFreq) {
            lastCalcMode = currentCalcMode;
        }
        
        if (currentCalcMode !== "TX") {
            poutLabels = [];
        }
        
        // 重繪以顯示新模式的連線
        drawCanvas();
    }
    
    // --- Canvas 事件處理 ---
    
    // v7.0: 修正拉線邏輯
    function onMouseDown(e) {
        dom.blockContextMenu.style.display = 'none';
        dom.lineContextMenu.style.display = 'none';
        
        const { x, y } = getMousePos(e); 
        
        if (e.button === 1) { // 中鍵
            panData.isPanning = true;
            panData.startX = e.clientX;
            panData.startY = e.clientY;
            canvas.classList.add('panning');
            e.preventDefault();
            return;
        }

        if (e.button === 0) { // 左鍵
            const clickedBlock = getBlockAtPos(x, y);

            // --- *** (v8.1 合併功能) 選取模式邏輯 *** ---
            if (isMergeSelectMode) {
                if (clickedBlock) {
                    const compId = clickedBlock.id;
                    const index = mergeSelection.indexOf(compId);
                    
                    if (index > -1) {
                        // 已選取 -> 取消選取
                        mergeSelection.splice(index, 1);
                        clickedBlock.isSelected = false;
                    } else {
                        // 未選取 -> 加入選取
                        mergeSelection.push(compId);
                        clickedBlock.isSelected = true;
                    }
                    drawCanvas();
                }
                return; // 在合併模式下，禁止拖曳和拉線
            }
            // --- *** (v8.1) 修改結束 *** ---

            // (v8.1 修正) 點擊空白處，清除選取
            if (!clickedBlock && !e.ctrlKey && !e.metaKey) {
                 clearAllSelections();
            }

            if (e.ctrlKey || e.metaKey) { 
                
                // --- *** (v7.0) 關鍵修正 (Req.1) *** ---
                // 允許在 TX/RX 模式下繪製
                if (clickedBlock) {
                    // v7.0: 檢查 currentConnections
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
                    
                    // --- *** (v8.1 合併功能) 點擊時清除其他選取 *** ---
                    clearAllSelections(); // clearAllSelections 會在需要時呼叫 drawCanvas
                    clickedBlock.isSelected = true; 
                    drawCanvas(); // 立即重繪以顯示新選取
                    // --- *** (v8.1) 修改結束 *** ---

                    dragData.item = clickedBlock;
                    dragData.offsetX = x - clickedBlock.x;
                    dragData.offsetY = y - clickedBlock.y;
                    
                    blocks = blocks.filter(b => b.id !== clickedBlock.id);
                    blocks.push(clickedBlock);
                    
                    // (v8.1 移除) drawCanvas() - 已在前面呼叫
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
    
    // v7.0: 修正拉線邏輯
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
                // v7.0: 檢查 currentConnections
                for (const toId of currentConnections.values()) {
                    if (toId === endComp.id) {
                        hasInput = true;
                        break;
                    }
                }
                
                if (hasInput) {
                    alert(`元件 '${endComp.name}' 已經有輸入了。`);
                } else {
                    // v7.0: 寫入 currentConnections
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

    // v6.2: 修正無法雙擊
    function onDoubleClick(e) {
        dragData.item = null;
        
        // v8.1 合併功能: 雙擊在合併模式下無作用
        if (isMergeSelectMode) return; 

        const { x, y } = getMousePos(e);
        const clickedBlock = getBlockAtPos(x, y);
        if (clickedBlock) {
            openEditModal(clickedBlock);
        }
    }
    
    // v7.0
    function onContextMenu(e) {
        e.preventDefault();
        dragData.item = null;

        // v8.1 合併功能: 右鍵在合併模式下無作用
        if (isMergeSelectMode) return;

        const { x, y } = getMousePos(e); 
        
        dom.blockContextMenu.style.display = 'none';
        dom.lineContextMenu.style.display = 'none';
        
        const clickedBlock = getBlockAtPos(x, y);
        // v7.0: 使用 currentConnections
        const clickedLine = getLineAtPos(x, y);
        
        if (clickedBlock) {
            rightClickedComp = clickedBlock;
            showContextMenu(dom.blockContextMenu, e.clientX, e.clientY);
	    const unmergeOption = document.getElementById('menu-unmerge-comp');
            if (unmergeOption) {
                if (clickedBlock.isMerged) {
                    // 在 CSS 中, li 的 display 預設是 list-item
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
    
    // --- (v2.0) 滾輪縮放事件 ---
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
        
        // v4.0 修正
        const defaultName = `${comp.name.replace(/ /g, "_").replace(/[()=]/g, "")}.json`;
        
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = prompt("請輸入檔名：", defaultName) || defaultName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        rightClickedComp = null;
    }
    
    // v7.0: 修正
    function deleteComponent() {
        if (!rightClickedComp) return;
        
        const comp = rightClickedComp;
        if (confirm(`您確定要刪除元件 '${comp.name}' 嗎？\n(相關連線也會被刪除)`)) {
            blocks = blocks.filter(b => b.id !== comp.id);
            
            // v7.0: 必須同時清除 TX 和 RX 的連線
            [connections_TX, connections_RX].forEach(map => {
                map.delete(comp.id); // 移除輸出
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
            drawCanvas(); // 重繪當前畫布
        }
        rightClickedComp = null;
    }
    
    // v7.0: 修正
    function deleteSelectedLine() {
        if (!rightClickedLine) return;
        
        const { fromComp, toComp, lineId } = rightClickedLine;
        if (confirm(`您確定要刪除從 '${fromComp.name}' 到 '${toComp.name}' 的連接線嗎？`)) {
            // v7.0: 只刪除 currentConnections
            if (currentConnections.has(lineId)) {
                currentConnections.delete(lineId);
                poutLabels = [];
                drawCanvas();
            }
        }
        rightClickedLine = null;
    }

    /**
     * (v9.0 新功能) 複製右鍵點擊的元件
     */
    function duplicateComponent() {
        if (!rightClickedComp) return;
        
        try {
            // 1. 取得原始元件的資料
            const originalComp = rightClickedComp;
            const data = originalComp.toDict();
            
            // 2. 透過 fromDict 建立一個新元件
            // (fromDict 會呼叫建構函式，自動產生新的 comp.id)
            const newComp = RFComponent.fromDict(data);
            
            // 3. 修改新元件的屬性
            newComp.name = `${originalComp.name} (Copy)`;
            newComp.x = originalComp.x + 20; // 稍微偏移
            newComp.y = originalComp.y + 20;
            
            // 4. 清除選取/高亮狀態
            newComp.isSelected = false;
            newComp.isHighlighted = false;

            // 5. 加入到 blocks 陣列
            blocks.push(newComp);
            
            // 6. 重繪
            drawCanvas();

        } catch (e) {
            alert("複製元件時發生錯誤: " + e.message);
            console.error("Duplicate error:", e);
        }
        
        rightClickedComp = null;
    }
	// --- *** (v9.13) 新功能：拆分 (Unmerge) 元件 *** ---
    function unmergeComponent() {
        if (!rightClickedComp || !rightClickedComp.isMerged) return;
        
        const mergedComp = rightClickedComp;
        rightClickedComp = null; // 清除點擊

        if (!confirm(`您確定要將 '${mergedComp.name}' 拆分為 ${mergedComp.childrenData.length} 個原始元件嗎？`)) {
            return;
        }

        try {
            // 1. 取得子元件資料
            const childrenData = mergedComp.childrenData;
            if (!childrenData || childrenData.length === 0) {
                throw new Error("此合併元件沒有子元件資料。");
            }

            const newComps = [];
            let totalWidth = 0;
            const h_spacing = 30; // 水平間距
            
            // 2. 重建子元件
            for (const childData of childrenData) {
                const newComp = RFComponent.fromDict(childData);
                // 重設狀態
                newComp.isSelected = false;
                newComp.isHighlighted = false;
                newComps.push(newComp);
                totalWidth += newComp.width;
            }
            totalWidth += (newComps.length - 1) * h_spacing;

            // 3. 定位新元件 (水平排列)
            let currentX = mergedComp.x + (mergedComp.width / 2) - (totalWidth / 2);
            const startY = mergedComp.y;
            for (const comp of newComps) {
                comp.x = currentX;
                comp.y = startY;
                currentX += comp.width + h_spacing;
            }

            // 4. 尋找合併元件的外部連接點 (TX/RX)
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

            // 5. 刪除合併元件及其所有相關連線
            blocks = blocks.filter(b => b.id !== mergedComp.id);
            [connections_TX, connections_RX].forEach(map => {
                map.delete(mergedComp.id); // 刪除 'from'
                // 刪除 'to'
                let inKey = null;
                for (const [from, to] of map.entries()) {
                    if (to === mergedComp.id) inKey = from;
                }
                if (inKey) map.delete(inKey);
            });
            
            // 6. 將新元件加入畫布
            blocks.push(...newComps);

            // 7. 重新建立連線
            const firstChild = newComps[0];
            const lastChild = newComps[newComps.length - 1];

            // 7a. 外部連線 (連接到新的子鏈路)
            if (inKeyTX) connections_TX.set(inKeyTX, firstChild.id);
            if (outKeyTX) connections_TX.set(lastChild.id, outKeyTX);
            if (inKeyRX) connections_RX.set(inKeyRX, firstChild.id);
            if (outKeyRX) connections_RX.set(lastChild.id, outKeyRX);

            // 7b. 內部連線 (連接子元件)
            for (let i = 0; i < newComps.length - 1; i++) {
                const fromComp = newComps[i];
                const toComp = newComps[i + 1];
                // 必須同時加回 TX 和 RX
                connections_TX.set(fromComp.id, toComp.id);
                connections_RX.set(fromComp.id, toComp.id);
            }

            // 8. 重繪
            drawCanvas();
            alert(`'${mergedComp.name}' 已成功拆分。`);

        } catch (e) {
            alert("拆分元件時發生錯誤: " + e.message);
            console.error("Unmerge error:", e);
        }
    }
    // --- *** (v9.13) 功能結束 *** ---
    // --- 檔案 I/O (v2.0) ---
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
                    // v8.5: fromDict 現在會載入 isMerged 和 childrenData
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
    
    // --- 編輯 Modal 邏輯 (v8.5) ---
    
    function openEditModal(comp) {
        editingComp = comp;
        // v8.5: 對於合併元件，specsByFreq 儲存的是級聯規格，
        // childrenData 儲存的是原始元件資料。
        // editingSpecsCopy 儲存級聯規格的副本。
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
        // v8.5: 如果是合併元件，規格是唯讀的，
        // modalSaveSpecsFromEntries 會直接 return true。
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
        
        // v8.5: 只有在 "非合併元件" 時才需要儲存規格，
        // 因為 "合併元件" 的規格是唯讀的。
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
        // v8.5: 如果是合併元件，規格是唯讀的，
        // modalSaveSpecsFromEntries 會直接 return true。
        if (editingCurrentFreq) {
            if (!modalSaveSpecsFromEntries(editingCurrentFreq)) {
                dom.modalFreqList.value = editingCurrentFreq;
                return;
            }
        }
        
        const selectedFreq = dom.modalFreqList.value;
        if (selectedFreq) {
            editingCurrentFreq = selectedFreq;
            modalToggleSpecEntries(true); // 會處理 isMerged 的情況
            
            // v8.5: 只有非合併元件才需要 "載入" 規格到 "輸入框"
            if (!editingComp.isMerged) {
                 modalLoadSpecsToEntries(selectedFreq);
            }
        } else {
            editingCurrentFreq = null;
            modalToggleSpecEntries(false);
        }
    }
    
    function modalAddFreq() {
        // v8.5: 合併元件不允許手動增刪頻點
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
            // v7.2: 更新預設值
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
        // v8.5: 合併元件不允許手動增刪頻點
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
    
    // v8.7: 修正
    // v9.12: (使用者需求) isSystem 元件在編輯時只儲存 Gain
    function modalSaveSpecsFromEntries(freqStr) {
        // v8.5: 合併元件的規格是唯讀的，跳過儲存
        if (editingComp.isMerged) return true;
        
        if (!freqStr) return true;
        
        try {
            const fullSpecsDict = {};
            
            if (editingComp.isPassive) {
                const specsDict = {};
                specsDict['loss_db'] = parseFloat(document.getElementById('spec-tx-loss_db').value || 0.0);
                
                const tempComp = new RFComponent("temp", editingComp.isPassive, false);
                fullSpecsDict["TX"] = tempComp.calculateSpecs(freqStr, "TX", specsDict);
                fullSpecsDict["RX"] = fullSpecsDict["TX"];
            } else {
                // v7.2: isSystem 和 Active 元件都使用此邏輯

                // --- *** (v9.12) 關鍵修正：isSystem 只儲存 Gain *** ---
                let txSpecs = {};
                let rxSpecs = {};

                if (editingComp.isSystem) {
                    // 天線/陣列 (isSystem)
                    // TX: 只儲存 Gain, NF/P1dB 設為預設 (0/99)
                    txSpecs = {
                        'gain_db': parseFloat(document.getElementById('spec-tx-gain_db').value || 0.0),
                        'nf_db': 0.0,
                        'op1db_dbm': 99.0
                    };
                    // RX: 只儲存 Gain, NF 設為預設 (0)
                    rxSpecs = {
                        'gain_db': parseFloat(document.getElementById('spec-rx-gain_db').value || 0.0),
                        'nf_db': 0.0
                    };
                } else {
                    // 主動元件 (Active)
                    // TX
                    txSpecs = {
                        'gain_db': parseFloat(document.getElementById('spec-tx-gain_db').value || 0.0),
                        'nf_db': parseFloat(document.getElementById('spec-tx-nf_db').value || 0.0),
                        'op1db_dbm': parseFloat(document.getElementById('spec-tx-op1db_dbm').value || 99.0)
                    };
                    // RX
                    rxSpecs = {
                        'gain_db': parseFloat(document.getElementById('spec-rx-gain_db').value || 0.0),
                        'nf_db': parseFloat(document.getElementById('spec-rx-nf_db').value || 0.0)
                    };
                }
                // --- *** (v9.12) 修正結束 *** ---

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
    // v8.7: 修正
    // v9.12: (使用者需求) isSystem 元件在編輯時只載入 Gain
    function modalLoadSpecsToEntries(freqStr) {
        // v8.5: 合併元件沒有輸入框，不需載入
        if (editingComp.isMerged) return;

        const freqData = editingSpecsCopy[freqStr];
        if (!freqData) return;

        const tempComp = new RFComponent("temp", editingComp.isPassive, editingComp.isSystem);
        tempComp.specsByFreq = editingSpecsCopy;
        
        const txRaw = tempComp.getRawSpecsForFreq(freqStr, "TX");
        const rxRaw = tempComp.getRawSpecsForFreq(freqStr, "RX");

        if (editingComp.isPassive) {
            document.getElementById('spec-tx-loss_db').value = txRaw.loss_db;
        } else {
            // --- *** (v9.12) 關鍵修正：isSystem 只載入 Gain *** ---
            if (editingComp.isSystem) {
                // 天線/陣列 (isSystem)
                document.getElementById('spec-tx-gain_db').value = txRaw.gain_db;
                document.getElementById('spec-rx-gain_db').value = rxRaw.gain_db;
            } else {
                // 主動元件 (Active)
                document.getElementById('spec-tx-gain_db').value = txRaw.gain_db;
                document.getElementById('spec-tx-nf_db').value = txRaw.nf_db;
                document.getElementById('spec-tx-op1db_dbm').value = txRaw.op1db_dbm;
                document.getElementById('spec-rx-gain_db').value = rxRaw.gain_db;
                document.getElementById('spec-rx-nf_db').value = rxRaw.nf_db;
            }
            // --- *** (v9.12) 修正結束 *** ---
        }
    }
    // --- (v8.8) 核心函式：產生合併元件的內部規格顯示 ---
    // v9.11: (使用者需求) 原始規格中，被動(isPassive)和天線(isSystem)元件不顯示P1dB
    function buildMergedSpecDisplay(mode, freqStr) {
        const children = editingComp.childrenData;
        if (!children || children.length === 0) return " (內部元件資料遺失)";

        let html = `
            <div style="padding: 5px; background: #2A2A2A; border-radius: 3px; margin-bottom: 10px;">
                <h4 style="margin: 0 0 5px 0; color: #C8A2C8;">原始元件規格 (唯讀)</h4>
                <div class="spec-merged-list" style="font-size: 13px; line-height: 1.6;">
        `;

        children.forEach((child, index) => {
            // v8.5: child 是 toDict() 的結果
            const childFreqData = child.specs_by_freq[freqStr];
	        // v8.9: 修正，被動元件在 rawSpecs 中沒有 P1dB
            const rawSpecs = childFreqData ? childFreqData[mode] : null; 

            html += `<div class="spec-merged-item" style="border-top: 1px solid #444; padding: 4px 0;">`;
            html += `<strong style="color: #E0E0E0;">${index + 1}. ${child.name}</strong><br>`;
            
            if (rawSpecs) {
                if (child.isPassive) {
                    // 1. 被動元件 (Filter, Div) - 原本就沒有 P1dB
                    html += `&nbsp;&nbsp;&nbsp;L (TX/RX): ${formatNum(rawSpecs.loss_db || 0, 1)} dB`;
                    html += ` | NF: ${formatNum(rawSpecs.loss_db || 0, 1)} dB`;
                } else {
                    // 2. 主動元件 (Active) 或天線 (System)
                    let specLine = `&nbsp;&nbsp;&nbsp;G: ${formatNum(rawSpecs.gain_db || 0, 1)} dB | NF: ${formatNum(rawSpecs.nf_db || 0, 1)} dB`;
                    
                    // --- *** (v9.11) 關鍵修正 *** ---
                    // 只有在 TX 模式 *且* 元件是真正的主動元件 (非 Passive 也非 System) 時，才顯示 P1dB
                    if (mode === "TX" && !child.isPassive && !child.isSystem) {
                         specLine += ` | P1: ${formatNum(rawSpecs.op1db_dbm || 99, 1)} dBm`;
                    }
                    // --- *** (v9.11) 修正結束 *** ---
                    
                    html += specLine;
                }
            } else {
                html += `&nbsp;&nbsp;&nbsp;<span style="color: #AAA;">(無 ${freqStr} GHz / ${mode} 模式資料)</span>`;
            }
            html += `</div>`;
        });

        html += '</div></div>';
        
        // --- *** (v8.8) 變更 (Req.1) *** ---
        // 顯示級聯規格 (從 editingSpecsCopy)
        const cascadedSpecs = editingSpecsCopy[freqStr] ? editingSpecsCopy[freqStr][mode] : null;
        if (cascadedSpecs) {
             
            // --- *** (v9.7) 修正顯示邏輯與標籤 *** ---
            // 1. 讀取原始計算值
            const active_gain_db = (cascadedSpecs.active_gain_db || 0);
            const system_gain_db_orig = (cascadedSpecs.system_gain_db || 0);
            const passive_gain_db_orig = (cascadedSpecs.passive_gain_db || 0);
            
            // 2. 根據使用者需求重新分類：將 System (天線) 歸入 Passive
            const passive_gain_db_display = passive_gain_db_orig + system_gain_db_orig;
                
            // 3. 調整標籤樣式寬度以容納新標籤 (160px)
            const labelStyle = "display: inline-block; width: 160px; text-align: right; padding-right: 5px;";
            // 4. 決定小數位數
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
            // --- *** (v9.7) 修正結束 *** ---
            
            // v8.7: (Req.2) 只在 TX 模式顯示總 P1dB
            if (mode === "TX") {
                 // --- *** (v9.7) 修正標籤 (P1dB) *** ---
                 html += `&nbsp;&nbsp;<span style="${labelStyle}">P1dB:</span> ${formatNum(cascadedSpecs.op1db_dbm, p1dbDigits).padStart(6)} dBm`;
                 // --- *** (v9.7) 修正結束 ---
            }
            html += `
                    </div>
                </div>
            `;
        }
        // --- *** (v8.8 / v8.7) 變更結束 *** ---

        return html;
    }

    
    // v8.7: 修正
    // v9.12: (使用者需求) isSystem 元件在編輯時只顯示 Gain
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

        if (editingComp.isPassive) {
            // v7.2: Passive logic
            const fieldset = document.createElement('fieldset');
            fieldset.innerHTML = `<legend>規格 (TX/RX 共用)</legend>`;
            const grid = document.createElement('div');
grid.className = 'spec-grid';
            grid.innerHTML = `
                <label for="spec-tx-loss_db">損耗 (Loss) (dB):</label>
                <input type="text" id="spec-tx-loss_db">
            `;
            fieldset.appendChild(grid);
            dom.modalSpecEditors.appendChild(fieldset);

        } else { 
            // v7.2: Active and isSystem logic
            dom.modalSpecEditors.innerHTML += `
                <div class="spec-tabs">
                    <button class="spec-tab-btn active" data-tab="tx">TX</button>
                    <button class="spec-tab-btn" data-tab="rx">RX</button>
                </div>
                <div id="spec-tab-tx" class="spec-tab-content">
                    </div>
                <div id="spec-tab-rx" class="spec-tab-content hidden">
                    </div>
            `;
            
            // --- *** (v8.5) 核心變更 (Req.1) *** ---
            if (editingComp.isMerged && editingComp.childrenData.length > 0) {
                // --- 情況 A：是合併元件 ---
                // v9.11: buildMergedSpecDisplay 已更新
                document.getElementById('spec-tab-tx').innerHTML = buildMergedSpecDisplay('TX', editingCurrentFreq);
                document.getElementById('spec-tab-rx').innerHTML = buildMergedSpecDisplay('RX', editingCurrentFreq);

            } else {
                // --- 情況 B：是普通元件 (Active 或 System) ---
                
                // --- *** (v9.12) 關鍵修正：isSystem 元件有獨立的介面 *** ---
                if (editingComp.isSystem) {
                    // 這是天線 (Antenna) 或陣列 (Array)
                    // TX 模式：只有 Gain
                    document.getElementById('spec-tab-tx').innerHTML = `
                        <div class="spec-grid">
                            <label for="spec-tx-gain_db">增益 (Gain) (dB):</label>
                            <input type="text" id="spec-tx-gain_db">
                        </div>
                    `;
                    // RX 模式：只有 Gain
                    document.getElementById('spec-tab-rx').innerHTML = `
                         <div class="spec-grid">
                            <label for="spec-rx-gain_db">增益 (Gain) (dB):</label>
                            <input type="text" id="spec-rx-gain_db">
                         </div>
                    `;
                } else {
                    // 這是主動元件 (Active) (LNA, PA)
                    document.getElementById('spec-tab-tx').innerHTML = `
                        <div class="spec-grid">
                            <label for="spec-tx-gain_db">增益 (Gain) (dB):</label>
                            <input type="text" id="spec-tx-gain_db">
                            <label for="spec-tx-nf_db">雜訊指數 (NF) (dB):</label>
                            <input type="text" id="spec-tx-nf_db">
                            <label for="spec-tx-op1db_dbm">輸出 P1dB (dBm):</label>
                            <input type="text" id="spec-tx-op1db_dbm">
                        </div>
                    `;
                    document.getElementById('spec-tab-rx').innerHTML = `
                         <div class="spec-grid">
                            <label for="spec-rx-gain_db">增益 (Gain) (dB):</label>
                            <input type="text" id="spec-rx-gain_db">
                            <label for="spec-rx-nf_db">雜訊指數 (NF) (dB):</label>
                            <input type="text" id="spec-rx-nf_db">
                            </div>
                    `;
                }
                // --- *** (v9.12) 修正結束 *** ---
            }
            // --- *** (v8.5) 變更結束 *** ---

            
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
        // v7.0: 使用 currentConnections
        const allCompsInMap = new Set();
        // v7.1: 修正
        const allBlocksInCurrentChain = new Set();
        
        for (const [fromId, toId] of currentConnections.entries()) {
            allCompsInMap.add(fromId);
            allCompsInMap.add(toId);
            allBlocksInCurrentChain.add(fromId);
            allBlocksInCurrentChain.add(toId);
        }
        
        // v7.1: 修正
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
            if (!currentComp) break; // 安全檢查
            
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
    
    // v7.4
    function calculateLink() {
        // v6.2 (BugFix): 確保在計算前清除拖曳狀態
        dragData.item = null;
        
        clearAllHighlights();
        poutLabels = [];
        
        try {
            let sortedChain = topologicalSortChain();
            if (!sortedChain) return;
            
            // v6.0 (Req.5): 從輸入框讀取頻率
            const calcFreq = dom.entryFreq.value;
            if (!calcFreq) {
                alert("請在頂部輸入計算頻率 (GHz)");
                dom.entryFreq.focus();
                return;
            }
            const calcFreqStr = String(calcFreq);
            
            const p_in = getFloat(dom.entryPin.value, -100.0);
            
            calculator.setSystemParams(p_in);
            
            // v7.0: (Req.1) 移除 RX 反向邏輯
            
            calculator.setChain(sortedChain);
            calculator.calculate(calcFreqStr, currentCalcMode);
            
            const report = calculator.getReport(calcFreqStr, currentCalcMode);
            const calcLog = calculator.getCalcLog(); // v7.4
            
            dom.resultText.textContent = report;
            dom.calcLogText.textContent = calcLog; // v7.4
            
            // v6.0 (Req.2): 儲存計算狀態以更新方塊顯示
            lastCalcFreq = calcFreqStr;
            lastCalcMode = currentCalcMode;
            
            if (currentCalcMode === "TX") {
                drawPoutLabels(); // 會呼叫 drawCanvas
            } else {
                drawCanvas(); // 重繪以更新方塊 (顯示 RX 規格)
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

    /**
     * (v8.1 合併功能) 輔助函式：對選取的元件子集進行拓撲排序
     * @param {RFComponent[]} components - 選取的元件物件陣列
     * @param {Map<string, string>} connections - 當前的連線 Map (TX 或 RX)
     * @returns {RFComponent[]} 排序後的元件陣列
     * @throws {Error} 如果選取無效 (迴路、多起點、不連續)
     */
    function topologicalSortComponents(components, connections) {
        const compIds = new Set(components.map(c => c.id));
        const inDegree = new Map();
        const adj = new Map();
        
        components.forEach(c => {
            inDegree.set(c.id, 0);
            adj.set(c.id, []);
        });
        
        // 僅在選取的元件 *內部* 建立圖
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
        
        // 將 ID 映射回元件物件
        return sortedIds.map(id => components.find(c => c.id === id));
    }

    /**
     * (v9.16) 核心功能：執行合併
     * v9.16: (BugFix) 修正 'mode is not defined' 錯誤，改用 'currentCalcMode'
     * v9.15: (使用者需求) 修正合併邏輯，使其只處理所有元件都支援的「共同頻點」。
     * @param {string[]} selectedIds - 選取的元件 ID 陣列
     */
    function executeMerge(selectedIds) {
        if (selectedIds.length < 2) {
            alert("合併錯誤：請至少選擇 2 個元件。");
            return;
        }

        const selectedComps = blocks.filter(b => selectedIds.includes(b.id));

        try {
            // --- 步驟 4: 拓撲排序 ---
            // (注意：我們使用 currentConnections (當前模式) 來決定排序)
            const sortedChain = topologicalSortComponents(selectedComps, currentConnections);
            
            // --- 步驟 5 (v9.15 修正): 找出可合併的「共同頻點」 ---
            const allFreqs = new Set();
            sortedChain.forEach(c => c.getAvailableFreqs().forEach(f => allFreqs.add(f)));
            if (allFreqs.size === 0) throw new Error("所選元件沒有可用的頻點資料。");
            
            // 1. 找出所有元件都支援的共同頻率 (validFreqs)
            const validFreqs = [];
            for (const freq of allFreqs) {
                let isFreqCommon = true;
                for (const comp of sortedChain) {
                    // 檢查 TX 和 RX 規格是否存在
                    if (!comp.getSpecsForFreq(freq, "TX") || !comp.getSpecsForFreq(freq, "RX")) {
                        isFreqCommon = false;
                        break; // 此頻率無效，換下一個頻率
                    }
                }
                
                if (isFreqCommon) {
                    validFreqs.push(freq);
                }
            }

            // 2. 如果沒有共同頻率，則報錯
            if (validFreqs.length === 0) {
                throw new Error("合併失敗：選擇的元件之間沒有任何共同的可用頻點。\n\n(例如：元件 A 只有 3.5 GHz，元件 B 只有 28 GHz)");
            }

            // 3. (v9.15) 更新確認視窗，只顯示有效的共同頻率
            const validFreqsArray = [...validFreqs].sort((a, b) => parseFloat(a) - parseFloat(b));
            // 優先使用當前計算的頻率，否則使用第一個
            const displayFreq = lastCalcFreq && validFreqs.includes(lastCalcFreq) ? lastCalcFreq : validFreqsArray[0];

            let confirmMsg = `您即將合併以下 ${sortedChain.length} 個元件 (依 ${currentCalcMode} 模式排序)：\n`;
            confirmMsg += "========================================\n";
            sortedChain.forEach((comp, index) => {
                confirmMsg += `(${(index + 1)}) ${comp.name}\n`;
            });
            confirmMsg += "========================================\n";
            // (v9.15) 只顯示有效的頻點
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
                    // --- *** (v9.11) 修正 P1dB 顯示 *** ---
                    let txLine = `  TX: G:${formatNum(txSpecs.gain_db, 1)} | NF:${formatNum(txSpecs.nf_db, 1)}`;
                    
                    // --- *** (v9.16) 關鍵修正 *** ---
                    // 將 'mode' 替換為 'currentCalcMode'
                    if (currentCalcMode === "TX" && !comp.isPassive && !comp.isSystem) {
                         txLine += ` | P1:${formatNum(txSpecs.op1db_dbm || 99, 1)}`;
                    }
                    // --- *** (v9.16) 修正結束 *** ---

                    confirmMsg += txLine + '\n';
                    confirmMsg += `  RX: G:${formatNum(rxSpecs.gain_db, 1)} | NF:${formatNum(rxSpecs.nf_db, 1)}\n`; 
                    // --- *** (v9.11) 修正結束 *** ---
                }
            }
            confirmMsg += "\n您確定要繼續合併嗎？";

            if (!confirm(confirmMsg)) {
                return; // 使用者按下「取消」，中止合併
            }
            
            // --- 步驟 6: 提示名稱 ---
            const newName = prompt("請輸入新元件的名稱:", "Merged-" + sortedChain[0].name);
            if (!newName) return; // 使用者取消

            // --- 步驟 7: (v9.15) 只遍歷 validFreqs ---
            const newSpecsByFreq = {};
            const tempCalculator = new RFLInkBudget();

            for (const freq of validFreqs) {
                
                // (v9.15: 鏈路可以直接使用 sortedChain，因為已預先檢查過)
                const chainForTX = sortedChain;
                const chainForRX = sortedChain;
                
                // 計算 TX 級聯規格
                tempCalculator.setChain(chainForTX);
                tempCalculator.setSystemParams(-100); // 假 Pin
                tempCalculator.calculate(freq, "TX");
                const txRes = tempCalculator.results.chain;
                
                // 計算 RX 級聯規格
                tempCalculator.setChain(chainForRX);
                tempCalculator.setSystemParams(-100); // 假 Pin
                tempCalculator.calculate(freq, "RX");
                const rxRes = tempCalculator.results.chain;
                
                // --- *** (v8.6) 變更 (Req.1) *** ---
                // 儲存規格 (合併後的元件永遠是 "Active" 類型)
                newSpecsByFreq[freq] = {
                    "TX": {
                        'gain_db': txRes.total_gain_db,
                        'nf_db': txRes.total_nf_db,
                        'op1db_dbm': txRes.total_op1db_dbm,
                        // v8.6 (Req.1) 新增: 儲存分離的增益
                        'active_gain_db': txRes.total_active_gain_db,
                        'passive_gain_db': txRes.total_passive_gain_db,
                        'system_gain_db': txRes.total_system_gain_db
                    },
                    "RX": {
                        'gain_db': rxRes.total_gain_db,
                        'nf_db': rxRes.total_nf_db,
                        'op1db_dbm': rxRes.total_op1db_dbm, // v8.7: 雖然 RX P1dB 不顯示，但總 P1dB 仍被計算和儲存
                        // v8.6 (Req.1) 新增: 儲存分離的增益
                        'active_gain_db': rxRes.total_active_gain_db,
                        'passive_gain_db': rxRes.total_passive_gain_db,
                        'system_gain_db': rxRes.total_system_gain_db
                    }
                };
                // --- *** (v8.6) 變更結束 *** ---
            }

            // --- 步驟 8: 建立新元件並替換舊元件 ---
            const startComp = sortedChain[0];
            const endComp = sortedChain[sortedChain.length - 1];

            // 找出子鏈路前後的連接點 (必須同時檢查 TX 和 RX)
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
            
            // 建立新元件 (isPassive=false, isSystem=false)
            // v8.6: newSpecsByFreq 包含計算後的級聯規格 + 分離增益
            const mergedComp = new RFComponent(newName, false, false, newSpecsByFreq);
            mergedComp.x = startComp.x; // 放在起始位置
            mergedComp.y = startComp.y;
            
            // v8.5 (Req.1): 儲存子元件的完整資料
            mergedComp.isMerged = true;
            mergedComp.childrenData = sortedChain.map(c => c.toDict());
            
            blocks.push(mergedComp);
            
            // 刪除舊元件
            const selectedIdsSet = new Set(selectedIds);
            blocks = blocks.filter(b => !selectedIdsSet.has(b.id));
            
            // 刪除舊連線 (從 TX 和 RX Map 中)
            [connections_TX, connections_RX].forEach(map => {
                selectedIds.forEach(id => {
                    map.delete(id); // 刪除 'from'
                });
                for (const [from, to] of map.entries()) {
                    if (selectedIdsSet.has(to)) {
                        map.delete(from); // 刪除 'to'
                    }
                }
            });
            
            // 重新連接
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
    // --- (v8.1) 元件合併 (已實作 v8.2) ---
    function onMergeComponents() {
        if (!isMergeSelectMode) {
            // --- 進入選取模式 ---
            isMergeSelectMode = true;
            mergeSelection = [];
            clearAllSelections(); // 清除之前的選取
            
            dom.mergeButton.textContent = "完成合併";
            // dom.mergeButton.classList.add('active'); // (您可能需要為 .active 添加 CSS)
            
            alert(`進入「合併選取」模式。\n\n請在畫布上點擊您要合併的元件 (必須是 ${currentCalcMode} 模式下的一條連續鏈路)，完成後請再次點擊「完成合併」。`);

        } else {
            // --- 執行合併 ---
            isMergeSelectMode = false;
            dom.mergeButton.textContent = "合併元件";
            // dom.mergeButton.classList.remove('active');

            try {
                executeMerge(mergeSelection);
            } finally {
                // 清理
                mergeSelection = [];
                clearAllSelections();
                drawCanvas();
            }
        }
    }
	// --- *** (v9.14) 新功能：匯出 HTML 報告 *** ---
    function exportFullReport() {
        // 1. 檢查是否有計算結果
        if (!lastCalcFreq || !calculator.results.chain) {
            alert("請先執行一次計算 (Calculate)，再匯出報告。");
            return;
        }
        
        // 2. 取得畫布 (方塊圖) 的圖片
        let imgDataUrl;
        try {
             // 確保畫布是乾淨的 (例如移除 Pout 標籤)
             const poutLabels_backup = poutLabels;
             poutLabels = [];
             drawCanvas();
             imgDataUrl = canvas.toDataURL('image/png');
             // 恢復 Pout 標籤並重繪
             poutLabels = poutLabels_backup;
             drawCanvas();
        } catch (e) {
            alert("無法擷取畫布影像：" + e.message);
            return;
        }

        // 3. 取得報表和日誌文字 (使用 <pre> 以保留格式)
        const resultsText = dom.resultText.textContent;
        const calcLogText = dom.calcLogText.textContent;
        
        // 4. 建立 HTML 內容
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
            white-space: pre; /* 保留換行和空白 */
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

        // 5. 觸發下載
        try {
            const blob = new Blob([htmlTemplate], { type: 'text/html' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            
            // 產生檔名
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
    // --- 啟動應用程式 ---
    document.addEventListener('DOMContentLoaded', init);

})();