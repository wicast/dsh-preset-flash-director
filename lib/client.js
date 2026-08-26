window.__ModuleLoader__.load({
  id: "dsh-flash-director-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    /**
     * dsh-flash-director-ui — Client 半
     *
     * 设置侧栏「Flash 主控」分区页：编辑 Flash 主控·Pro 专家 预设的两类配置
     *   1. 覆盖文件 expert-delegation.config.json（9 键，保存后下次委派生效）
     *   2. 基线 agent.cordis.yml（7 键，行级 patch，新开会话生效）
     * 状态读写走服务端 HTTP 端点 /api/flash-director/{state,override,baseline}。
     * 官方"插件配置"卡片（key=flash-director）对齐服务端 settings 命名空间。
     */
    const inject = ["slots"];

    function insertCss() {
      if (typeof document === "undefined") return;
      if (document.getElementById("dsh-flash-director-ui-style") !== null) return;
      const tag = document.createElement("style");
      tag.id = "dsh-flash-director-ui-style";
      tag.textContent = [
        ".fd-panel{display:flex;flex-direction:column;gap:14px;padding:4px 2px 20px}",
        ".fd-h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#ddd)}",
        ".fd-card{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}",
        ".fd-path{font-size:11px;font-family:ui-monospace,monospace;color:var(--dsw-alias-label-tertiary,#999);line-height:1.8;word-break:break-all}",
        ".fd-badges{display:flex;flex-wrap:wrap;gap:6px}",
        ".fd-badge{font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));color:var(--dsw-alias-label-secondary,#bbb)}",
        ".fd-badge-ok{color:var(--dsw-alias-state-success-primary,#2ecc71);border-color:var(--dsw-alias-state-success-primary,rgba(46,204,113,.5));background:var(--dsw-alias-state-success-tertiary,rgba(46,204,113,.08))}",
        ".fd-badge-warn{color:var(--dsw-alias-state-warn-primary,#f1c40f);border-color:var(--dsw-alias-state-warn-primary,rgba(241,196,15,.5))}",
        ".fd-badge-err{color:var(--dsw-alias-state-error-primary,#e74c3c);border-color:var(--dsw-alias-state-error-primary,rgba(231,76,60,.5));background:var(--dsw-alias-state-error-tertiary,rgba(231,76,60,.08))}",
        ".fd-field{display:flex;flex-direction:column;gap:4px}",
        ".fd-row{display:flex;align-items:center;justify-content:space-between;gap:12px}",
        ".fd-field-main{min-width:0;flex:1}",
        ".fd-label{font-size:13px;color:var(--dsw-alias-label-primary,#ddd)}",
        ".fd-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-top:2px}",
        ".fd-input{width:180px;flex:none;font-size:12.5px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary,#ddd)}",
        ".fd-input:focus{outline:none;border-color:var(--dsw-alias-state-info-primary,rgba(52,152,219,.6))}",
        ".fd-select{width:180px;flex:none;font-size:12.5px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary,#ddd);cursor:pointer}",
        ".fd-select option{background:#1e1e1e;color:var(--dsw-alias-label-primary,#ddd)}",
        ".fd-eff{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#999);font-family:ui-monospace,monospace}",
        ".fd-btns{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
        ".fd-btn{font-size:12px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary,#ddd);cursor:pointer}",
        ".fd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}",
        ".fd-btn:disabled{opacity:.45;cursor:default}",
        ".fd-btn-ok{color:var(--dsw-alias-state-success-primary,#2ecc71);border-color:var(--dsw-alias-state-success-primary,rgba(46,204,113,.5))}",
        ".fd-btn-danger{color:var(--dsw-alias-state-error-primary,#e74c3c);border-color:var(--dsw-alias-state-error-primary,rgba(231,76,60,.5))}",
        ".fd-feedback{font-size:12px;margin-left:2px}",
        ".fd-ok{color:var(--dsw-alias-state-success-primary,#2ecc71)}",
        ".fd-err{color:var(--dsw-alias-state-error-primary,#e74c3c)}",
        ".fd-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}",
        ".fd-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#ddd)}",
        ".fd-card-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#999)}",
      ].join("");
      document.head.appendChild(tag);
    }

    // ---- API ----
    function apiGet(path) {
      return fetch(path).then((r) => r.json()).catch(() => null);
    }
    function apiPost(path, body) {
      return fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then((r) => r.json()).catch(() => null);
    }

    // ---- 字段定义 ----
    const OVERRIDE_FIELDS = [
      { key: "expertProvider", label: "专家 Provider", sub: "从 DSH 现有设置下拉选择（模型选择器同源数据）", type: "text", ph: "deepseek-official" },
      { key: "expertModel", label: "专家模型", sub: "随 Provider 联动下拉；主控用会话级模型选择", type: "text", ph: "deepseek-v4-pro" },
      { key: "expertMaxTokens", label: "专家输出上限（含思考 token）", sub: "太小会导致正文报告被截断", type: "number" },
      { key: "maxExpertsPerUserTask", label: "每任务专家委派预算", sub: "stakes:high 审查计 2；用完即拒", type: "number" },
      { key: "briefMaxChars", label: "简报整体字符上限", sub: "task/background/evidence 字段配额之和预留余量", type: "number" },
      { key: "expertReuse", label: "会话内复用", sub: "session=按角色复用子代理 followup 续聊；off=每次新建", type: "select", options: [["", "继承(基线/默认)"], ["session", "session"], ["off", "off"]] },
      { key: "reuseMaxFollowups", label: "复用轮换上限", sub: "达到后强制新建并替换该角色子代理", type: "number" },
      { key: "followupRetryBudget", label: "瞬态失败重试预算", sub: "followup 瞬态失败的有界重试次数", type: "number" },
      { key: "expertReasoningEffort", label: "专家思考强度", sub: "缺省=不注入；⚠ 部署禁用 thinking 时 low/high/max 会报错", type: "select", options: [["", "缺省(不注入)"], ["off", "off"], ["low", "low"], ["high", "high"], ["max", "max"]] },
    ];
    const BASELINE_KEYS = ["expertProvider", "expertModel", "expertMaxTokens", "maxExpertsPerUserTask", "briefMaxChars", "expertReuse", "reuseMaxFollowups"];
    const BASELINE_FIELDS = OVERRIDE_FIELDS.filter((f) => BASELINE_KEYS.includes(f.key)).map((f) =>
      f.key === "expertReuse" ? { ...f, options: [["session", "session"], ["off", "off"]] } : f
    );

    // ---- 主设置页 ----
    function SettingsPanel() {
      const [st, setSt] = react.useState(null);
      const [drafts, setDrafts] = react.useState({});
      const [fb, setFb] = react.useState({});
      const [saving, setSaving] = react.useState({});
      const [armRm, setArmRm] = react.useState(false);

      const load = () => apiGet("/api/flash-director/state").then((s) => { if (s) setSt(s); }).catch(() => {});
      react.useEffect(() => { load(); }, []);

      if (!st) return react.createElement("div", { className: "fd-panel" }, "加载中…");

      const ovValues = (st.override && st.override.values) || {};
      const bsValues = (st.baseline && st.baseline.values) || {};
      const eff = st.effective || {};
      const src = st.source || {};
      const ovDraft = drafts.ov !== undefined ? drafts.ov : {};
      const bsDraft = drafts.bs !== undefined ? drafts.bs : {};
      const ovVal = (k) => ovDraft[k] !== undefined ? ovDraft[k] : String(ovValues[k] !== undefined ? ovValues[k] : "");
      const bsVal = (k) => bsDraft[k] !== undefined ? bsDraft[k] : String(bsValues[k] !== undefined ? bsValues[k] : "");
      const setOv = (k, v) => setDrafts({ ...drafts, ov: { ...ovDraft, [k]: v } });
      const setBs = (k, v) => setDrafts({ ...drafts, bs: { ...bsDraft, [k]: v } });

      const setMsg = (id, kind, text) => {
        setFb({ ...fb, [id]: { kind, text } });
        if (kind === "ok") setTimeout(() => setFb((prev) => { const n = { ...prev }; delete n[id]; return n; }), 4000);
      };
      const markSaving = (id, on) => setSaving({ ...saving, [id]: on });

      const buildValues = (fields, get) => {
        const values = {};
        for (const f of fields) {
          const v = String(get(f.key) === undefined || get(f.key) === null ? "" : get(f.key)).trim();
          if (v === "") continue;
          values[f.key] = f.type === "number" ? Number(v) : v;
        }
        return values;
      };

      const saveOverride = () => {
        markSaving("ov", true);
        apiPost("/api/flash-director/override", { values: buildValues(OVERRIDE_FIELDS, ovVal) })
          .then((d) => {
            if (d && d.ok !== false) {
              setMsg("ov", "ok", "已保存覆盖文件，下次委派生效");
              setDrafts({ ...drafts, ov: undefined });
            } else {
              setMsg("ov", "err", "保存失败：" + ((d && d.error) || "未知错误"));
            }
            load();
          })
          .catch(() => setMsg("ov", "err", "保存失败：网络错误"))
          .finally(() => markSaving("ov", false));
      };

      const removeOverride = () => {
        if (!armRm) {
          setArmRm(true);
          setTimeout(() => setArmRm(false), 3000);
          return;
        }
        markSaving("rm", true);
        apiPost("/api/flash-director/override", { values: {} })
          .then((d) => {
            if (d && d.ok !== false) {
              setMsg("ov", "ok", "已移除覆盖文件，恢复基线");
              setDrafts({ ...drafts, ov: undefined });
            } else {
              setMsg("ov", "err", "移除失败：" + ((d && d.error) || "未知错误"));
            }
            load();
          })
          .catch(() => setMsg("ov", "err", "移除失败：网络错误"))
          .finally(() => { markSaving("rm", false); setArmRm(false); });
      };

      const saveBaseline = () => {
        markSaving("bs", true);
        apiPost("/api/flash-director/baseline", { patch: buildValues(BASELINE_FIELDS, bsVal) })
          .then((d) => {
            if (d && d.ok !== false) {
              setMsg("bs", "ok", "已保存基线，新开会话生效" + (d.backupPath ? "（备份 " + d.backupPath.split("/").pop() + "）" : ""));
              setDrafts({ ...drafts, bs: undefined });
            } else {
              setMsg("bs", "err", "保存失败（未修改）：" + ((d && d.error) || "未知错误"));
            }
            load();
          })
          .catch(() => setMsg("bs", "err", "保存失败：网络错误"))
          .finally(() => markSaving("bs", false));
      };

      const effLabel = (k) => {
        const v = eff[k] !== undefined ? String(eff[k]) : "缺省";
        const s = src[k] || "default";
        const tag = s === "override" ? "override" : s === "baseline" ? "基线" : "默认";
        return "生效=" + v + " · " + tag;
      };

      // provider/model 下拉（数据来自服务端 llm catalog，与 DSH 模型选择器同源）
      const providers = st.providers || [];
      const renderControl = (f, get, set, isBaseline) => {
        const providerOptions = () => {
          const list = providers.map((p) => [p.id, p.name && p.name !== p.id ? p.name + " (" + p.id + ")" : p.id]);
          const cur = get("expertProvider");
          if (cur && !list.some(([v]) => v === cur)) list.unshift([cur, cur + "（当前值，不在列表）"]);
          return list;
        };
        const modelOptionsFor = (providerId) => {
          let list = [];
          if (providerId) {
            const p = providers.find((x) => x.id === providerId);
            list = ((p && p.models) || []).map((m) => [m.id, m.name && m.name !== m.id ? m.name + " (" + m.id + ")" : m.id]);
          } else {
            for (const p of providers) for (const m of p.models || []) list.push([m.id, p.name + " / " + m.id]);
          }
          const cur = get("expertModel");
          if (cur && !list.some(([v]) => v === cur)) list.unshift([cur, cur + "（当前值，不在列表）"]);
          return list;
        };
        const catalogSelect = (options) => {
          const opts = isBaseline ? options : [["", "继承(基线/默认)"], ...options];
          return react.createElement("select", {
            className: "fd-select",
            value: get(f.key),
            onChange: (e) => set(f.key, e.target.value),
          }, opts.map(([v, label]) => react.createElement("option", { key: v + "::" + label, value: v }, label)));
        };
        if (f.key === "expertProvider" && providers.length > 0) return catalogSelect(providerOptions());
        if (f.key === "expertModel" && providers.length > 0) return catalogSelect(modelOptionsFor(get("expertProvider")));
        if (f.type === "select") {
          return react.createElement("select", {
            className: "fd-select",
            value: get(f.key),
            onChange: (e) => set(f.key, e.target.value),
          }, f.options.map(([v, label]) => react.createElement("option", { key: v, value: v }, label)));
        }
        return react.createElement("input", {
          className: "fd-input",
          type: "text",
          value: get(f.key),
          placeholder: f.ph || "",
          onChange: (e) => set(f.key, e.target.value),
        });
      };

      const renderField = (f, get, set, isBaseline) =>
        react.createElement("div", { key: f.key, className: "fd-row" }, [
          react.createElement("div", { className: "fd-field-main" }, [
            react.createElement("div", { className: "fd-label" }, f.label),
            react.createElement("div", { className: "fd-sub" }, f.sub),
            react.createElement("div", { className: "fd-eff" }, effLabel(f.key)),
          ]),
          renderControl(f, get, set, isBaseline),
        ]);

      const overrideFields = OVERRIDE_FIELDS.map((f) => renderField(f, ovVal, setOv, false));
      const baselineFields = BASELINE_FIELDS.map((f) => renderField(f, bsVal, setBs, true));

      const badgeOverride = st.override && st.override.configError
        ? react.createElement("span", { className: "fd-badge fd-badge-err", title: st.override.configError }, "覆盖文件畸形")
        : (st.override && st.override.exists
          ? react.createElement("span", { className: "fd-badge fd-badge-ok" }, "覆盖文件存在")
          : react.createElement("span", { className: "fd-badge fd-badge-warn" }, "覆盖文件缺失（用基线）"));
      const badgeBaseline = st.baseline && st.baseline.configError
        ? react.createElement("span", { className: "fd-badge fd-badge-err", title: st.baseline.configError }, "基线不可读")
        : (st.baseline && st.baseline.exists
          ? react.createElement("span", { className: "fd-badge fd-badge-ok" }, "基线可编辑")
          : react.createElement("span", { className: "fd-badge fd-badge-err" }, "基线缺失"));

      return react.createElement("div", { className: "fd-panel" }, [
        react.createElement("h3", { className: "fd-h3" }, "Flash 主控 · 委派配置"),
        react.createElement("div", { className: "fd-card" }, [
          react.createElement("div", { className: "fd-badges" }, [badgeOverride, badgeBaseline]),
          react.createElement("div", { className: "fd-path" }, [
            "覆盖文件: " + (st.overridePath || "(未找到活动 preset)"),
            react.createElement("br", null),
            "基线文件: " + (st.baselinePath || "(未找到活动 preset)"),
            react.createElement("br", null),
            "$DSH_HOME: " + st.dshHome,
          ]),
          st.override && st.override.configError
            ? react.createElement("div", { className: "fd-note fd-err" }, "⚠ " + st.override.configError)
            : null,
        ]),

        react.createElement("div", { className: "fd-card" }, [
          react.createElement("div", { className: "fd-h3" }, "覆盖文件 · expert-delegation.config.json"),
          react.createElement("div", { className: "fd-note" }, "部分覆盖语义：留空的键回退基线/默认。保存后下次委派即生效（无需重启）。"),
          ...overrideFields,
          react.createElement("div", { className: "fd-btns" }, [
            react.createElement("button", {
              type: "button",
              className: "fd-btn",
              disabled: saving.ov,
              onClick: saveOverride,
            }, saving.ov ? "保存中…" : "保存覆盖"),
            react.createElement("button", {
              type: "button",
              className: "fd-btn fd-btn-danger",
              disabled: saving.rm || !st.override.exists,
              onClick: removeOverride,
            }, armRm ? "确认移除？" : "移除覆盖文件（恢复基线）"),
            fb.ov ? react.createElement("span", { className: "fd-feedback " + (fb.ov.kind === "ok" ? "fd-ok" : "fd-err") }, fb.ov.text) : null,
          ]),
        ]),

        react.createElement("div", { className: "fd-card" }, [
          react.createElement("div", { className: "fd-h3" }, "基线 · agent.cordis.yml（7 键）"),
          react.createElement("div", { className: "fd-note" }, "⚠ 基线改动需新开会话生效；followupRetryBudget 与 expertReasoningEffort 不在基线，只能走覆盖文件。保存时自动备份并做 YAML 校验。"),
          ...baselineFields,
          react.createElement("div", { className: "fd-btns" }, [
            react.createElement("button", {
              type: "button",
              className: "fd-btn",
              disabled: saving.bs,
              onClick: saveBaseline,
            }, saving.bs ? "保存中…" : "保存基线"),
            fb.bs ? react.createElement("span", { className: "fd-feedback " + (fb.bs.kind === "ok" ? "fd-ok" : "fd-err") }, fb.bs.text) : null,
          ]),
        ]),
      ]);
    }

    // ---- 插件配置卡片（settings.plugin.item，key=flash-director 对齐命名空间）----
    function SettingsCard() {
      const [st, setSt] = react.useState(null);
      react.useEffect(() => {
        apiGet("/api/flash-director/state").then((s) => { if (s) setSt(s); }).catch(() => {});
      }, []);
      const eff = st && st.effective ? st.effective : {};
      const overridden = st && st.override && st.override.exists;
      return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, [
        react.createElement("div", { className: "fd-card-title" }, "Flash 主控 · Pro 专家"),
        react.createElement("div", { className: "fd-card-sub" },
          (overridden ? "覆盖配置生效 · " : "使用基线/默认 · ") + "专家模型 " + (eff.expertModel || "缺省")),
        react.createElement("div", { className: "fd-card-sub" },
          "完整编辑：设置 → Flash 主控（覆盖文件下次委派生效；基线新开会话生效）"),
      ]);
    }

    function apply(ctx) {
      insertCss();
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      slots.inject("settings.section", () => slots.register(
        { name: "settings.section", id: "dsh-flash-director-ui-section", order: 30, label: "Flash 主控" },
        () => react.createElement(SettingsPanel)
      ));
      slots.inject("settings.plugin.item", () => slots.register(
        { name: "settings.plugin.item", key: "flash-director", id: "flash-director" },
        () => react.createElement(SettingsCard)
      ));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
