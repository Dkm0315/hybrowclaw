from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

import frappe
from frappe import _
from frappe.utils.change_log import get_versions
from frappe.utils import cint


_SURFACES = {
    # These are audited adapter families, not optimistic major-version claims.
    # New upstream minors stay disabled until their routes/controls are proven.
    # The clean Frappeverse bench is pinned to CRM 1.79.0.  The 1.79 lead
    # create/list controls were re-audited on that exact build; later minors
    # remain fail-closed until their native surface contract is revalidated.
    "crm": {"apps": ("crm", "frappe_crm"), "supported": re.compile(r"^1\.(?:78|79)\.\d+(?:[-+].*)?$")},
    "helpdesk": {"apps": ("helpdesk",), "supported": re.compile(r"^1\.27\.\d+(?:[-+].*)?$")},
}
_CONFIG_KEY = "muster_spa_surfaces"
_ID = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_APP = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_PATH = re.compile(r"^/(?:[A-Za-z0-9._~-]+/?)*$")
_DOCTYPE = re.compile(r"^[A-Za-z][A-Za-z0-9 _-]{0,139}$")
_FIELDNAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,139}$")
_ROOT_MARKERS = {"#app", "[data-v-app]", "[data-reactroot]", "[data-muster-spa-root]"}


def _safe_path(value: Any) -> bool:
    if not isinstance(value, str) or not _PATH.fullmatch(value):
        return False
    return all(segment not in {".", ".."} for segment in value.split("/") if segment)


def _require_authenticated_get() -> None:
    if frappe.request and frappe.request.method != "GET":
        frappe.throw(_("This endpoint only accepts GET requests"), frappe.PermissionError)
    user = str(frappe.session.user or "").strip()
    if not user or user.lower() == "guest" or not cint(frappe.db.get_value("User", user, "enabled")):
        frappe.throw(_("Sign in to use Muster"), frappe.PermissionError)


def _installed_apps() -> set[str]:
    """Keep the site-install check isolated from Frappe's global hook loader."""
    return set(frappe.get_installed_apps() or [])


def _version_for_apps(apps: tuple[str, ...]) -> str | None:
    installed = _installed_apps()
    versions: dict[str, Any] = get_versions() or {}
    for app in apps:
        if app not in installed:
            continue
        row = versions.get(app)
        value = row.get("version") if isinstance(row, dict) else row
        if isinstance(value, str) and value.strip():
            return value.strip()[:64]
    return None


def _installed_version(surface: str) -> str | None:
    return _version_for_apps(_SURFACES[surface]["apps"])


def _bounded_strings(value: Any, *, maximum: int, pattern: re.Pattern[str] | None = None) -> list[str] | None:
    if not isinstance(value, list) or not value or len(value) > maximum:
        return None
    rows: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item or len(item) > 140 or (pattern and not pattern.fullmatch(item)):
            return None
        rows.append(item)
    return list(dict.fromkeys(rows))


