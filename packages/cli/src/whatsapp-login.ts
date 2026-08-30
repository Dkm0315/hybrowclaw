import { loginWhatsApp, renderWhatsAppQr, WHATSAPP_PERSONAL_WARNING } from "@musterhq/gateway";
import type { GatewayConfig } from "@musterhq/gateway";

export interface WhatsAppLoginCommandOptions {
  readonly gateway: GatewayConfig;
  readonly isTTY: boolean;
  readonly output: (line: string) => void;
  readonly login?: typeof loginWhatsApp;
}

/** Injectable command seam: tests exercise QR output without opening a network socket. */
export async function runWhatsAppLoginCommand(options: WhatsAppLoginCommandOptions): Promise<void> {
  const config = options.gateway.whatsapp ?? {};
  options.output(WHATSAPP_PERSONAL_WARNING);
  options.output(`account=${config.account?.trim() || "default"}`);
  await (options.login ?? loginWhatsApp)({
    config,
    onQr: (payload) => options.output(renderWhatsAppQr(payload, options.isTTY)),
    log: options.output,
  });
  options.output("ready=WhatsApp linked device connected; credentials saved");
  options.output("next=muster channels status whatsapp");
}
