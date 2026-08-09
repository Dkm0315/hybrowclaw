#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
out_dir="$repo_dir/outputs"
final="$out_dir/muster-frappeverse-live-evidence-2026-07-20.mp4"
font="/System/Library/Fonts/Supplemental/Arial.ttf"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/muster-frappeverse-video-XXXXXX")"
mkdir -p "$out_dir"

common_video=(
  -r 30 -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p
  -c:a aac -b:a 128k -ar 48000 -ac 2 -movflags +faststart
)

title_segment() {
  local index="$1" duration="$2" title="$3" subtitle="$4"
  local card="$build_dir/$index-card.png"
  magick -size 1280x720 canvas:'#101014' \
    \( "$repo_dir/output/evidence/final/muster-logo-current.png" -resize 300x90 \) \
    -geometry +70+48 -composite \
    \( "$repo_dir/output/evidence/final/hybrowlabs-logo.png" -resize 130x130 \) \
    -geometry +1080+34 -composite \
    -font "$font" -fill white -pointsize 52 -annotate +80+290 "$title" \
    -fill '#C8C3D3' -pointsize 26 -annotate +82+350 "$subtitle" "$card"
  ffmpeg -hide_banner -loglevel error -y \
    -loop 1 -framerate 30 -i "$card" \
    -f lavfi -i "anullsrc=r=48000:cl=stereo:d=$duration" \
    -t "$duration" "${common_video[@]}" "$build_dir/$index.mp4"
}

video_segment() {
  local index="$1" source="$2" duration="$3" label="$4"
  local overlay="$build_dir/$index-overlay.png"
  magick -size 1280x720 canvas:none -fill 'rgba(0,0,0,0.82)' \
    -draw 'rectangle 0,0 1280,58' -font "$font" -fill white -pointsize 25 \
    -annotate +34+38 "$label" "$overlay"
  ffmpeg -hide_banner -loglevel error -y \
    -i "$source" -loop 1 -i "$overlay" -f lavfi -i "anullsrc=r=48000:cl=stereo:d=$duration" \
    -filter_complex "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0xF7F6F9[base];[base][1:v]overlay=0:0[v]" \
    -map "[v]" -map 2:a -t "$duration" "${common_video[@]}" "$build_dir/$index.mp4"
}

video_segment_plain() {
  local index="$1" source="$2" duration="$3"
  ffmpeg -hide_banner -loglevel error -y \
    -i "$source" -f lavfi -i "anullsrc=r=48000:cl=stereo:d=$duration" \
    -filter_complex "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0xF7F6F9[v]" \
    -map "[v]" -map 1:a -t "$duration" "${common_video[@]}" "$build_dir/$index.mp4"
}

still_segment() {
  local index="$1" source="$2" duration="$3" label="$4" explanation="$5"
  local card="$build_dir/$index-card.png"
  magick "$source" -resize '1280x602>' -gravity center -background '#F7F6F9' \
    -extent 1280x602 -gravity south -splice 0x60 -gravity north -splice 0x58 \
    -fill 'rgba(0,0,0,0.86)' -draw 'rectangle 0,0 1280,58' \
    -fill '#6D28D9' -draw 'rectangle 0,660 1280,720' \
    -font "$font" -fill white -pointsize 25 -annotate +34+38 "$label" \
    -pointsize 22 -annotate +34+700 "$explanation" "$card"
  ffmpeg -hide_banner -loglevel error -y \
    -loop 1 -framerate 30 -i "$card" -f lavfi -i "anullsrc=r=48000:cl=stereo:d=$duration" \
    -map 0:v -map 1:a -t "$duration" "${common_video[@]}" "$build_dir/$index.mp4"
}

title_segment 00 8 "Muster for Frappe" "Verified native operation on a real Frappe v16 estate"
linking_duration="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$repo_dir/docs/assets/muster-frappe-linking-demo.mp4")"
video_segment 01 "$repo_dir/docs/assets/muster-frappe-linking-demo.mp4" "$linking_duration" "1  Direct Frappe linking  reciprocal trust verified"
title_segment 02 6 "The AI works in the interface" "Prompt  native form  human pause  independent verification"
ai_create="$repo_dir/output/evidence/final/native-ai-create-administrator-20260720/db0b61aea683525255f74f1bc4f13591.webm"
ai_create_duration="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$ai_create")"
video_segment_plain 03 "$ai_create" "$ai_create_duration"
still_segment 04 "$repo_dir/output/frappeverse/field-ops-native-pause-20260720.png" 12 "3  Custom Vue app  native Create pause" "Muster opens and fills the untouched app form, then waits before Create"
still_segment 05 "$repo_dir/output/evidence/native-update-paused-20260720.png" 12 "4  Exact-record update  maker checker pause" "The reviewed revision is bound to an independent approver before Save"
still_segment 06 "$repo_dir/output/evidence/native-update-verified-20260720.png" 12 "5  Update result  permission-visible reread" "The saved record is reread through the initiating Frappe users authority"
still_segment 07 "$repo_dir/output/evidence/native-delete-paused-20260720.png" 12 "6  Destructive action  typed record confirmation" "Delete stays one-use, revision-bound and visibly paused at the native boundary"
still_segment 08 "$repo_dir/output/evidence/native-delete-verified-20260720.png" 12 "7  Delete result  absence verified" "Muster verifies the record no longer exists and seals the evidence receipt"
still_segment 09 "$repo_dir/output/evidence/helpdesk-native-attended-preview-20260720.png" 12 "8  Frappe Helpdesk  native ticket preview" "The same Ask surface follows the user into Helpdesk without forking its UI"
title_segment 10 6 "RBAC is demonstrated, not assumed" "Different users  different modules  allow and deny evidence"
video_segment 11 "$repo_dir/output/evidence/videos/CRM-01-lead-rbac-desktop-hd.webm" 57.36 "9  CRM lead visibility  allowed and denied"
video_segment 12 "$repo_dir/output/evidence/videos/ERP-01-sales-customer-rbac-desktop.webm" 114.64 "10  ERPNext customer access  territory and role boundaries"
video_segment 13 "$repo_dir/output/evidence/videos/HRM-01-employee-rbac-desktop-hd.webm" 57.72 "11  HRMS employee visibility  permission boundary"
video_segment 14 "$repo_dir/output/evidence/videos/MUS-01-mission-approval-rbac-desktop.webm" 72.44 "12  Muster mission approval  maker checker RBAC"
video_segment 15 "$repo_dir/output/evidence/videos/CRM-02-lead-rbac-mobile.webm" 65.56 "13  Mobile CRM  the same permission model"
still_segment 16 "$repo_dir/output/evidence/final/lifecycle-orm-verified.png" 12 "14  Native update with Frappe lifecycle automation" "The form reflects the reviewed change and the idempotent server-side enrichment"
title_segment 17 12 "Frappe stays in control" "Native UI  live RBAC  exact approvals  independent receipts"

list="$build_dir/concat.txt"
for index in $(seq 0 17); do
  printf -v padded "%02d" "$index"
  printf "file '%s/%s.mp4'\n" "$build_dir" "$padded" >> "$list"
done

ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$list" -c copy "$final"
printf '%s\n' "$final"