def _configured_surface(route: str) -> dict[str, Any] | None:
    """Return one fail-closed, non-executable Muster-owned SPA manifest.

    A site administrator can configure this in ``site_config.json`` without
    changing or forking the target Vue/React application. The contract contains
    routes and semantic labels only: JavaScript, CSS selectors and callbacks are
    deliberately not accepted.
    """
    if not isinstance(route, str) or len(route) > 2_048 or not _safe_path(route):
        return None
    configured = getattr(frappe, "conf", {}).get(_CONFIG_KEY, [])
    if not isinstance(configured, list) or len(configured) > 24:
        return None
    matches: list[dict[str, Any]] = []
    for raw in configured:
        if not isinstance(raw, dict):
            continue
        identifier, label, app, base = raw.get("id"), raw.get("label"), raw.get("app"), raw.get("base")
        major = raw.get("supported_major")
        prefixes = _bounded_strings(raw.get("path_prefixes"), maximum=12, pattern=_PATH)
        roots = _bounded_strings(raw.get("root_markers"), maximum=4)
        doctypes = _bounded_strings(raw.get("doctypes"), maximum=120, pattern=_DOCTYPE)
        operations = _bounded_strings(raw.get("operations"), maximum=3)
        if (
            not isinstance(identifier, str) or not _ID.fullmatch(identifier)
            or (label is not None and (not isinstance(label, str) or not label.strip() or len(label) > 120))
            or not isinstance(app, str) or not _APP.fullmatch(app)
            or not _safe_path(base) or base == "/" or base.endswith("/")
            or not isinstance(major, int) or isinstance(major, bool) or major < 0 or major > 99
            or not prefixes or any(
                not _safe_path(prefix) or not prefix.endswith("/") or not prefix.startswith(f"{base}/")
                for prefix in prefixes
            )
            or not roots or any(root not in _ROOT_MARKERS for root in roots)
            or not doctypes or not operations or any(operation not in {"create", "update", "delete"} for operation in operations)
        ):
            continue
        if not any(route == prefix[:-1] or route.startswith(prefix) for prefix in prefixes):
            continue
        version = _version_for_apps((app,))
        if not version or not re.fullmatch(rf"{major}\.\d+(?:\.\d+)?(?:[-+].*)?", version):
            continue
        routes = raw.get("routes")
        if not isinstance(routes, dict) or set(routes) != set(doctypes):
            continue
        safe_routes: dict[str, Any] = {}
        valid = True
        for doctype in doctypes:
            row = routes.get(doctype)
            if not isinstance(row, dict) or set(row) - {"list", "create", "record", "create_buttons", "commit_buttons", "field_hints"}:
                valid = False
                break
            list_route, create, record = row.get("list"), row.get("create"), row.get("record")
            if list_route is not None and not _safe_path(list_route):
                valid = False
                break
            if "create" in operations and not _safe_path(create):
                valid = False
                break
            if any(operation in operations for operation in {"update", "delete"}) and (
                not isinstance(record, str) or record.count("{name}") != 1
                or not _safe_path(record.replace("{name}", "record"))
            ):
                valid = False
                break
            buttons = row.get("create_buttons", [])
            if not isinstance(buttons, list) or len(buttons) > 8 or any(
                not isinstance(label, str) or not label.strip() or len(label) > 80 for label in buttons
            ):
                valid = False
                break
            commit_buttons = row.get("commit_buttons")
            if not isinstance(commit_buttons, dict) or set(commit_buttons) != set(operations):
                valid = False
                break
            safe_commit_buttons: dict[str, list[str]] = {}
            for operation in operations:
                labels = _bounded_strings(commit_buttons.get(operation), maximum=8)
                if not labels:
                    valid = False
                    break
                safe_commit_buttons[operation] = [value.strip() for value in labels]
            if not valid:
                break
            hints = row.get("field_hints", {})
            if not isinstance(hints, dict) or len(hints) > 100:
                valid = False
                break
            safe_hints: dict[str, list[str]] = {}
            for fieldname, values in hints.items():
                labels = _bounded_strings(values, maximum=8)
                if not isinstance(fieldname, str) or not _FIELDNAME.fullmatch(fieldname) or not labels:
                    valid = False
                    break
                safe_hints[fieldname] = labels
            if not valid:
                break
            safe_routes[doctype] = {
                **({"list": list_route} if list_route else {}),
                **({"create": create} if create else {}),
                **({"record": record} if record else {}),
                "createButtons": [label.strip() for label in buttons],
                "commitButtons": safe_commit_buttons,
                "fieldHints": safe_hints,
            }
        if valid:
            matches.append({
                "schemaVersion": 1,
                "id": f"muster-config-{identifier}",
                "label": (label or identifier).strip(),
                "priority": 60,
                "base": base,
                "pathPrefixes": prefixes,
                "doctypes": doctypes,
                "operations": operations,
                "capabilities": {
                    "navigate": True,
                    "fill": True,
                    "pauseBeforeSave": True,
                    "save": "separate_confirmation",
                    **({"destructiveReview": "typed_confirmation_native_one_time"} if "delete" in operations else {}),
                },
                "rootMarkers": roots,
                "routes": safe_routes,
                "installedVersion": version,
            })
    return matches[0] if len(matches) == 1 else None


def is_configured_spa_route(route: str) -> bool:
    return _configured_surface(route) is not None


