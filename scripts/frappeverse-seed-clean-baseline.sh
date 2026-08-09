#!/usr/bin/env bash
set -euo pipefail

bench_dir="${BENCH_DIR:-/home/goblin/frappeverse/frappeverse-demo-v16}"
site="${SITE_NAME:-frappeverse.local}"

cd "${bench_dir}"
bench --site "${site}" execute muster.demo.frappeverse_baseline.seed --kwargs '{"confirm": True}'
