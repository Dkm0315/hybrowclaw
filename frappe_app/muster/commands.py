from __future__ import annotations

import json

import click
import frappe
from frappe.commands import pass_context


@click.command("seed-demo")
@click.option(
    "--scale",
    type=click.Choice(["tiny", "small", "medium", "large", "acceptance"]),
    default="tiny",
    show_default=True,
)
@click.option("--scenario", default="frappeverse", show_default=True)
@click.option("--with-erpnext/--without-erpnext", default=True, show_default=True)
@click.option(
    "--yes", is_flag=True, help="Required acknowledgement that demo data will be written."
)
@pass_context
def seed_demo_command(context, scale, scenario, with_erpnext, yes):
    """Seed deterministic proof data on each explicitly selected site."""
    if not context.sites:
        raise frappe.SiteNotSpecifiedError
    if not yes:
        raise click.UsageError("Pass --yes to acknowledge demo data creation")

    from muster.demo.seed import seed_demo

    for site in context.sites:
        try:
            frappe.init(site=site)
            frappe.connect()
            if "muster" not in frappe.get_installed_apps():
                raise click.ClickException(f"Muster is not installed on {site}")
            frappe.set_user("Administrator")
            result = seed_demo(
                scale=scale,
                scenario=scenario,
                confirm=True,
                with_erpnext=with_erpnext,
            )
            frappe.db.commit()
            click.echo(json.dumps(result, indent=2, sort_keys=True, default=str))
        except Exception:
            if frappe.db:
                frappe.db.rollback()
            raise
        finally:
            frappe.destroy()


commands = [seed_demo_command]