def attended_surface_for_route(route: str) -> str | None:
    """Resolve one audited surface identity without accepting client descriptors."""
    if not isinstance(route, str) or not _safe_path(route):
        return None
    if route == "/desk" or route.startswith("/desk/") or route == "/app" or route.startswith("/app/"):
        return "desk"
    if route == "/crm" or route.startswith("/crm/"):
        version = _installed_version("crm")
        return "crm" if version and _SURFACES["crm"]["supported"].fullmatch(version) else None
    if route == "/helpdesk" or route.startswith("/helpdesk/"):
        version = _installed_version("helpdesk")
        return "helpdesk" if version and _SURFACES["helpdesk"]["supported"].fullmatch(version) else None
    descriptor = _configured_surface(route)
    return str(descriptor["id"]) if descriptor else None


def attended_target_for(doctype: str, operation: str, record_name: str | None) -> dict[str, str]:
    """Choose one installed, version-audited native surface for an attended receipt."""
    if not isinstance(doctype, str) or not _DOCTYPE.fullmatch(doctype) or operation not in {"create", "update", "delete"}:
        raise ValueError("invalid attended target")
    if operation in {"update", "delete"} and (not isinstance(record_name, str) or not record_name):
        raise ValueError("record identity is required")

    crm_routes = {
        "CRM Lead": "/crm/leads/view/list",
        "CRM Deal": "/crm/deals",
        "Contact": "/crm/contacts",
        "CRM Organization": "/crm/organizations",
    }
    if operation == "create" and doctype in crm_routes and attended_surface_for_route("/crm") == "crm":
        return {"surface": "crm", "route": crm_routes[doctype]}
    if operation == "create" and doctype == "HD Ticket" and attended_surface_for_route("/helpdesk") == "helpdesk":
        return {"surface": "helpdesk", "route": "/helpdesk/tickets/new"}

    configured = getattr(frappe, "conf", {}).get(_CONFIG_KEY, [])
    matches: list[dict[str, str]] = []
    if isinstance(configured, list) and len(configured) <= 24:
        for raw in configured:
            if not isinstance(raw, dict) or doctype not in (raw.get("doctypes") or []) or operation not in (raw.get("operations") or []):
                continue
            row = (raw.get("routes") or {}).get(doctype)
            base = raw.get("base")
            if not isinstance(row, dict) or not isinstance(base, str):
                continue
            relative = row.get("create") if operation == "create" else row.get("record")
            if operation != "create" and isinstance(relative, str):
                relative = relative.replace("{name}", quote(str(record_name), safe=""))
            if not isinstance(relative, str):
                continue
            route = f"{base}{relative}".replace("//", "/")
            descriptor = _configured_surface(route)
            if descriptor and descriptor.get("id") and doctype in descriptor.get("doctypes", []) and operation in descriptor.get("operations", []):
                matches.append({"surface": str(descriptor["id"]), "route": route})
    unique = {(row["surface"], row["route"]): row for row in matches}
    if len(unique) == 1:
        return next(iter(unique.values()))
    return {"surface": "desk", "route": "/desk"}


@frappe.whitelist()
def bootstrap(surface: str = "", route: str = "") -> dict[str, Any]:
    """Return one authenticated SPA support decision and a session CSRF token.

    This deliberately does not expose the installed-app catalog. Unknown
    surfaces receive no version information and can never enable an adapter.
    """
    _require_authenticated_get()
    key = str(surface or "").strip().lower()
    result: dict[str, Any] = {
        "schema_version": 1,
        "adapter_contract": 1,
        "surface": key if key in _SURFACES else None,
        "supported": False,
        "csrf_token": frappe.sessions.get_csrf_token(),
    }
    if not key and route:
        descriptor = _configured_surface(str(route))
        if descriptor:
            result.update({
                "surface": "custom",
                "supported": True,
                "installed_version": descriptor.pop("installedVersion"),
                "descriptor": descriptor,
            })
        return result
    if key not in _SURFACES:
        return result
    version = _installed_version(key)
    if version and _SURFACES[key]["supported"].fullmatch(version):
        result.update({"supported": True, "installed_version": version})
    return result
