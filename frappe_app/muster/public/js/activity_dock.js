(() => {
  const model = {
    scope(route, routeString) {
      const scope = {source: "desk-dock", scope_mode: "context", route: routeString || "/app"};
      if (Array.isArray(route) && typeof route[1] === "string" && route[1].trim()) {
        if (route[0] === "List") {
          Object.assign(scope, {page_type: "List", page_name: route[1], doctype: route[1]});
        } else if (route[0] === "Form") {
          Object.assign(scope, {page_type: "Form", page_name: route[1], doctype: route[1]});
          if (typeof route[2] === "string" && route[2].trim()) scope.docname = route[2];
        } else {
          Object.assign(scope, {page_type: String(route[0] || "Page"), page_name: route[1]});
        }
      }
      return scope;
    },
    terminal(status) { return status === "completed" || status === "failed"; },
    refreshBackoff(failures) {
      const count = Math.max(0, Math.min(5, Number(failures) || 0));
      return count ? Math.min(60000, 2000 * (2 ** (count - 1))) : 0;
    },
    clarification(value, expected = {}) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const valid = typeof value.turn_id === "string" && value.turn_id.length > 0 && value.turn_id.length <= 140
        && typeof value.handoff_id === "string" && value.handoff_id.length <= 140
        && typeof value.token === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value.token)
        && typeof value.conversation_id === "string" && value.conversation_id === expected.conversationId
        && typeof value.prompt_hash === "string" && /^[a-f0-9]{64}$/.test(value.prompt_hash)
        && value.bound_scope && typeof value.bound_scope === "object" && !Array.isArray(value.bound_scope)
        && (!expected.turnId || value.turn_id === expected.turnId)
        && (expected.handoffId === undefined || value.handoff_id === expected.handoffId);
      return valid ? {
        turnId: value.turn_id, handoffId: value.handoff_id, token: value.token,
        promptHash: value.prompt_hash, boundScope: value.bound_scope,
      } : null;
    },
    submitMethod(intent) {
      return intent === "workflow" ? "muster.api.mission.plan" : "muster.api.ask.submit";
    },
    continuationScope(scope, doctype) {
      if (!doctype || typeof doctype !== "string" || doctype.length > 140 || scope.doctype) return scope;
      return {...scope, doctype, page_type: "Form", page_name: doctype};
    },
    richText(value) {
      const escaped = frappe.utils.escape_html(String(value || ""));
      const inline = (line) => line
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      const rows = escaped.split(/\r?\n/);
      const html = [];
      let list = "";
      const closeList = () => {
        if (!list) return;
        html.push(`</${list}>`);
        list = "";
      };
      for (const row of rows) {
        const heading = /^(#{1,3})\s+(.+)$/.exec(row);
        const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(row);
        const bullet = /^\s*[-*]\s+(.+)$/.exec(row);
        if (heading) {
          closeList();
          const level = Math.min(4, heading[1].length + 2);
          html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        } else if (ordered || bullet) {
          const nextList = ordered ? "ol" : "ul";
          if (list !== nextList) {
            closeList();
            list = nextList;
            const start = ordered ? Number(/^\s*(\d+)/.exec(row)?.[1] || 1) : 1;
            html.push(list === "ol" && start > 1 ? `<ol start="${start}">` : `<${list}>`);
          }
          html.push(`<li>${inline((ordered || bullet)[1])}</li>`);
        } else if (!row.trim()) {
          closeList();
        } else {
          closeList();
          html.push(`<p>${inline(row)}</p>`);
        }
      }
      closeList();
      return html.join("");
    },
    catalog(value) {
      if (!value || value.schema_version !== 1 || !Array.isArray(value.items)) return [];
      const kinds = new Set(["command", "agent", "workflow", "skill", "mcp"]);
      return value.items.filter((item) => item && kinds.has(item.kind)
        && typeof item.id === "string" && item.id.length <= 120
        && typeof item.label === "string" && item.label.length <= 240
        && typeof item.description === "string" && item.description.length <= 240
        && typeof item.token === "string" && item.token.length <= 180
        && (item.kind === "command" ? /^\/[a-z][a-z0-9_-]*$/.test(item.token)
          : item.kind === "workflow" ? /^@workflow\[[^\]\r\n]{1,155}\]$/.test(item.token)
            : new RegExp(`^@${item.kind}:[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$`).test(item.token)));
    },
    filterCatalog(items, trigger, query) {
      const allowed = trigger === "/" ? new Set(["command"]) : new Set(["agent", "workflow", "skill", "mcp"]);
      const needle = String(query || "").trim().toLowerCase();
      const rank = {agent: 0, workflow: 1, mcp: 2, skill: 3, command: 0};
      return items.filter((item) => allowed.has(item.kind) && (!needle
        || `${item.label} ${item.id} ${item.description}`.toLowerCase().includes(needle)))
        .map((item, index) => ({item, index}))
        .sort((left, right) => (rank[left.item.kind] ?? 9) - (rank[right.item.kind] ?? 9) || left.index - right.index)
        .slice(0, 12).map(({item}) => item);
    },
    presentableCalls(value) {
      if (!Array.isArray(value)) return [];
      const statuses = new Set(["queued", "running", "completed", "failed", "denied"]);
      const internal = /\b(?:provider|model|backend|stack|trace|sha-?256|checksum|token|secret|runtime id|request id)\b|(?:\/home|\/srv|\/tmp|localhost|127\.0\.0\.1)|\b[a-f0-9]{40,}\b/i;
      return value.filter((call) => call && ["tool", "mcp"].includes(call.kind)
        && statuses.has(call.status) && typeof call.label === "string"
        && call.label.length <= 160 && typeof call.summary === "string"
        && call.summary.length <= 500).slice(0, 24).map((call) => {
          const label = internal.test(call.label) ? __("Muster step") : call.label;
          let summary = call.summary;
          if (call.status === "failed") summary = __("This step could not be completed. Nothing was changed.");
          else if (call.status === "denied") summary = __("This step is not permitted for your current access. Nothing was changed.");
          else if (internal.test(summary)) summary = __("This permitted step was checked.");
          const details = Object.fromEntries(["purpose", "scope", "outcome"].flatMap((key) => {
            const detail = call.details?.[key];
            return typeof detail === "string" && detail.trim() && !internal.test(detail)
              ? [[key, detail.slice(0, 500)]] : [];
          }));
          return {...call, label, summary, details: Object.keys(details).length ? details : undefined};
        });
    },
    applySelection(value, selectionStart, selectionEnd, trigger, token) {
      const before = value.slice(0, selectionStart);
      const after = value.slice(selectionEnd);
      if (trigger === "/") {
        const partial = /^\/[^\s]*/.exec(value);
        const rest = partial ? value.slice(partial[0].length).trimStart() : value.trim();
        const next = `${token}${rest ? ` ${rest}` : " "}`;
        return {value: next, caret: token.length + 1};
      }
      const match = /(?:^|\s)@[^\s]*$/.exec(before);
      const replaceAt = match ? before.length - match[0].trimStart().length : selectionStart;
      const separator = replaceAt && !/\s$/.test(before.slice(0, replaceAt)) ? " " : "";
      const next = `${before.slice(0, replaceAt)}${separator}${token} ${after}`;
      return {value: next, caret: before.slice(0, replaceAt).length + separator.length + token.length + 1};
    },
    async startAttendedHandoff(kind, proposal, prepare, start) {
      if (kind !== "attended_browser") return false;
      const receipt = await prepare(proposal);
      const outcome = await start(receipt);
      if (outcome?.navigated === true) return "navigated";
      return true;
    },
  };
  window.MusterAskDockModel = model;

  function boot() {
    if (!frappe.boot?.muster?.available || document.querySelector(".muster-dock")) return;
    const dock = document.createElement("aside");
    dock.className = "muster-dock is-collapsed";
    dock.setAttribute("aria-label", __("Muster assistant"));
    const connected = Boolean(frappe.boot.muster.execution_enabled);
    const canAdminister = Boolean(frappe.boot.muster.can_administer);
    dock.innerHTML = `<button class="muster-dock-toggle" aria-expanded="false"><img src="/assets/muster/images/muster-mark.png" alt=""/><span>${__("Ask Muster")}</span><b class="muster-dock-count">0</b></button><div class="muster-dock-body">
      <section class="muster-dock-compose" aria-label="${__("Ask Muster")}">
        <div class="muster-dock-compose-head"><strong>${__("Ask anything about your work")}</strong><span class="muster-dock-head-actions"><span class="muster-runtime-state" data-connected="${connected}">${connected ? __("Connected") : __("Setup required")}</span><button class="muster-dock-expand" type="button" aria-pressed="false" title="${__("Expand learning view")}">↗</button></span></div>
        <div class="muster-intent-switch" role="group" aria-label="${__("Request type")}">
          <button class="btn btn-xs is-active" type="button" data-muster-intent="ask" aria-pressed="true">${__("Ask")}</button>
          <button class="btn btn-xs" type="button" data-muster-intent="workflow" aria-pressed="false">${__("Build workflow")}</button>
        </div>
        <div class="muster-chat-log" aria-live="polite"></div>
        <textarea class="form-control muster-dock-prompt" rows="2" aria-controls="muster-command-palette" placeholder="${__("Ask a question or describe what you want to learn…")}"></textarea>
        <div class="muster-command-bar"><button type="button" data-muster-palette="/" aria-haspopup="listbox" aria-expanded="false" aria-label="${__("Browse commands")}"><b>/</b> ${__("Commands")}</button><button type="button" data-muster-palette="@" aria-haspopup="listbox" aria-expanded="false" aria-label="${__("Mention an agent, workflow, skill, or MCP server")}"><b>@</b> ${__("Agents & tools")}</button><span>${__("Ctrl/⌘ + Enter to send")}</span></div>
        <div class="muster-command-palette" id="muster-command-palette" role="listbox" aria-label="${__("Muster commands and mentions")}" hidden></div>
        <div class="muster-dock-compose-actions"><small class="muster-trust-note" title="${__("Answers and guided actions always use your live Frappe permissions.")}">◈ ${__("Live permissions")}</small><button class="btn btn-primary btn-sm muster-dock-submit" type="button">${__("Ask Muster")} <span aria-hidden="true">→</span></button></div>
      </section>
      <header><strong>${__("Active work")}</strong><a href="/desk/muster-control">${__("Open control")}</a></header><div class="muster-dock-list"></div></div>`;
    document.body.appendChild(dock);
    const prompt = dock.querySelector(".muster-dock-prompt");
    const submit = dock.querySelector(".muster-dock-submit");
    const chat = dock.querySelector(".muster-chat-log");
    let intent = "ask";
    let conversationId = conversationKey();
    let conversationDoctype = "";
    let pendingClarification = null;
    let pendingTrainingTarget = "";
    const offeredTrainingTargets = new Set();
    let catalogItems = [];
    let catalogLoaded = false;
    let paletteTrigger = "";
    let paletteIndex = 0;
    let paletteRequest = 0;
    const palette = dock.querySelector(".muster-command-palette");

    function setReadingMode(expanded) {
      dock.classList.toggle("is-reading", expanded);
      const button = dock.querySelector(".muster-dock-expand");
      button.setAttribute("aria-pressed", String(expanded));
      button.textContent = expanded ? "↘" : "↗";
      button.title = expanded ? __("Compact learning view") : __("Expand learning view");
    }

    dock.querySelector(".muster-dock-toggle").addEventListener("click", () => {
      const collapsed = dock.classList.toggle("is-collapsed");
      dock.querySelector(".muster-dock-toggle").setAttribute("aria-expanded", String(!collapsed));
      if (!collapsed) window.setTimeout(() => prompt.focus(), 80);
    });
    dock.querySelector(".muster-intent-switch").addEventListener("click", (event) => {
      const button = event.target.closest("[data-muster-intent]");
      if (!button) return;
      setIntent(button.dataset.musterIntent);
    });
    dock.querySelector(".muster-dock-expand").addEventListener("click", () => setReadingMode(!dock.classList.contains("is-reading")));

    function setIntent(nextIntent) {
      intent = nextIntent === "workflow" ? "workflow" : "ask";
      dock.querySelectorAll("[data-muster-intent]").forEach((candidate) => {
        const active = candidate.dataset.musterIntent === intent;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      const workflow = intent === "workflow";
      submit.firstChild.textContent = workflow ? __("Create plan") + " " : __("Ask Muster") + " ";
      prompt.placeholder = workflow
        ? __("Describe the multi-step outcome. Muster will create an inert plan for your review; nothing runs yet.")
        : __("Ask about this site, a record, a process, a report, or what to do next…");
    }
    prompt.addEventListener("keydown", (event) => {
      if (!palette.hidden && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "Escape") return closePalette();
        const options = [...palette.querySelectorAll("[data-palette-token]")];
        if (!options.length) return;
        if (event.key === "Enter") return choosePaletteItem(options[paletteIndex]);
        paletteIndex = (paletteIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options.forEach((option, index) => option.setAttribute("aria-selected", String(index === paletteIndex)));
        options[paletteIndex].scrollIntoView({block: "nearest"});
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submitPrompt();
      }
    });
    prompt.addEventListener("input", () => {
      prompt.style.height = "auto";
      prompt.style.height = `${Math.min(prompt.scrollHeight, 144)}px`;
      const before = prompt.value.slice(0, prompt.selectionStart);
      const slash = /^\/([^\s]*)$/.exec(before);
      const mention = /(?:^|\s)@([^\s]*)$/.exec(before);
      if (slash) return openPalette("/", slash[1]);
      if (mention) return openPalette("@", mention[1]);
      closePalette();
    });
    dock.querySelector(".muster-command-bar").addEventListener("click", (event) => {
      const button = event.target.closest("[data-muster-palette]");
      if (button) openPalette(button.dataset.musterPalette, "");
    });
    palette.addEventListener("click", (event) => {
      const option = event.target.closest("[data-palette-token]");
      if (option) choosePaletteItem(option);
    });
    submit.addEventListener("click", submitPrompt);
    dock.querySelector(".muster-dock-list").addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-live-mission]");
      if (trigger) window.musterLiveSession?.open(trigger.dataset.liveMission);
    });

    function conversationKey() {
      const storageKey = `muster.ask.conversation.${frappe.session?.user || "user"}`;
      try {
        const existing = window.sessionStorage?.getItem(storageKey);
        if (existing) return existing;
        const created = `desk-${frappe.utils.get_random(32)}`;
        window.sessionStorage?.setItem(storageKey, created);
        return created;
      } catch (_error) {
        return `desk-${frappe.utils.get_random(32)}`;
      }
    }

    function currentScope() {
      const route = typeof frappe.get_route === "function" ? frappe.get_route() : [];
      const routeString = typeof frappe.get_route_str === "function" ? frappe.get_route_str() : "/app";
      return model.continuationScope(model.scope(route, routeString), conversationDoctype);
    }

    async function loadCatalog() {
      if (catalogLoaded) return;
      const response = await frappe.call({method: "muster.api.catalog.get_palette", type: "GET", freeze: false});
      catalogItems = model.catalog(response.message);
      catalogLoaded = true;
    }

    async function openPalette(trigger, query) {
      const request = ++paletteRequest;
      paletteTrigger = trigger;
      dock.querySelectorAll("[data-muster-palette]").forEach((button) => button.setAttribute("aria-expanded", String(button.dataset.musterPalette === trigger)));
      paletteIndex = 0;
      palette.hidden = false;
      palette.innerHTML = `<p>${__("Loading permitted options…")}</p>`;
      try {
        await loadCatalog();
        if (request !== paletteRequest || paletteTrigger !== trigger) return;
        const rows = model.filterCatalog(catalogItems, trigger, query);
        palette.innerHTML = rows.map((row, index) => `<button type="button" role="option" aria-selected="${index === 0}" data-palette-token="${frappe.utils.escape_html(row.token)}"><span class="muster-command-glyph">${frappe.utils.escape_html(row.kind === "command" ? "/" : "@")}</span><span><strong>${frappe.utils.escape_html(row.label)}</strong><small>${frappe.utils.escape_html(row.description)}</small></span><em>${frappe.utils.escape_html(row.kind)}</em></button>`).join("") || `<p>${__("No permitted options match.")}</p>`;
      } catch (_error) {
        palette.innerHTML = `<p>${__("Command discovery is temporarily unavailable.")}</p>`;
      }
    }

    function closePalette() {
      paletteRequest += 1;
      palette.hidden = true;
      dock.querySelectorAll("[data-muster-palette]").forEach((button) => button.setAttribute("aria-expanded", "false"));
      palette.innerHTML = "";
      paletteTrigger = "";
      paletteIndex = 0;
    }

    function choosePaletteItem(option) {
      if (!option) return;
      const token = option.dataset.paletteToken;
      // Slash commands are direct conversation controls. Selecting one while
      // the workflow composer is active must not accidentally plan a mission.
      if (paletteTrigger === "/") setIntent("ask");
      const selected = model.applySelection(prompt.value, prompt.selectionStart, prompt.selectionEnd, paletteTrigger, token);
      prompt.value = selected.value;
      prompt.setSelectionRange(selected.caret, selected.caret);
      closePalette();
      prompt.focus();
    }

    function appendMessage(kind, text, artifacts = []) {
      const item = document.createElement("article");
      item.className = `muster-chat-message is-${kind}`;
      const label = kind === "user" ? __("You") : __("Muster");
      item.innerHTML = `<small>${label}</small><div class="muster-rich-text">${model.richText(text)}</div>${artifacts.map((artifact) => `<a href="${frappe.utils.escape_html(artifact.download_url)}" target="_blank" rel="noopener">↧ ${frappe.utils.escape_html(artifact.name)}</a>`).join("")}`;
      chat.appendChild(item);
      if (kind === "assistant" && String(text || "").length > 180) setReadingMode(true);
      chat.scrollTop = chat.scrollHeight;
      return item;
    }

    function appendToolCalls(calls) {
      const visible = model.presentableCalls(calls);
      if (!visible.length) return;
      const item = document.createElement("article");
      item.className = "muster-tool-calls";
      item.innerHTML = `<details><summary>${__("What Muster did")} · ${visible.length} ${visible.length === 1 ? __("step") : __("steps")}</summary><div>${visible.map((call) => {
        const details = call.details && typeof call.details === "object" ? call.details : {};
        const safeDetails = [[__("Purpose"), details.purpose], [__("Scope"), details.scope], [__("Outcome"), details.outcome]]
          .filter(([, value]) => typeof value === "string" && value.trim())
          .map(([label, value]) => `<dt>${label}</dt><dd>${frappe.utils.escape_html(value.slice(0, 500))}</dd>`).join("");
        const status = {queued: __("Waiting"), running: __("In progress"), completed: __("Done"), failed: __("Stopped"), denied: __("Not permitted")}[call.status] || __("Checked");
        return `<section data-tool-status="${frappe.utils.escape_html(call.status)}"><div><strong>${frappe.utils.escape_html(call.label)}</strong><p>${frappe.utils.escape_html(call.summary)}</p>${safeDetails ? `<details><summary>${__("More context")}</summary><dl>${safeDetails}</dl></details>` : ""}</div><b>${frappe.utils.escape_html(status)}</b></section>`;
      }).join("")}</div></details>`;
      chat.appendChild(item);
      chat.scrollTop = chat.scrollHeight;
    }

    function appendTrainingContinuation(doctype) {
      const target = String(doctype || "").trim();
      if (!target || offeredTrainingTargets.has(target)) return;
      offeredTrainingTargets.add(target);
      const item = document.createElement("article");
      item.className = "muster-chat-message is-training-continuation";
      item.innerHTML = `<small>${__("Continue in the live system")}</small><div>${__("I can help you create this step by step, using the fields and rules that apply here now.")}</div><button class="btn btn-xs" type="button">${__("Create one with me")}</button>`;
      item.querySelector("button").addEventListener("click", () => {
        setIntent("ask");
        pendingTrainingTarget = target;
        item.querySelector("button").disabled = true;
        appendMessage("assistant", __(
          "Tell me the details listed above in your own words. I’ll check them against the live form, ask only for anything still required, and then guide you through it.",
        ));
        prompt.value = "";
        prompt.placeholder = __(
          "Add the {0} details here…",
          [target],
        );
        prompt.focus();
      });
      chat.appendChild(item);
      chat.scrollTop = chat.scrollHeight;
    }

    function appendHandoffs(turnId, handoffs) {
      if (!turnId || !Array.isArray(handoffs) || !handoffs.length) return;
      const item = document.createElement("article");
      item.className = "muster-chat-message is-handoff";
      item.innerHTML = `<small>${__("Ready for guided review")}</small><div>${__("Muster will open the live form, explain its fields, child tables, and available actions, then pause only where your approval is required.")}</div><div class="muster-handoff-actions"></div>`;
      const actions = item.querySelector(".muster-handoff-actions");
      handoffs.forEach((handoff) => {
        if (!handoff || handoff.state !== "offered" || handoff.requires !== "explicit_confirmation") return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-xs";
        button.textContent = handoff.label || __("Prepare reviewed plan");
        button.addEventListener("click", () => {
          const accept = async (extra = {}) => {
            button.disabled = true;
            let proposal = "";
            try {
              const response = await frappe.call({
                method: "muster.api.ask.accept_handoff",
                type: "POST",
                args: {
                  turn_id: turnId,
                  handoff_id: handoff.id,
                  confirmed: 1,
                  idempotency_key: frappe.utils.get_random(24),
                  ...extra,
                },
                freeze: false,
              });
              if (response.message?.status === "clarification") {
                const continuation = model.clarification(response.message.continuation, {
                  conversationId, turnId, handoffId: handoff.id,
                });
                if (!continuation || typeof response.message.reason !== "string" || !response.message.reason.trim()) {
                  throw new Error("invalid-clarification-receipt");
                }
                pendingClarification = continuation;
                setIntent("ask");
                actions.innerHTML = "";
                appendMessage("assistant", response.message.reason);
                appendMessage("assistant", __("Reply with only the missing details. I’ll show the complete merged request before continuing."));
                prompt.placeholder = __("Add the missing detail for the request above…");
                prompt.focus();
                return;
              }
              const acceptedProposal = response.message?.proposal;
              if (typeof acceptedProposal !== "string" || !acceptedProposal.trim() || acceptedProposal.length > 140) throw new Error("invalid-proposal-receipt");
              proposal = acceptedProposal;
              const development = response.message.proposal_doctype === "Muster Development Proposal";
              const route = development ? "muster-development-proposal" : "muster-workflow-proposal";
              const recoveryLink = `<a href="/desk/${route}/${encodeURIComponent(proposal)}">${handoff.kind === "attended_browser" ? __("Open audit or recover this preview") : development ? __("Review the inert development proposal") : __("Review the inert proposal")}</a>`;
              if (handoff.kind === "attended_browser") {
                actions.innerHTML = `<span class="text-muted" role="status">${__("Opening the form…")}</span>${recoveryLink}`;
                const opened = await model.startAttendedHandoff(
                  handoff.kind,
                  proposal,
                  async (acceptedProposal) => {
                    const prepared = await frappe.call({
                      method: "muster.api.mission.prepare_attended_preview",
                      type: "POST",
                      args: {proposal: acceptedProposal, confirmed: 1, idempotency_key: frappe.utils.get_random(24)},
                      freeze: false,
                    });
                    return prepared.message;
                  },
                  async (receipt) => {
                    if (!window.musterSurfaceAdapters?.start) throw new Error("attended-surface-unavailable");
                    return window.musterSurfaceAdapters.start(receipt);
                  },
                );
                if (opened === "navigated") {
                  actions.innerHTML = `<span class="text-muted" role="status">${__("Opening the form with your details…")}</span>${recoveryLink}`;
                  return;
                }
                if (!opened) throw new Error("attended-preview-not-opened");
                actions.innerHTML = `<span class="text-muted" role="status">${__("Form opened with the details filled in. Review it before saving.")}</span>${recoveryLink}`;
                return;
              }
              actions.innerHTML = recoveryLink;
            } catch (_error) {
              console.error("Muster attended handoff failed", _error);
              button.disabled = false;
              const recovery = proposal
                ? `<a href="/desk/muster-workflow-proposal/${encodeURIComponent(proposal)}">${__("Open the audit record or retry the preview")}</a>`
                : "";
              actions.innerHTML = `<span class="text-muted" role="status">${handoff.kind === "attended_browser" ? __("I couldn’t open the form. Your details are still here, so you can try again.") : __("I couldn’t prepare that step. Your request is still here, so you can try again.")}</span>${recovery}`;
            }
          };
          if (handoff.kind === "development_workflow") {
            frappe.prompt([
              {fieldname: "development_app", fieldtype: "Link", options: "Muster Development App", label: __("Registered app"), reqd: 1},
              {fieldname: "policy", fieldtype: "Link", options: "Muster Policy", label: __("Policy"), reqd: 1},
            ], (values) => accept(values), __("Bind this proposal to reviewed source"), __("Create inert proposal"));
            return;
          }
          if (handoff.kind === "attended_browser") {
            accept();
            return;
          }
          frappe.confirm(
            __("Create an inert proposal for review? This will not publish, start, open a browser, or change Frappe."),
            () => accept(),
          );
        });
        actions.appendChild(button);
        if (handoff.kind === "attended_browser") {
          button.hidden = true;
          actions.insertAdjacentHTML("beforeend", `<span class="text-muted" role="status">${__("Opening the form with your details…")}</span>`);
          window.queueMicrotask(() => button.click());
        }
      });
      chat.appendChild(item);
      chat.scrollTop = chat.scrollHeight;
    }

    async function pollAnswer(runId, answerItem) {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const response = await frappe.call({
          method: "muster.api.ask.poll",
          type: "GET",
          args: {run_id: runId, wait_ms: 10000},
          freeze: false,
        });
        if (typeof response.message?.context_target?.doctype === "string") {
          conversationDoctype = response.message.context_target.doctype;
        }
        const state = response.message;
        if (state.status === "completed") {
          answerItem.remove();
          appendMessage("assistant", state.answer, state.artifacts || []);
          appendToolCalls(state.tool_calls || []);
          appendTrainingContinuation(state.context_target?.doctype || conversationDoctype);
          return;
        }
        if (state.status === "failed") {
          answerItem.remove();
          appendMessage("error", state.error || __("Muster could not complete this answer."));
          return;
        }
        answerItem.querySelector("div").textContent = __("Working with your permitted site context…");
      }
      answerItem.querySelector("div").textContent = __("This is taking longer than expected. You can ask again safely.");
    }

    async function submitPrompt() {
      const text = prompt.value.trim();
      if (!text) {
        frappe.show_alert({message: __("Type a question or describe the workflow you want."), indicator: "orange"});
        prompt.focus();
        return;
      }
      if (!connected) {
        const action = canAdminister
          ? `<a href="/desk/muster-settings/Muster%20Settings">${__("Open Muster Settings")}</a>`
          : __("Ask a Muster administrator to connect the AI runtime.");
        frappe.msgprint({title: __("AI runtime is not connected"), indicator: "orange", message: `${__("This request was not queued because no trusted Muster gateway is active.")}<br>${action}`});
        return;
      }
      submit.disabled = true;
      closePalette();
      const requestIntent = pendingClarification ? "ask" : intent;
      const trainingTarget = pendingTrainingTarget;
      const submittedText = trainingTarget
        ? __(
          "Create a {0} with these details: {1}. Validate them against the live form and ask only for anything still required. Open the live form, fill the reviewed values visibly, and explain each field, child table, and available button. Pause for my approval before Save or Submit.",
          [trainingTarget, text],
        )
        : text;
      let pendingAnswer;
      try {
        if (requestIntent === "workflow") {
          const response = await frappe.call({
            method: model.submitMethod(requestIntent),
            type: "POST",
            args: {objective: text, scope: JSON.stringify(currentScope()), idempotency_key: frappe.utils.get_random(24)},
            freeze: false,
          });
          prompt.value = "";
          const proposal = response.message.proposal;
          frappe.msgprint({
            title: __("Workflow proposal ready"),
            indicator: "blue",
            message: `${__("Muster created an inert plan for review. Nothing has executed.")}<br><a href="/desk/muster-workflow-proposal/${encodeURIComponent(proposal)}">${__("Review workflow proposal")}</a>`,
          });
          return;
        }
        appendMessage("user", text);
        prompt.value = "";
        const answerItem = appendMessage("assistant", __("Thinking with your permitted site context…"));
        pendingAnswer = answerItem;
        const clarification = pendingClarification;
        const response = await frappe.call({
          method: model.submitMethod(requestIntent),
          type: "POST",
          args: {
            prompt: submittedText,
            conversation_id: conversationId,
            scope: JSON.stringify(clarification?.boundScope || currentScope()),
            idempotency_key: frappe.utils.get_random(24),
            ...(clarification ? {
              clarification_turn_id: clarification.turnId,
              clarification_handoff_id: clarification.handoffId,
              clarification_token: clarification.token,
              clarification_prompt_hash: clarification.promptHash,
            } : {}),
          },
          freeze: false,
        });
        if (clarification) {
          if (typeof response.message.merged_objective !== "string" || !response.message.merged_objective.trim()) {
            throw new Error("missing-merged-objective");
          }
          pendingClarification = null;
          prompt.placeholder = __("Ask about this site, a record, a process, a report, or what to do next…");
          appendMessage("assistant", `${__("Merged request (original + your reply):")}\n${response.message.merged_objective}`);
        }
        if (trainingTarget) pendingTrainingTarget = "";
        if (response.message.status === "clarification") {
          answerItem.remove();
          appendMessage("assistant", response.message.reason);
          const next = model.clarification(response.message.continuation, {
            conversationId, turnId: response.message.turn_id, handoffId: "intent",
          });
          if (next) {
            pendingClarification = next;
            prompt.placeholder = __("Add the missing detail for the request above…");
          }
          return;
        }
        if (response.message.status === "needs_read_plan") {
          answerItem.remove();
          appendMessage("assistant", response.message.reason);
          return;
        }
        if (typeof response.message?.context_target?.doctype === "string") {
          conversationDoctype = response.message.context_target.doctype;
        }
        await pollAnswer(response.message.run_id, answerItem);
        appendHandoffs(response.message.turn_id, response.message.handoffs || []);
      } catch (error) {
        if (requestIntent === "ask") {
          pendingAnswer?.remove();
          appendMessage("error", __("Muster could not answer that request. Nothing was changed."));
        } else {
          frappe.msgprint({
            title: __("Workflow could not be prepared"),
            indicator: "orange",
            message: __("Muster could not prepare this workflow for review. Nothing was changed."),
          });
        }
      } finally {
        submit.disabled = false;
        prompt.focus();
      }
    }

    let refreshInFlight = null;
    let refreshQueued = false;
    let refreshFailures = 0;
    let refreshAfter = 0;

    async function fetchActiveMissions() {
      const url = new URL("/api/method/frappe.desk.reportview.get_list", window.location.origin);
      url.searchParams.set("doctype", "Muster Mission");
      url.searchParams.set("filters", JSON.stringify({status: ["not in", ["Completed", "Failed", "Cancelled"]]}));
      url.searchParams.set("fields", JSON.stringify(["name", "objective", "status", "progress"]));
      url.searchParams.set("order_by", "modified desc");
      url.searchParams.set("limit", "8");
      const response = await window.fetch(url, {
        method: "GET",
        credentials: "same-origin",
        headers: {Accept: "application/json"},
      });
      if (!response.ok) throw new Error(`mission-poll-${response.status}`);
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.message)) throw new Error("mission-poll-invalid-response");
      return payload.message;
    }

    async function refresh() {
      if (Date.now() < refreshAfter) return refreshInFlight;
      if (refreshInFlight) {
        refreshQueued = true;
        return refreshInFlight;
      }
      refreshInFlight = (async () => {
        try {
          const rows = await fetchActiveMissions();
          refreshFailures = 0;
          refreshAfter = 0;
          dock.querySelector(".muster-dock-count").textContent = rows.length;
          dock.querySelector(".muster-dock-list").innerHTML = rows.map((row) => `<div class="muster-dock-item"><button type="button" data-live-mission="${frappe.utils.escape_html(row.name)}" title="${frappe.utils.escape_html(row.objective)}"><strong>${frappe.utils.escape_html(row.objective)}</strong><small>${frappe.utils.escape_html(row.status)} · ${Math.round(row.progress || 0)}% · ${__("Watch live")}</small></button><a href="/desk/muster-mission/${encodeURIComponent(row.name)}" aria-label="${__("Open mission record")}">↗</a></div>`).join("") || `<p>${connected ? __("No active workflows") : __("Connect the AI runtime to start work")}</p>`;
        } catch (_error) {
          refreshFailures += 1;
          refreshAfter = Date.now() + model.refreshBackoff(refreshFailures);
        } finally {
          const runTrailing = refreshQueued;
          refreshQueued = false;
          refreshInFlight = null;
          if (runTrailing && Date.now() >= refreshAfter) window.queueMicrotask(refresh);
        }
      })();
      return refreshInFlight;
    }
    frappe.realtime.on("muster_mission_changed", refresh);
    frappe.realtime.on("muster_activity", refresh);
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh().catch(() => {});
    }, 10000);
    dock.addEventListener("remove", () => window.clearInterval(poll), {once: true});
    refresh().catch(() => {});
  }
  $(document).on("app_ready", boot);
})();
