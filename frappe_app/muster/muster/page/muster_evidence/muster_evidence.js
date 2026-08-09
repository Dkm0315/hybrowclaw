frappe.pages["muster-evidence"].on_page_load = function (wrapper) {
  const page = frappe.ui.make_app_page({parent: wrapper, title: __("Evidence Registry"), single_column: true});
  const root = document.createElement("div");
  root.className = "muster-evidence-registry";
  root.innerHTML = `
    <div class="muster-panel" style="margin-top:16px">
      <header><div><p class="muster-eyebrow">${__("Video-first proof")}</p><h3>${__("Verified automation evidence")}</h3></div>
      <button class="btn btn-sm btn-default evidence-refresh">${__("Refresh")}</button></header>
      <div class="evidence-filters" style="display:grid;grid-template-columns:minmax(180px,1fr) minmax(180px,1fr);gap:12px;margin:12px 0"></div>
      <div class="evidence-list" aria-live="polite"></div>
    </div>`;
  page.main.get(0).appendChild(root);
  const mission = frappe.ui.form.make_control({parent: root.querySelector(".evidence-filters"),
    df: {fieldtype: "Link", options: "Muster Mission", label: __("Mission"), onchange: load}, render_input: true});
  const module = frappe.ui.form.make_control({parent: root.querySelector(".evidence-filters"),
    df: {fieldtype: "Link", options: "Module Def", label: __("Module"), onchange: load}, render_input: true});
  root.querySelector(".evidence-refresh").addEventListener("click", load);

  async function load() {
    const list = root.querySelector(".evidence-list");
    list.innerHTML = `<div class="muster-loading">${__("Loading verified evidence…")}</div>`;
    const response = await frappe.call("muster.api.evidence.list_clips", {
      mission: mission.get_value() || null, module: module.get_value() || null, status: "Verified", limit: 100,
    });
    const rows = response.message.clips;
    list.innerHTML = rows.length ? rows.map(card).join("") : `<div class="muster-empty">${__("No verified evidence is visible in this scope.")}</div>`;
  }

  function card(row) {
    const safe = frappe.utils.escape_html;
    return `<article class="muster-panel" style="margin:12px 0;padding:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;align-items:start">
        <video controls preload="metadata" playsinline src="${safe(row.video)}" style="width:100%;border-radius:10px;background:#111"></video>
        <div><p class="muster-eyebrow">${safe(row.module)} · ${safe(row.status)}</p><h3>${safe(row.scenario)}</h3>
        <p>${safe(row.claim)}</p><dl><dt>${__("Actor")}</dt><dd>${safe(row.actor)} · ${safe(row.actor_role)}</dd>
        <dt>${__("Mission")}</dt><dd><a href="/desk/muster-mission/${encodeURIComponent(row.mission)}">${safe(row.mission)}</a></dd>
        <dt>${__("Build")}</dt><dd>${safe(row.build_revision)}</dd><dt>SHA-256</dt><dd><code>${safe(row.video_sha256)}</code></dd></dl>
        <a class="btn btn-xs btn-default" href="/desk/muster-evidence-clip/${encodeURIComponent(row.name)}">${__("Open evidence record")}</a></div>
      </div></article>`;
  }
  load().catch((error) => { root.querySelector(".evidence-list").innerHTML = `<div class="muster-error">${__("Evidence could not be loaded.")}</div>`; console.error(error); });
};
