import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../../frappe_app/muster/public/js/live_work_session.js", import.meta.url), "utf8");

test("native attended delete supports the Frappe v16 visible menu contract", () => {
  assert.match(source, /form\.page\?\.btn_menu/);
  assert.match(source, /button\.menu-more-button\[aria-label='Menu'\]/);
  assert.match(source, /\.dropdown-menu\.show/);
  assert.match(source, /\.menu-item-label/);
  assert.match(source, /visibleMenus\.length !== 1/);
  assert.match(source, /menus\.length === 1/);
  assert.match(source, /dialog\.disable_primary_action\(\);\s+dialog\.hide\(\);\s+try \{\s+await this\.executeDelete/);
});
