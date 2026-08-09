(() => {
  "use strict";

  if (window.musterSurfaceAdapters?.schemaVersion === 1) return;

  const CONTRACT_VERSION = 1;
  const MAX_ADAPTERS = 24;
  const ID = /^[a-z][a-z0-9-]{0,63}$/;
  const DOCTYPE = /^(?:\*|[A-Za-z][A-Za-z0-9 _-]{0,139})$/;
  const PATH = /^\/(?:[A-Za-z0-9._~-]+\/?)*$/;
  const OPERATIONS = new Set(["create", "update", "delete"]);
  const records = new Map();
  const modules = Object.freeze([
    {prefix: "/crm/", surface: "crm", source: "/assets/muster/js/surfaces/crm.js?v=20260720-4"},
    {prefix: "/helpdesk/", surface: "helpdesk", source: "/assets/muster/js/surfaces/helpdesk.js?v=20260720-3"},
  ]);
  const moduleLoads = new Map();
  const registrations = new Map();
  const RESUME_HASH = /^#muster-attended-resume=([A-Za-z0-9_-]{48,512})$/;

  class MusterSurfaceUnavailableError extends Error {
    constructor() {
      super("Muster cannot open a verified attended preview in this application surface yet.");
      this.name = "MusterSurfaceUnavailableError";
    }
  }

  const randomKey = () => window.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 24)
    || `${Date.now()}${Math.random()}`.replace(/\D/g, "").padEnd(24, "0").slice(0, 24);

  async function governedMethod(method, args) {
    const payload = {...args, idempotency_key: randomKey()};
    if (window.frappe?.call) {
      const response = await window.frappe.call({method, type: "POST", args: payload, freeze: false});
      return response?.message;
    }
    const pathname = String(window.location?.pathname || "/");
    const family = surfaceContext().family;
    const supportQuery = ["crm", "helpdesk"].includes(family)
      ? `surface=${encodeURIComponent(family)}` : `route=${encodeURIComponent(pathname)}`;
    const support = await window.fetch(`/api/method/muster.api.surface.bootstrap?${supportQuery}`, {
      credentials: "same-origin", cache: "no-store", headers: {Accept: "application/json"},
    });
    const bootstrap = support.ok ? (await support.json())?.message : null;
    if (!bootstrap || bootstrap.supported !== true || typeof bootstrap.csrf_token !== "string" || !bootstrap.csrf_token.trim()) {
      throw new MusterSurfaceUnavailableError();
    }
    const response = await window.fetch(`/api/method/${method}`, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "X-Frappe-CSRF-Token": bootstrap.csrf_token.trim()},
      body: new URLSearchParams(payload).toString(),
    });
    if (!response.ok) throw new MusterSurfaceUnavailableError();
    return (await response.json())?.message;
  }

  async function waitForSavedRecord(doctype, recordName, timeout = 5_000) {
    const started = Date.now();
    const resource = `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(recordName)}`;
    while (Date.now() - started < timeout) {
      const response = await window.fetch(resource, {
        method: "GET", credentials: "same-origin", cache: "no-store", headers: {Accept: "application/json"},
      });
      if (response.ok) return true;
      if (response.status !== 404) throw new MusterSurfaceUnavailableError();
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    throw new MusterSurfaceUnavailableError();
  }

  function arrayOf(value, predicate, maximum) {
    return Array.isArray(value) && value.length > 0 && value.length <= maximum
      && value.every((item) => typeof item === "string" && predicate(item));
  }

  function normalize(adapter) {
    if (!adapter || typeof adapter !== "object" || adapter.schemaVersion !== CONTRACT_VERSION
      || typeof adapter.id !== "string" || !ID.test(adapter.id)
      || typeof adapter.label !== "string" || !adapter.label.trim() || adapter.label.length > 120
      || !arrayOf(adapter.pathPrefixes, (value) => PATH.test(value) && value.endsWith("/") && !value.includes(".."), 12)
      || !arrayOf(adapter.doctypes, (value) => DOCTYPE.test(value), 120)
      || !arrayOf(adapter.operations, (value) => OPERATIONS.has(value), 3)
      || !adapter.capabilities || typeof adapter.capabilities !== "object"
      || adapter.capabilities.navigate !== true || adapter.capabilities.fill !== true
      || adapter.capabilities.pauseBeforeSave !== true
      || adapter.capabilities.save !== "separate_confirmation"
      || (adapter.operations.includes("delete") && adapter.capabilities.destructiveReview !== "typed_confirmation_native_one_time")
      || typeof adapter.start !== "function") {
      throw new MusterSurfaceUnavailableError();
    }
    const priority = Number.isInteger(adapter.priority) && adapter.priority >= 0 && adapter.priority <= 100
      ? adapter.priority : 0;
    return Object.freeze({
      schemaVersion: CONTRACT_VERSION,
      id: adapter.id,
      label: adapter.label.trim(),
      priority,
      pathPrefixes: Object.freeze([...new Set(adapter.pathPrefixes)]),
      doctypes: Object.freeze([...new Set(adapter.doctypes)]),
      operations: Object.freeze([...new Set(adapter.operations)]),
      capabilities: Object.freeze({
        navigate: true, fill: true, pauseBeforeSave: true, save: "separate_confirmation",
        ...(adapter.operations.includes("delete") ? {destructiveReview: "typed_confirmation_native_one_time"} : {}),
      }),
      start: adapter.start,
    });
  }

  function register(adapter) {
    const normalized = normalize(adapter);
    if (records.has(normalized.id)) return () => false;
    if (!records.has(normalized.id) && records.size >= MAX_ADAPTERS) throw new MusterSurfaceUnavailableError();
    records.set(normalized.id, normalized);
    return () => records.delete(normalized.id);
  }

  function surfaceContext() {
    const pathname = String(window.location?.pathname || "/");
    let family = "custom";
    if (/^\/(?:app|desk)(?:\/|$)/.test(pathname)) family = "desk";
    else if (/^\/crm(?:\/|$)/.test(pathname)) family = "crm";
    else if (/^\/(?:helpdesk|support)(?:\/|$)/.test(pathname)) family = "helpdesk";
    else if (/^\/(?:hrms|hr)(?:\/|$)/.test(pathname)) family = "hrms";
    return Object.freeze({schemaVersion: CONTRACT_VERSION, pathname, family});
  }

  function normalizedReceipt(value) {
    if (!value || typeof value !== "object" || value.executed !== false
      || !OPERATIONS.has(value.operation) || typeof value.doctype !== "string"
      || !DOCTYPE.test(value.doctype) || value.doctype === "*"
      || typeof value.proposal !== "string" || !value.proposal.trim() || value.proposal.length > 140
      || typeof value.objective !== "string" || !value.objective.trim() || value.objective.length > 10_000
      || !Array.isArray(value.fields) || value.fields.length > 100
      || (value.operation !== "delete" && (value.save_requires_confirmation !== true
        || typeof value.save_authorized !== "boolean" || value.fields.length < 1))
      || (value.operation === "delete" && (value.delete_requires_confirmation !== true
        || typeof value.delete_authorized !== "boolean" || value.fields.length !== 0))) {
      throw new MusterSurfaceUnavailableError();
    }
    const scalarField = (field) => {
      const fieldValue = String(field?.value ?? "");
      if (!field || typeof field !== "object" || typeof field.fieldname !== "string"
        || !/^[A-Za-z][A-Za-z0-9_]{0,139}$/.test(field.fieldname)
        || typeof field.label !== "string" || !field.label.trim() || field.label.length > 140
        || !["fill", "select"].includes(field.control)
        || !fieldValue.trim() || fieldValue.length > 10_000) {
        throw new MusterSurfaceUnavailableError();
      }
      return Object.freeze({fieldname: field.fieldname, label: field.label, control: field.control, value: fieldValue});
    };
    const fields = value.fields.map((field) => {
      if (field?.control !== "table") return scalarField(field);
      if (typeof field.fieldname !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,139}$/.test(field.fieldname)
        || typeof field.label !== "string" || !field.label.trim() || field.label.length > 140
        || typeof field.child_doctype !== "string" || !DOCTYPE.test(field.child_doctype) || field.child_doctype === "*"
        || !Array.isArray(field.rows) || !field.rows.length || field.rows.length > 20) {
        throw new MusterSurfaceUnavailableError();
      }
      const rows = field.rows.map((row) => {
        if (!Array.isArray(row) || !row.length || row.length > 40) throw new MusterSurfaceUnavailableError();
        const normalized = row.map(scalarField);
        if (new Set(normalized.map((child) => child.fieldname)).size !== normalized.length) {
          throw new MusterSurfaceUnavailableError();
        }
        return Object.freeze(normalized);
      });
      return Object.freeze({
        fieldname: field.fieldname, label: field.label, control: "table",
        child_doctype: field.child_doctype, rows: Object.freeze(rows),
      });
    });
    if (new Set(fields.map((field) => field.fieldname)).size !== fields.length) throw new MusterSurfaceUnavailableError();
    const recordName = value.record_name == null ? null : value.record_name;
    if ((["update", "delete"].includes(value.operation) && (typeof recordName !== "string" || !recordName.trim() || recordName.length > 500))
      || (value.operation === "create" && recordName !== null)) throw new MusterSurfaceUnavailableError();
    const recordRevision = value.record_revision == null ? null : value.record_revision;
    if ((["update", "delete"].includes(value.operation) && (typeof recordRevision !== "string" || !recordRevision.trim()
      || recordRevision.length > 100 || /[\u0000-\u001f\u007f]/.test(recordRevision)))
      || (value.operation === "create" && recordRevision !== null)) throw new MusterSurfaceUnavailableError();
    const approvalProof = value.approval_proof == null ? null : value.approval_proof;
    if (value.operation === "delete") {
      if ((value.delete_authorized && (typeof approvalProof !== "string" || !/^[a-f0-9]{64}$/.test(approvalProof)))
        || (!value.delete_authorized && approvalProof !== null)) throw new MusterSurfaceUnavailableError();
      return Object.freeze({
        proposal: value.proposal, objective: value.objective, operation: "delete",
        doctype: value.doctype, record_name: recordName, record_revision: recordRevision,
        approval_proof: approvalProof, delete_authorized: value.delete_authorized,
        delete_requires_confirmation: true, executed: false, fields: Object.freeze([]),
      });
    }
    if (approvalProof !== null) throw new MusterSurfaceUnavailableError();
    return Object.freeze({
      proposal: value.proposal,
      objective: value.objective,
      operation: value.operation,
      doctype: value.doctype,
      record_name: recordName,
      record_revision: recordRevision,
      save_authorized: value.save_authorized,
      save_requires_confirmation: true,
      executed: false,
      fields: Object.freeze(fields),
    });
  }

  function discover() {
    const detail = Object.freeze({schemaVersion: CONTRACT_VERSION, register});
    try {
      window.dispatchEvent?.(new CustomEvent("muster:discover-surface-adapters", {detail}));
    } catch (_error) {
      // CustomEvent is absent in a few embedded webviews; direct registration
      // remains available through window.musterSurfaceAdapters.register.
    }
  }

  function loadKnownSurface() {
    const pathname = String(window.location?.pathname || "/");
    const module = modules.find((candidate) => pathname === candidate.prefix.slice(0, -1) || pathname.startsWith(candidate.prefix));
    if (!module) return loadConfiguredSurface(pathname);
    if (!window.document?.createElement || !window.document?.head?.appendChild) return Promise.resolve();
    if (moduleLoads.has(module.source)) return moduleLoads.get(module.source);
    const loading = new Promise((resolve) => {
      const script = window.document.createElement("script");
      script.src = module.source;
      script.async = true;
      script.dataset.musterSurfaceModule = "true";
      script.onload = () => Promise.resolve(registrations.get(module.surface)).then(resolve, resolve);
      script.onerror = resolve;
      window.document.head.appendChild(script);
    });
    moduleLoads.set(module.source, loading);
    return loading;
  }

  async function loadConfiguredSurface(pathname) {
    const key = `configured:${pathname}`;
    if (moduleLoads.has(key)) return moduleLoads.get(key);
    const loading = (async () => {
      try {
        const response = await window.fetch(`/api/method/muster.api.surface.bootstrap?route=${encodeURIComponent(pathname)}`, {
          credentials: "same-origin", cache: "no-store", headers: {Accept: "application/json"},
        });
        if (!response.ok) return;
        const value = (await response.json())?.message;
        if (!value || value.schema_version !== 1 || value.adapter_contract !== CONTRACT_VERSION
          || value.surface !== "custom" || value.supported !== true
          || typeof value.installed_version !== "string"
          || !/^\d{1,2}\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(value.installed_version)) return;
        registerKnown(value.descriptor);
      } catch (_error) {
        // Unknown, malformed and unavailable custom surfaces remain disabled.
      }
    })();
    moduleLoads.set(key, loading);
    return loading;
  }

  async function supportedSurface(surface) {
    if (!["crm", "helpdesk"].includes(surface)) throw new MusterSurfaceUnavailableError();
    try {
      const response = await window.fetch(`/api/method/muster.api.surface.bootstrap?surface=${encodeURIComponent(surface)}`, {
        credentials: "same-origin", cache: "no-store", headers: {Accept: "application/json"},
      });
      if (!response.ok) throw new MusterSurfaceUnavailableError();
      const value = (await response.json())?.message;
      if (!value || value.schema_version !== 1 || value.adapter_contract !== CONTRACT_VERSION
        || value.surface !== surface || value.supported !== true
        || typeof value.installed_version !== "string" || !/^1\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(value.installed_version)) {
        throw new MusterSurfaceUnavailableError();
      }
      return Object.freeze({surface, installedVersion: value.installed_version});
    } catch (_error) {
      throw new MusterSurfaceUnavailableError();
    }
  }

  function registerSupported(surface, definition) {
    if (registrations.has(surface)) return registrations.get(surface);
    const pending = supportedSurface(surface).then(() => registerKnown(definition));
    registrations.set(surface, pending);
    return pending;
  }

  function semanticAdapter(definition) {
    const sleep = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
    let csrfToken = "";
    const governedMethod = async (method, args) => {
      if (!csrfToken) {
        const knownSurface = definition.id === "muster-frappe-crm" ? "crm"
          : (definition.id === "muster-frappe-helpdesk" ? "helpdesk" : "");
        const supportQuery = knownSurface
          ? `surface=${encodeURIComponent(knownSurface)}`
          : `route=${encodeURIComponent(String(window.location.pathname || "/"))}`;
        const support = await window.fetch(`/api/method/muster.api.surface.bootstrap?${supportQuery}`, {
          credentials: "same-origin", cache: "no-store", headers: {Accept: "application/json"},
        });
        const bootstrap = support.ok ? (await support.json())?.message : null;
        if (!bootstrap || bootstrap.supported !== true || (knownSurface && bootstrap.surface !== knownSurface)
          || typeof bootstrap.csrf_token !== "string" || !bootstrap.csrf_token.trim()) throw new MusterSurfaceUnavailableError();
        csrfToken = bootstrap.csrf_token.trim();
      }
      const response = await window.fetch(`/api/method/${encodeURIComponent(method)}`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: {"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "X-Frappe-CSRF-Token": csrfToken},
        body: new URLSearchParams({...args, idempotency_key: randomKey()}).toString(),
      });
      if (!response.ok) throw new MusterSurfaceUnavailableError();
      return (await response.json())?.message;
    };
    const takeover = () => {
      let style = window.document.querySelector("style[data-muster-takeover-style]");
      if (!style) {
        style = window.document.createElement("style");
        style.dataset.musterTakeoverStyle = "true";
        style.textContent = ".muster-spa-takeover{position:fixed;z-index:2147483001;left:50%;top:max(14px,env(safe-area-inset-top));transform:translateX(-50%);box-sizing:border-box;max-width:calc(100vw - 24px);padding:8px 12px;border-radius:999px;background:#20142f;color:#fff;font:600 12px/1.3 system-ui,sans-serif;text-align:center;overflow-wrap:anywhere;box-shadow:0 8px 28px #20142f4d;pointer-events:none}.muster-spa-takeover[data-state=paused]{background:#166534}.muster-spa-takeover[data-state=stopped]{background:#9f1239}.muster-spa-cursor{position:fixed;z-index:2147483002;left:0;top:0;width:190px;height:36px;transform:translate(-220px,-60px);transition:transform .42s cubic-bezier(.2,.8,.2,1);pointer-events:none;filter:drop-shadow(0 2px 2px #0005);color:#fff;font:700 11px/1.2 system-ui,sans-serif}.muster-spa-cursor:before{content:'↖';display:inline-block;vertical-align:top;color:#7c3aed;font:900 27px/1 system-ui,sans-serif;-webkit-text-stroke:1px white}.muster-spa-cursor:after{content:attr(data-label);display:inline-block;box-sizing:border-box;max-width:155px;margin:4px 0 0 3px;padding:4px 7px;border-radius:999px;background:#6d28d9;white-space:normal}@media(max-width:767px){.muster-spa-takeover{top:max(8px,env(safe-area-inset-top));border-radius:12px}.muster-spa-cursor{width:170px}.muster-spa-cursor:after{max-width:135px}}@media(prefers-reduced-motion:reduce){.muster-spa-cursor{transition:none}}";
        window.document.head.appendChild(style);
      }
      window.document.querySelector(".muster-spa-takeover")?.remove();
      window.document.querySelector(".muster-spa-cursor")?.remove();
      const banner = window.document.createElement("div");
      banner.className = "muster-spa-takeover";
      banner.dataset.runtimeRevision = "20260720-24";
      banner.dataset.state = "working";
      banner.textContent = "Muster has taken over · Opening the reviewed form";
      const cursor = window.document.createElement("div");
      cursor.className = "muster-spa-cursor";
      cursor.dataset.label = "Muster has taken over";
      window.document.body.append(banner, cursor);
      const viewportPoint = (rect) => {
        const width = Math.max(240, Number(window.innerWidth) || window.document.documentElement?.clientWidth || 1024);
        const height = Math.max(320, Number(window.innerHeight) || window.document.documentElement?.clientHeight || 768);
        return Object.freeze({
          x: Math.max(8, Math.min(width - Math.min(190, width - 16), rect.left + Math.min(rect.width / 2, 24))),
          y: Math.max(56, Math.min(height - 44, rect.top + Math.min(rect.height / 2, 18))),
        });
      };
      return Object.freeze({
        async point(element, message) {
          const rect = element.getBoundingClientRect();
          const point = viewportPoint(rect);
          banner.textContent = `Muster has taken over · ${message}`;
          cursor.dataset.label = "Muster has taken over";
          cursor.style.transform = `translate(${Math.round(point.x)}px,${Math.round(point.y)}px)`;
          await sleep(480);
        },
        pause(commitLabel) {
          banner.dataset.state = "paused";
          banner.textContent = `Muster paused · Review the form before ${commitLabel}`;
          cursor.dataset.label = "Muster paused for you";
          cursor.setAttribute("aria-label", `Muster paused before ${commitLabel}`);
        },
        complete(operation, recordName) {
          banner.dataset.state = "paused";
          const verb = operation === "delete" ? "Deleted" : (operation === "update" ? "Updated" : "Created");
          banner.textContent = `Muster verified · ${verb} ${recordName}`;
          cursor.style.display = "none";
        },
        stop(mayHaveSaved = false, operation = "create") {
          banner.dataset.state = "stopped";
          const uncertainAction = operation === "delete" ? "Deletion" : (operation === "update" ? "Update" : "Creation");
          banner.textContent = mayHaveSaved
            ? `Muster stopped · ${uncertainAction} may have completed; review the audit record`
            : "Muster stopped · Nothing was saved";
          cursor.style.display = "none";
        },
      });
    };
    const route = (receipt) => {
      const row = definition.routes?.[receipt.doctype];
      if (!row) throw new MusterSurfaceUnavailableError();
      const relative = ["update", "delete"].includes(receipt.operation)
        ? row.record?.replace("{name}", encodeURIComponent(receipt.record_name))
        : row.create;
      if (!relative || !/^\/(?:[A-Za-z0-9._~{}%-]+\/?)*$/.test(relative)) throw new MusterSurfaceUnavailableError();
      return Object.freeze({
        target: `${definition.base}${relative}`.replace(/\/{2,}/g, "/"),
        createButtons: receipt.operation === "create" && Array.isArray(row.createButtons) ? row.createButtons : [],
        commitButtons: Array.isArray(row.commitButtons?.[receipt.operation]) ? row.commitButtons[receipt.operation] : [],
      });
    };
    const visible = (element) => {
      const rect = element?.getBoundingClientRect?.();
      const style = window.getComputedStyle?.(element);
      return Boolean(element && element.isConnected !== false && !element.disabled && rect?.width > 0 && rect?.height > 0
        && style?.display !== "none" && style?.visibility !== "hidden");
    };
    const waitFor = async (predicate, timeout = 10_000) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started >= timeout) throw new MusterSurfaceUnavailableError();
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      return predicate();
    };
    const bindingFor = (field, row) => row?.fieldBindings?.[field.fieldname] || null;
    const semanticMatches = (field, row, control) => {
        if (!visible(control)) return false;
        const keys = [control.name, control.id, control.dataset?.fieldname, control.getAttribute?.("aria-label")].filter(Boolean);
        if (keys.includes(field.fieldname)) return true;
        const binding = bindingFor(field, row);
        const hints = [field.label, ...(row?.fieldHints?.[field.fieldname] || []), ...(binding?.labels || [])]
          .map((value) => value.trim().toLowerCase());
        const semanticValues = [control.placeholder, control.getAttribute?.("data-placeholder"),
          control.getAttribute?.("aria-label"), control.getAttribute?.("data-fieldname")]
          .filter(Boolean).map((value) => String(value).trim().toLowerCase());
        if (semanticValues.some((value) => hints.includes(value))) return true;
        const labelledBy = control.getAttribute?.("aria-labelledby");
        if (labelledBy && hints.includes(window.document.getElementById?.(labelledBy)?.textContent?.trim().toLowerCase())) return true;
        const explicitLabel = control.id && [...window.document.querySelectorAll?.("label") || []]
          .find((label) => label.htmlFor === control.id);
        if (explicitLabel && hints.includes(explicitLabel.textContent?.trim().toLowerCase())) return true;
        const container = control.closest?.("label, [data-fieldname], .form-control, .field, .control");
        const containerText = container?.textContent?.trim().toLowerCase();
        return hints.some((hint) => containerText?.startsWith(hint));
    };
    const semanticAncestorDepth = (field, row, control) => {
        const binding = bindingFor(field, row);
        const hints = [field.label, ...(row?.fieldHints?.[field.fieldname] || []), ...(binding?.labels || [])]
          .map((value) => value.trim().toLowerCase());
        let ancestor = control.parentElement;
        for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
          const text = ancestor.textContent?.trim().toLowerCase();
          if (hints.some((hint) => text?.startsWith(hint))) return depth;
        }
        return Number.POSITIVE_INFINITY;
    };
    const uniqueVisible = (selector, predicate, root = window.document) => {
      const matches = [...root.querySelectorAll(selector)].filter((element) => visible(element) && predicate(element));
      return matches.length === 1 ? matches[0] : null;
    };
    const controlFor = (field, row, root) => {
      const binding = bindingFor(field, row);
      const selector = binding?.kind === "button_select"
        ? "button, [role='button'], [role='combobox']"
        : binding?.kind === "contenteditable"
          ? "[contenteditable='true']"
        : "input, textarea, select, [contenteditable='true'], [role='combobox']";
      const direct = uniqueVisible(selector, (control) => semanticMatches(field, row, control), root);
      if (direct) return direct;
      if (binding?.kind === "contenteditable" && binding.unique === true) {
        return uniqueVisible("[contenteditable='true']", () => true, root);
      }
      // Vue controls can expose the label only in an adjacent wrapper. Pick
      // the unique closest semantic wrapper; a sibling that shares a wider
      // row can never beat the control inside its own labelled field wrapper.
      const ranked = [...root.querySelectorAll(selector)].filter(visible)
        .map((control) => ({control, depth: semanticAncestorDepth(field, row, control)}))
        .filter((candidate) => Number.isFinite(candidate.depth))
        .sort((left, right) => left.depth - right.depth);
      return ranked.length && (ranked.length === 1 || ranked[0].depth < ranked[1].depth)
        ? ranked[0].control : null;
    };
    const setControlValue = (control, value) => {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value");
      if (descriptor?.set) descriptor.set.call(control, value);
      else control.value = value;
    };
    const controlValue = (control) => {
      const formControl = /^(?:INPUT|SELECT|TEXTAREA)$/.test(control?.tagName || "");
      return String(formControl
        ? control?.value ?? ""
        : control?.getAttribute?.("data-value") || control?.textContent || "").trim();
    };
    const sameFields = (left, right) => JSON.stringify((left || []).map((field) => ({
      fieldname: field.fieldname, label: field.label, control: field.control, value: String(field.value),
    }))) === JSON.stringify((right || []).map((field) => ({
      fieldname: field.fieldname, label: field.label, control: field.control, value: String(field.value),
    })));
    const createdRecordName = (row, pathname) => {
      if (typeof row?.record !== "string" || row.record.split("{name}").length !== 2) return null;
      const [before, after] = row.record.split("{name}");
      const prefix = `${definition.base}${before}`.replace(/\/{2,}/g, "/");
      if (!pathname.startsWith(prefix) || (after && !pathname.endsWith(after))) return null;
      const encoded = pathname.slice(prefix.length, after ? -after.length : undefined);
      if (!encoded || encoded.includes("/")) return null;
      try {
        const decoded = decodeURIComponent(encoded);
        return decoded.toLowerCase() === "new" || decoded.toLowerCase().startsWith("new-") ? null : decoded;
      } catch (_error) { return null; }
    };
    const fill = async (control, field, guide, row) => {
      const binding = bindingFor(field, row);
      if (binding?.kind === "button_select") {
        if (!binding.options.includes(field.value)) throw new MusterSurfaceUnavailableError();
        if (controlValue(control) === field.value) {
          await guide.point(control, `Keeping ${field.label} as ${field.value}`);
          return;
        }
        await guide.point(control, `Opening ${field.label}`);
        control.click();
        const option = await waitFor(() => uniqueVisible("[role='option']", (candidate) =>
          candidate.textContent?.trim() === field.value));
        await guide.point(option, `Selecting ${field.value}`);
        option.click();
        await waitFor(() => controlValue(control) === field.value, 2_000);
        return;
      }
      if (!control || (control.getAttribute?.("role") === "combobox" && !/^(?:INPUT|SELECT)$/.test(control.tagName))) throw new MusterSurfaceUnavailableError();
      await guide.point(control, `Filling ${field.label}`);
      control.focus?.();
      if (binding?.kind === "contenteditable") {
        const selection = window.getSelection?.();
        const range = window.document.createRange?.();
        if (!selection || !range || typeof window.document.execCommand !== "function") throw new MusterSurfaceUnavailableError();
        range.selectNodeContents(control);
        selection.removeAllRanges();
        selection.addRange(range);
        window.document.execCommand("delete", false);
        const steps = Math.min(12, Math.max(1, Math.ceil(field.value.length / 16)));
        for (let index = 0; index < steps; index += 1) {
          const start = Math.floor(field.value.length * index / steps);
          const end = Math.floor(field.value.length * (index + 1) / steps);
          window.document.execCommand("insertText", false, field.value.slice(start, end));
          await sleep(45);
        }
      } else if (control.tagName === "SELECT") {
        setControlValue(control, field.value);
      } else {
        const steps = Math.min(12, Math.max(1, Math.ceil(field.value.length / 4)));
        for (let index = 1; index <= steps; index += 1) {
          setControlValue(control, field.value.slice(0, Math.ceil(field.value.length * index / steps)));
          control.dispatchEvent(new Event("input", {bubbles: true}));
          await sleep(45);
        }
      }
      control.dispatchEvent(new Event("input", {bubbles: true}));
      control.dispatchEvent(new Event("change", {bubbles: true}));
      if (controlValue(control) !== field.value) throw new MusterSurfaceUnavailableError();
    };
    return async (receipt) => {
      const guide = takeover();
      try {
        const navigation = route(receipt);
        const existingDialogs = receipt.operation === "create"
          ? [...window.document.querySelectorAll("[role='dialog']")].filter(visible)
          : [];
        const existingFormRoot = existingDialogs.length === 1 ? existingDialogs[0] : null;
        let createControl = receipt.operation === "create" && navigation.createButtons.length
          ? uniqueVisible("button", (button) => navigation.createButtons.includes(button.textContent?.trim()))
          : null;
        if (!createControl && String(window.location.pathname) !== navigation.target) {
          window.history?.pushState?.({}, "", navigation.target);
          window.dispatchEvent?.(new PopStateEvent("popstate"));
          await sleep(500);
        }
        await waitFor(() => definition.rootMarkers.some((marker) => window.document.querySelector(marker)));
        if (navigation.createButtons.length && !existingFormRoot) {
          createControl ||= await waitFor(() => uniqueVisible("button", (button) =>
            navigation.createButtons.includes(button.textContent?.trim())));
          await guide.point(createControl, "Opening a new record");
          createControl.click();
          await sleep(550);
        }
        const dialogs = [...window.document.querySelectorAll("[role='dialog']")].filter(visible);
        const formRoot = existingFormRoot?.isConnected && visible(existingFormRoot)
          ? existingFormRoot : (dialogs.length === 1 ? dialogs[0] : window.document);
        const stagedControls = new Map();
        for (const field of receipt.fields) {
          const control = await waitFor(() => controlFor(field, definition.routes?.[receipt.doctype], formRoot));
          if (existingFormRoot) {
            if (controlValue(control) !== field.value) throw new MusterSurfaceUnavailableError();
          } else {
            await fill(control, field, guide, definition.routes?.[receipt.doctype]);
          }
          stagedControls.set(field.fieldname, control);
        }
        if (!navigation.commitButtons.length) throw new MusterSurfaceUnavailableError();
        const commit = await waitFor(() => uniqueVisible("button, [role='button']", (button) =>
          navigation.commitButtons.includes(button.textContent?.trim()), formRoot));
        const commitLabel = commit.textContent.trim();
        await guide.point(commit, `Pausing before ${commitLabel}`);
        guide.pause(commitLabel);
        if (receipt.operation === "delete") {
          if (!receipt.delete_authorized) {
            return {opened: true, saved: false, confirmationLabel: `Confirm ${commitLabel}`};
          }
          let deleteInFlight = false;
          let deleteUsed = false;
          return {
            opened: true,
            saved: false,
            confirmationLabel: `Confirm ${commitLabel}`,
            async confirmDelete(typedRecordName) {
              if (deleteInFlight || deleteUsed || typedRecordName !== receipt.record_name) throw new MusterSurfaceUnavailableError();
              deleteInFlight = true;
              deleteUsed = true;
              let clicked = false;
              try {
                if (String(window.location.pathname) !== navigation.target || formRoot.isConnected === false) throw new MusterSurfaceUnavailableError();
                const recheck = await governedMethod("muster.api.mission.recheck_attended_delete", {
                  proposal: receipt.proposal, record_name: receipt.record_name,
                  record_revision: receipt.record_revision, approval_proof: receipt.approval_proof, confirmed: "1",
                });
                if (recheck?.current !== true || recheck?.executed !== false || recheck?.proposal !== receipt.proposal
                  || recheck?.doctype !== receipt.doctype || recheck?.record_name !== receipt.record_name
                  || recheck?.record_revision !== receipt.record_revision || recheck?.approval_proof !== receipt.approval_proof) {
                  throw new MusterSurfaceUnavailableError();
                }
                const currentCommit = uniqueVisible("button, [role='button']", (button) =>
                  navigation.commitButtons.includes(button.textContent?.trim()), formRoot);
                if (!currentCommit || currentCommit !== commit) throw new MusterSurfaceUnavailableError();
                const grant = await governedMethod("muster.api.mission.issue_attended_delete", {
                  proposal: receipt.proposal, typed_record_name: typedRecordName, confirmed: "1",
                });
                if (grant?.issued !== true || grant?.executed !== false || grant?.proposal !== receipt.proposal
                  || grant?.doctype !== receipt.doctype || grant?.record_name !== receipt.record_name
                  || typeof grant?.authorization !== "string" || typeof grant?.authorization_token !== "string") {
                  throw new MusterSurfaceUnavailableError();
                }
                const existingDialogs = new Set([...window.document.querySelectorAll("[role='dialog']")].filter(visible));
                await guide.point(commit, "Opening native Delete confirmation");
                commit.click();
                const dialog = await waitFor(() => uniqueVisible("[role='dialog']", (candidate) =>
                  !existingDialogs.has(candidate) && String(candidate.textContent || "").includes(receipt.record_name)));
                const confirmButton = await waitFor(() => uniqueVisible("button, [role='button']", (button) =>
                  ["Delete", "Yes"].includes(button.textContent?.trim()), dialog));
                await guide.point(confirmButton, "Confirming the reviewed deletion");
                const consumption = await governedMethod("muster.api.mission.consume_attended_delete", {
                  authorization: grant.authorization, authorization_token: grant.authorization_token, confirmed: "1",
                });
                if (consumption?.consumed !== true || consumption?.executed !== false
                  || consumption?.authorization !== grant.authorization || consumption?.record_name !== receipt.record_name
                  || typeof consumption?.verification_token !== "string") throw new MusterSurfaceUnavailableError();
                confirmButton.click();
                clicked = true;
                await waitFor(() => String(window.location.pathname) !== navigation.target && !visible(dialog), 15_000);
                const verified = await governedMethod("muster.api.mission.verify_attended_delete_result", {
                  authorization: grant.authorization, verification_token: consumption.verification_token, confirmed: "1",
                });
                if (verified?.verified !== true || verified?.executed !== true || verified?.proposal !== receipt.proposal
                  || verified?.doctype !== receipt.doctype || verified?.record_name !== receipt.record_name
                  || typeof verified?.receipt_hash !== "string" || !/^[a-f0-9]{64}$/.test(verified.receipt_hash)) {
                  throw new MusterSurfaceUnavailableError();
                }
                guide.complete("delete", receipt.record_name);
                return Object.freeze({
                  operation: "delete", deleted: true, verified: true,
                  recordName: receipt.record_name, proofHash: verified.receipt_hash,
                });
              } catch (_error) {
                guide.stop(clicked, "delete");
                throw new MusterSurfaceUnavailableError();
              } finally {
                deleteInFlight = false;
              }
            },
          };
        }
        if (!["create", "update"].includes(receipt.operation) || !receipt.save_authorized) {
          return {opened: true, saved: false, confirmationLabel: `Confirm ${commitLabel}`};
        }
        let confirmationInFlight = false;
        let confirmationUsed = false;
        return {
          opened: true,
          saved: false,
          confirmationLabel: `Confirm ${commitLabel}`,
          async confirm() {
            if (confirmationInFlight || confirmationUsed) throw new MusterSurfaceUnavailableError();
            confirmationInFlight = true;
            confirmationUsed = true;
            let clicked = false;
            try {
              if (String(window.location.pathname) !== navigation.target || formRoot.isConnected === false) throw new MusterSurfaceUnavailableError();
              for (const field of receipt.fields) {
                const control = stagedControls.get(field.fieldname);
                if (!control || !visible(control) || controlValue(control) !== field.value) throw new MusterSurfaceUnavailableError();
              }
              const currentCommit = uniqueVisible("button, [role='button']", (button) =>
                navigation.commitButtons.includes(button.textContent?.trim()), formRoot);
              if (!currentCommit || currentCommit !== commit) throw new MusterSurfaceUnavailableError();
              const preflight = await governedMethod("muster.api.mission.preflight_attended_save", {
                proposal: receipt.proposal, confirmed: "1",
                record_name: receipt.operation === "update" ? receipt.record_name : "",
                record_revision: receipt.operation === "update" ? receipt.record_revision : "",
              });
              if (!preflight || preflight.current !== true || preflight.executed !== false
                || preflight.proposal !== receipt.proposal || preflight.operation !== receipt.operation
                || preflight.doctype !== receipt.doctype
                || (receipt.operation === "create" && preflight.record_name !== null)
                || (receipt.operation === "update" && (preflight.record_name !== receipt.record_name
                  || preflight.record_revision !== receipt.record_revision))
                || !sameFields(preflight.fields, receipt.fields)) throw new MusterSurfaceUnavailableError();
              if (String(window.location.pathname) !== navigation.target || formRoot.isConnected === false
                || uniqueVisible("button, [role='button']", (button) =>
                  navigation.commitButtons.includes(button.textContent?.trim()), formRoot) !== commit) {
                throw new MusterSurfaceUnavailableError();
              }
              for (const field of receipt.fields) {
                if (controlValue(stagedControls.get(field.fieldname)) !== field.value) throw new MusterSurfaceUnavailableError();
              }
              await guide.point(commit, `Confirming native ${commitLabel}`);
              commit.click();
              clicked = true;
              const row = definition.routes?.[receipt.doctype];
              const recordName = receipt.operation === "create"
                ? await waitFor(() => createdRecordName(row, String(window.location.pathname)), 15_000)
                : receipt.record_name;
              if (receipt.operation === "update") {
                await sleep(0);
                await waitFor(() => visible(commit), 15_000);
              }
              // Frappe commits the native resource transaction as the request
              // finishes. A fast SPA can expose the record route before another
              // request can read that committed row, so give the commit boundary
              // one short settle interval before starting proof reads.
              await sleep(750);
              // The resource read is a useful visibility barrier, but some SPA
              // deployments deny that generic endpoint while the governed
              // verifier is still allowed. Never turn a successful native Save
              // into a false failure solely because the generic read surface is
              // unavailable. The verifier below rereads the record with the
              // requester's Frappe permissions and checks every reviewed value.
              try { await waitForSavedRecord(receipt.doctype, recordName); } catch (_barrierError) { /* verified below */ }
              let verified = null;
              const verificationStarted = Date.now();
              while (!verified && Date.now() - verificationStarted < 5_000) {
                try {
                  const candidate = await governedMethod("muster.api.mission.verify_attended_save", {
                    proposal: receipt.proposal, record_name: recordName, confirmed: "1",
                  });
                  if (candidate?.verified === true && candidate?.proposal === receipt.proposal
                    && candidate?.doctype === receipt.doctype && candidate?.record_name === recordName
                    && typeof candidate?.proof_hash === "string" && /^[a-f0-9]{64}$/.test(candidate.proof_hash)) {
                    verified = candidate;
                    break;
                  }
                } catch (_verificationError) { /* bounded retry */ }
                await sleep(150);
              }
              if (!verified || verified.verified !== true || verified.proposal !== receipt.proposal
                || verified.doctype !== receipt.doctype || verified.record_name !== recordName
                || typeof verified.proof_hash !== "string" || !/^[a-f0-9]{64}$/.test(verified.proof_hash)) {
                throw new MusterSurfaceUnavailableError();
              }
              guide.complete(receipt.operation, recordName);
              return Object.freeze({
                operation: receipt.operation,
                created: receipt.operation === "create",
                updated: receipt.operation === "update",
                verified: true,
                recordName,
                proofHash: verified.proof_hash,
                serverAdjustedFields: Array.isArray(verified.server_adjusted_fields)
                  ? Object.freeze([...verified.server_adjusted_fields]) : Object.freeze([]),
              });
            } catch (_error) {
              guide.stop(clicked, receipt.operation);
              throw new MusterSurfaceUnavailableError();
            } finally {
              confirmationInFlight = false;
            }
          },
        };
      } catch (error) {
        guide.stop();
        throw error;
      }
    };
  }

  function registerKnown(definition) {
    if (!definition || typeof definition !== "object" || !ID.test(definition.id)
      || !arrayOf(definition.rootMarkers, (value) => typeof value === "string" && value.length <= 120, 8)
      || typeof definition.base !== "string" || !definition.base.startsWith("/")
      || !definition.routes || typeof definition.routes !== "object"
      || Object.values(definition.routes).some((row) => {
        if (!row || typeof row !== "object") return true;
        if (!row.commitButtons || typeof row.commitButtons !== "object" || Array.isArray(row.commitButtons)
          || definition.operations.some((operation) => !arrayOf(row.commitButtons[operation],
            (value) => value.trim().length > 0 && value.length <= 80, 8))) return true;
        if (row.fieldHints !== undefined && (typeof row.fieldHints !== "object" || Array.isArray(row.fieldHints))) return true;
        if (Object.entries(row.fieldHints || {}).some(([fieldname, hints]) =>
          !/^[A-Za-z][A-Za-z0-9_]{0,139}$/.test(fieldname)
          || !arrayOf(hints, (value) => value.trim().length > 0 && value.length <= 140, 8))) return true;
        if (row.fieldBindings !== undefined && (typeof row.fieldBindings !== "object" || Array.isArray(row.fieldBindings))) return true;
        return Object.entries(row.fieldBindings || {}).some(([fieldname, binding]) =>
          !/^[A-Za-z][A-Za-z0-9_]{0,139}$/.test(fieldname)
          || !binding || typeof binding !== "object"
          || !["text", "contenteditable", "button_select"].includes(binding.kind)
          || Object.keys(binding).some((key) => !["kind", "labels", "options", "unique"].includes(key))
          || !arrayOf(binding.labels, (value) => value.trim().length > 0 && value.length <= 140, 8)
          || (binding.kind === "contenteditable" && binding.unique !== true)
          || (binding.kind !== "contenteditable" && binding.unique !== undefined)
          || (binding.kind === "button_select"
            && !arrayOf(binding.options, (value) => value.trim().length > 0 && value.length <= 140, 40)));
      })) throw new MusterSurfaceUnavailableError();
    return register({...definition, start: semanticAdapter(definition)});
  }

  function candidates(receipt) {
    const context = surfaceContext();
    return [...records.values()].filter((adapter) =>
      adapter.pathPrefixes.some((prefix) => context.pathname === prefix.slice(0, -1) || context.pathname.startsWith(prefix))
      && (adapter.doctypes.includes("*") || adapter.doctypes.includes(receipt.doctype))
      && adapter.operations.includes(receipt.operation))
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  }

  async function startVerified(verifiedReceipt) {
    await loadKnownSurface();
    discover();
    const adapter = candidates(verifiedReceipt)[0];
    if (!adapter) throw new MusterSurfaceUnavailableError();
    try {
      const outcome = await adapter.start(verifiedReceipt, surfaceContext());
      const confirmationLabel = typeof outcome?.confirmationLabel === "string"
        && /^Confirm (?:Create|Submit|Save|Delete)$/.test(outcome.confirmationLabel)
        ? outcome.confirmationLabel : null;
      return Object.freeze({
        adapter: adapter.id, opened: true, saved: false,
        ...(confirmationLabel ? {confirmationLabel} : {}),
        ...(typeof outcome?.confirm === "function" && confirmationLabel ? {confirm: outcome.confirm} : {}),
        ...(typeof outcome?.confirmDelete === "function" && confirmationLabel === "Confirm Delete"
          ? {confirmDelete: outcome.confirmDelete} : {}),
      });
    } catch (_error) {
      throw new MusterSurfaceUnavailableError();
    }
  }

  async function start(receipt) {
    const verifiedReceipt = normalizedReceipt(receipt);
    let navigation;
    try {
      navigation = await governedMethod("muster.api.attended_resume.issue", {
        proposal: verifiedReceipt.proposal, confirmed: "1",
      });
    } catch (_error) {
      throw new MusterSurfaceUnavailableError();
    }
    if (!navigation || navigation.schema_version !== 1 || navigation.proposal !== verifiedReceipt.proposal
      || typeof navigation.navigate_required !== "boolean") throw new MusterSurfaceUnavailableError();
    if (navigation.navigate_required) {
      if (typeof navigation.url !== "string" || !/^\/(?:[A-Za-z0-9._~%-]+\/?)*#muster-attended-resume=[A-Za-z0-9_-]{48,512}$/.test(navigation.url)
        || typeof navigation.target_route !== "string" || !navigation.url.startsWith(`${navigation.target_route}#`)) {
        throw new MusterSurfaceUnavailableError();
      }
      window.location.assign(navigation.url);
      return Object.freeze({adapter: "cross-surface-resume", opened: false, saved: false, navigated: true});
    }
    return startVerified(verifiedReceipt);
  }

  async function resumeFromLocation() {
    const match = RESUME_HASH.exec(String(window.location?.hash || ""));
    if (!match) return false;
    const ticket = match[1];
    try {
      window.history?.replaceState?.(null, "", `${window.location.pathname}${window.location.search || ""}`);
      const receipt = await governedMethod("muster.api.attended_resume.consume", {ticket, confirmed: "1"});
      await startVerified(normalizedReceipt(receipt));
      return true;
    } catch (_error) {
      throw new MusterSurfaceUnavailableError();
    }
  }

  function capabilities() {
    return [...records.values()].map((adapter) => Object.freeze({
      id: adapter.id,
      label: adapter.label,
      pathPrefixes: adapter.pathPrefixes,
      doctypes: adapter.doctypes,
      operations: adapter.operations,
      capabilities: adapter.capabilities,
    }));
  }

  const api = Object.freeze({
    schemaVersion: CONTRACT_VERSION,
    register,
    registerKnown,
    registerSupported,
    loadKnownSurface,
    discover,
    capabilities,
    context: surfaceContext,
    start,
    resumeFromLocation,
    MusterSurfaceUnavailableError,
  });
  window.musterSurfaceAdapters = api;

  // Existing ERPNext/HRMS/Frappe forms use the audited Desk controller. This
  // adapter is path-bound and therefore cannot claim CRM/Helpdesk/custom SPAs.
  window.musterSurfaceAdapters.register({
    schemaVersion: CONTRACT_VERSION,
    id: "frappe-desk",
    label: "Frappe Desk",
    priority: 100,
    pathPrefixes: ["/app/", "/desk/"],
    doctypes: ["*"],
    operations: ["create", "update", "delete"],
    capabilities: {navigate: true, fill: true, pauseBeforeSave: true, save: "separate_confirmation", destructiveReview: "typed_confirmation_native_one_time"},
    async start(receipt) {
      if (!window.musterAttendedPreview?.start) throw new MusterSurfaceUnavailableError();
      if (receipt.operation === "delete") await window.musterAttendedPreview.startDelete(receipt);
      else await window.musterAttendedPreview.start(receipt);
    },
  });
  void resumeFromLocation().catch(() => undefined);
})();
