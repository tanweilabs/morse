#!/usr/bin/env bash
# Developer helper (macOS): run the Morse daemon of a globally linked checkout as a launchd
# LaunchAgent, so it comes up at login and is started again whenever it exits.
#
# Users don't need this — the installer (site/install.sh) sets the same job up. It is for a
# machine that runs Morse from source (`npm link`), where nothing else keeps the daemon alive:
# a daemon tied to a terminal stops with it, and queued messages then sit undelivered.
#
# Safe to run again: the plist is written fresh and the job reloaded every time.
# Undo:  launchctl unload ~/Library/LaunchAgents/talk.morse.daemon.plist
#        rm ~/Library/LaunchAgents/talk.morse.daemon.plist
# The job label before ADR-035 was dev.anytoany.daemon; that job is removed on the way.
set -euo pipefail

readonly JOB=talk.morse.daemon
readonly LEGACY_JOB=dev.anytoany.daemon
readonly AGENTS_DIR="$HOME/Library/LaunchAgents"
readonly PLIST_FILE="$AGENTS_DIR/$JOB.plist"

die() { echo "$*" >&2; exit 1; }

# The CLI shim on PATH: `morse`, or `anyd` (its old name) on older links.
find_cli() {
  local name
  for name in morse anyd; do
    if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  done
  die "neither morse nor anyd is on PATH — link the checkout first (npm link)"
}

# launchd gives a job almost no PATH, but the daemon starts the agent CLIs to deliver
# (claude, codex, kimi …). Collect the directories they are in on this machine.
delivery_path() {
  local bin
  {
    dirname "$NODE_BIN"
    for bin in claude codex kimi morse anyd; do
      command -v "$bin" >/dev/null 2>&1 && dirname "$(command -v "$bin")"
    done
    printf '%s\n' /usr/bin /bin /usr/sbin /sbin
  } | awk 'NF && !seen[$0]++' | paste -sd: -
}

# Where the daemon logs: ~/.morse, unless a not-yet-moved ~/.anytoany is still the live data dir.
log_file() {
  if [ -d "$HOME/.anytoany" ] && [ ! -L "$HOME/.anytoany" ]; then
    echo "$HOME/.anytoany/daemon.log"
  else
    echo "$HOME/.morse/daemon.log"
  fi
}

write_plist() {
  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$JOB</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$CLI_ENTRY</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$JOB_PATH</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST_FILE" >/dev/null
}

NODE_BIN="$(command -v node)" || die "node not found on PATH"
CLI_SHIM="$(find_cli)"
# launchd runs node on the real dist/cli.js, not on the symlinked shim
CLI_ENTRY="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$CLI_SHIM")"
JOB_PATH="$(delivery_path)"
cli() { "$CLI_SHIM" "$@"; }

# 1. Nothing may write while `setup` moves ~/.anytoany to ~/.morse (ADR-035): drop the old
#    job, stop a daemon started by hand, then run setup.
launchctl unload "$AGENTS_DIR/$LEGACY_JOB.plist" 2>/dev/null || true
rm -f "$AGENTS_DIR/$LEGACY_JOB.plist"
cli stop >/dev/null 2>&1 || true
cli setup >/dev/null

# 2. The job definition.
LOG_FILE="$(log_file)"
mkdir -p "$AGENTS_DIR" "$(dirname "$LOG_FILE")"
write_plist

# 3. (Re)load it; a daemon still running by hand would hold the port, so stop that first.
cli stop >/dev/null 2>&1 || true
sleep 1
launchctl unload "$PLIST_FILE" 2>/dev/null || true
launchctl load "$PLIST_FILE"
sleep 5

echo "Installed $JOB. PATH baked for delivery: $JOB_PATH"
launchctl list | grep "$JOB" || die "WARNING: $JOB is not registered with launchd"
cli status | head -1
