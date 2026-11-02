#!/usr/bin/env bash
set -u

state_dir=/var/lib/static-node-monitor
ok_file="$state_dir/ok"
status_file="$state_dir/last-status"
tmp_file="$state_dir/.health.$$"
failures=()

install -d -o root -g www-data -m 0755 "$state_dir"

if ! systemctl is-active --quiet nginx; then
  failures+=("nginx_inactive")
fi

if ! curl --fail --silent --show-error --max-time 5 \
  --header 'Host: stefanzhang.cn' http://127.0.0.1/ >/dev/null; then
  failures+=("static_site_unreachable")
fi

root_usage=$(df -P / | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
if (( root_usage >= 85 )); then
  failures+=("root_disk_${root_usage}pct")
fi

memory_available_kib=$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)
if (( memory_available_kib < 65536 )); then
  failures+=("memory_available_${memory_available_kib}kib")
fi

if ! swapon --noheadings --show=NAME | grep -q .; then
  failures+=("swap_inactive")
fi

mapfile -t failed_units < <(
  systemctl --failed --no-legend --plain 2>/dev/null |
    awk '$1 != "static-node-health.service" {print $1}'
)
if (( ${#failed_units[@]} > 0 )); then
  failures+=("failed_units_${failed_units[*]}")
fi

timestamp=$(date --iso-8601=seconds)
kernel=$(uname -r)

if (( ${#failures[@]} > 0 )); then
  rm -f "$ok_file"
  printf 'unhealthy timestamp=%s failures=%s\n' "$timestamp" "${failures[*]}" >"$tmp_file"
  install -o root -g www-data -m 0644 "$tmp_file" "$status_file"
  rm -f "$tmp_file"
  logger -t static-node-health "${failures[*]}"
  exit 1
fi

reboot_required=no
if [[ -e /var/run/reboot-required ]]; then
  reboot_required=yes
fi

printf 'ok timestamp=%s kernel=%s root_usage=%s%% memory_available_kib=%s reboot_required=%s\n' \
  "$timestamp" "$kernel" "$root_usage" "$memory_available_kib" "$reboot_required" >"$tmp_file"
install -o root -g www-data -m 0644 "$tmp_file" "$ok_file"
install -o root -g www-data -m 0644 "$tmp_file" "$status_file"
rm -f "$tmp_file"
