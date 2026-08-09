from __future__ import annotations

import json
import unittest
from hashlib import sha256
from uuid import uuid4

try:
    import frappe
    from frappe.tests.utils import FrappeTestCase
    from frappe.utils import now_datetime
    from frappe.utils.file_manager import save_file
except ModuleNotFoundError as exc:
    raise unittest.SkipTest("Frappe evidence tests require an installed test site") from exc

from muster.api.evidence import get_clip, list_clips
from muster.permissions import evidence_clip_has_permission


class TestMusterEvidenceClip(FrappeTestCase):
    def setUp(self):
        super().setUp()
        self.original_user = frappe.session.user
        frappe.set_user("Administrator")
        self.suffix = uuid4().hex[:10]

    def tearDown(self):
        frappe.set_user(self.original_user)
        super().tearDown()

    def _user(self, label, role="Muster Viewer"):
        email = f"evidence-{label}-{self.suffix}@example.test"
        return frappe.get_doc({
            "doctype": "User", "email": email, "first_name": f"Evidence {label}",
            "enabled": 1, "send_welcome_email": 0, "roles": [{"role": role}],
        }).insert()

    def _mission(self, requested_by="Administrator"):
        return frappe.get_doc({
            "doctype": "Muster Mission", "objective": "Capture reproducible video evidence",
            "status": "Completed", "requested_by": requested_by,
            "requested_at": now_datetime(), "idempotency_key": uuid4().hex,
        }).insert()

    def _video(self, *, private=True, extension="mp4", content=None):
        content = content or (b"\x00\x00\x00\x18ftypisom" + b"muster-video-proof\x00" * 32)
        return save_file(f"proof-{self.suffix}.{extension}", content, None, None,
                         is_private=int(private))

    def _clip(self, mission, file_doc, *, status="Verified"):
        return frappe.get_doc({
            "doctype": "Muster Evidence Clip", "scenario": "Invoice follow-up proof",
            "claim": "Muster planned the change and preserved approval evidence",
            "status": status, "actor": "Administrator", "actor_role": "System Manager",
            "module": "Muster", "mission": mission.name, "video": file_doc.file_url,
            "duration_seconds": 18.5, "viewport_width": 1440, "viewport_height": 900,
            "build_revision": f"build-{self.suffix}",
            "test_receipt_json": json.dumps({"suite": "evidence", "passed": 12, "failed": 0}),
        }).insert()

    def test_private_video_is_hashed_attached_and_verified(self):
        content = b"\x00\x00\x00\x18ftypisom" + b"verified-muster-video" * 64
        video = self._video(content=content)
        clip = self._clip(self._mission(), video)
        self.assertEqual(clip.video_sha256, sha256(content).hexdigest())
        self.assertEqual(clip.video_mime_type, "video/mp4")
        self.assertEqual(clip.verified_by, "Administrator")
        video.reload()
        self.assertTrue(video.is_private)
        self.assertEqual(video.attached_to_doctype, "Muster Evidence Clip")
        self.assertEqual(video.attached_to_name, clip.name)

    def test_public_or_non_video_file_and_secret_receipt_are_rejected(self):
        mission = self._mission()
        with self.assertRaisesRegex(Exception, "private"):
            self._clip(mission, self._video(private=False), status="Draft")
        with self.assertRaisesRegex(Exception, "video/\\*"):
            self._clip(mission, self._video(extension="txt", content=b"plain text"), status="Draft")
        with self.assertRaisesRegex(Exception, "content must match"):
            self._clip(mission, self._video(content=b"renamed text is not video"), status="Draft")
        video = self._video(content=b"\x00\x00\x00\x18ftypisomthird-private-video")
        doc = self._clip(mission, video, status="Draft")
        doc.test_receipt_json = json.dumps({"authorization": "Bearer forbidden"})
        with self.assertRaisesRegex(Exception, "secret-bearing"):
            doc.save()

    def test_verified_record_is_immutable_and_cannot_be_deleted(self):
        clip = self._clip(self._mission(), self._video())
        clip.claim = "Attempted rewrite"
        with self.assertRaisesRegex(Exception, "immutable"):
            clip.save()
        clip.reload()
        with self.assertRaisesRegex(Exception, "cannot be deleted"):
            clip.delete()

    def test_participant_can_read_registry_but_outsider_cannot(self):
        participant = self._user("participant")
        outsider = self._user("outsider")
        mission = self._mission(participant.name)
        clip = self._clip(mission, self._video())
        self.assertTrue(evidence_clip_has_permission(clip, participant.name, "read"))
        self.assertFalse(evidence_clip_has_permission(clip, outsider.name, "read"))
        frappe.set_user(participant.name)
        rows = list_clips(mission=mission.name)["clips"]
        self.assertEqual([row.name for row in rows], [clip.name])
        self.assertEqual(get_clip(clip.name)["video_sha256"], clip.video_sha256)
        frappe.set_user(outsider.name)
        self.assertEqual(list_clips(mission=mission.name)["clips"], [])
