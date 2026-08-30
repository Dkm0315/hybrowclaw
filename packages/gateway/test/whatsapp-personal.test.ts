import assert from "node:assert/strict";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import {
  evaluateWhatsAppGroupPolicy,
  doctorWhatsApp,
  prepareWhatsAppAuthState,
  WhatsAppPairingChallengeTracker,
  whatsAppWebMessageToSurfaceMessage,
} from "../src/adapters/whatsapp.js";

const GROUP = "120363000000000000@g.us";
const BOT = "15550000000:7@s.whatsapp.net";
const ALICE = "15551111111@s.whatsapp.net";

test("WhatsApp group policy defaults to mention and applies group then sender allowlists", () => {
  assert.deepEqual(evaluateWhatsAppGroupPolicy({ groupJid: GROUP, participantJid: ALICE, groups: [] }), { allowed: false, reason: "group_not_allowed" });
  assert.deepEqual(evaluateWhatsAppGroupPolicy({ groupJid: GROUP, participantJid: ALICE, groups: [GROUP], groupAllowFrom: ["15552222222@s.whatsapp.net"], mentionedJids: [BOT], botJid: BOT }), { allowed: false, reason: "sender_not_allowed" });
  assert.deepEqual(evaluateWhatsAppGroupPolicy({ groupJid: GROUP, participantJid: ALICE, groups: [GROUP], mentionedJids: [], botJid: BOT }), { allowed: false, reason: "mention_required" });
  assert.deepEqual(evaluateWhatsAppGroupPolicy({ groupJid: GROUP, participantJid: ALICE, groups: ["*"], mentionedJids: ["15550000000@s.whatsapp.net"], botJid: BOT }), { allowed: true, activation: "mention" });
});

test("WhatsApp group activation supports always and reply-to-bot without bypassing sender policy", () => {
  assert.deepEqual(evaluateWhatsAppGroupPolicy({ groupJid: GROUP, participantJid: ALICE, groups: [GROUP], activation: "always" }), { allowed: true, activation: "always" });
  assert.deepEqual(evaluateWhatsAppGroupPolicy({ groupJid: GROUP, participantJid: ALICE, groups: [GROUP], quotedParticipantJid: "15550000000@s.whatsapp.net", botJid: BOT }), { allowed: true, activation: "mention" });
  assert.deepEqual(evaluateWhatsAppGroupPolicy({ groupJid: GROUP, participantJid: ALICE, groups: [GROUP], groupAllowFrom: ["15552222222@s.whatsapp.net"], quotedParticipantJid: BOT, botJid: BOT }), { allowed: false, reason: "sender_not_allowed" });
});

test("WhatsApp envelope mapping distinguishes DM peers from group participants and carries subject display metadata", () => {
  const dm = whatsAppWebMessageToSurfaceMessage({ key: { id: "dm-1", remoteJid: ALICE }, message: { conversation: "hello" } }, { account: "home" });
  assert.equal(dm?.surfaceId, "whatsapp:home");
  assert.equal(dm?.conversationId, ALICE);
  assert.equal(dm?.senderId, ALICE);

  const group = whatsAppWebMessageToSurfaceMessage({
    key: { id: "group-1", remoteJid: GROUP, participant: ALICE },
    message: { extendedTextMessage: { text: "@Muster help", contextInfo: { mentionedJid: [BOT] } } },
  }, { account: "home", groupSubject: "Family" });
  assert.equal(group?.conversationId, GROUP);
  assert.equal(group?.senderId, ALICE);
  assert.deepEqual((group?.raw as { displayMetadata?: unknown }).displayMetadata, { groupSubject: "Family" });
});

test("WhatsApp pairing challenge is sent once until the sender becomes paired", () => {
  const tracker = new WhatsAppPairingChallengeTracker();
  const challenge = { status: "pairing_required" as const, code: "ABCDEFGH" };
  assert.equal(tracker.shouldSend(ALICE, challenge), true);
  assert.equal(tracker.shouldSend(ALICE, challenge), false);
  assert.equal(tracker.shouldSend(ALICE, { text: "paired" }), true);
  assert.equal(tracker.shouldSend(ALICE, challenge), true);
});

test("WhatsApp multi-file auth state uses a 0700 account directory and persists credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-whatsapp-auth-"));
  let directory = "";
  const auth = await prepareWhatsAppAuthState({ account: "work" }, {
    home,
    loadBaileys: async () => ({
      default: (() => { throw new Error("socket must not start in auth persistence test"); }) as never,
      useMultiFileAuthState: async (target) => {
        directory = target;
        return { state: { creds: { registered: true } }, saveCreds: () => writeFile(join(target, "creds.json"), "{}\n", { mode: 0o600 }) };
      },
    }),
  });
  await auth.saveCreds();
  assert.equal(directory, join(home, ".muster", "whatsapp", "work"));
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(directory, "creds.json"), "utf8"), "{}\n");
  const doctor = await doctorWhatsApp({ account: "work" }, { home, now: Date.now() });
  assert.equal(doctor.sessionPresent, true);
  assert.equal(doctor.connection, "offline_unknown");
  assert.match(doctor.detail, /connection state is unavailable while the gateway is offline/);
  await chmod(directory, 0o700);
});
