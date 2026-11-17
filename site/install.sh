#!/usr/bin/env bash
# Morse installer — https://morse.im
#
#   curl -fsSL https://morse.im/install.sh | bash                                  # your own new address
#
# Another machine of yours: run the first line there too — it gets its own address — then add
# the two to each other as contacts:
#   morse contact add morse.im/<address> --name <remark>
#
# What it does (safe to re-run; it updates in place):
#   1. checks Node.js >= 22 (it never installs Node for you; ADR-084)
#   2. downloads https://morse.im/morse.tgz, checks it against the signed release manifest
#      (version.json + version.json.sig, Ed25519, ADR-039) and runs `npm install -g` on it
#      (the `morse` command). From then on the daemon updates itself from signed releases
#      (turn it off: "update": {"auto": false} in ~/.morse/config.json; by hand: morse update)
#   3. `morse setup` — the morse skill + inbox hooks for Claude Code / Codex; an older
#      install's ~/.anytoany is moved to ~/.morse (~/.anytoany stays as a link to it)
#   4. a computer that has no address yet gets its OWN address (`morse address`; morse.im/<26
#      characters>, derived from a key made here — the one to share; nothing is registered,
#      ADR-091). A computer that has one is only upgraded.
#   5. runs the daemon in the background at login (macOS: launchd talk.morse.daemon;
#      Linux: systemd --user morse.service) — replacing the old dev.anytoany.daemon /
#      anytoany.service of an earlier install
#
# Options (after `bash -s --`):
#   (nothing)             a new address — or, if there is one here already, an upgrade
#   --agent <name>        (kept for compatibility; ignored — ADR-091) the first address needs no name
#   --name <device>       (kept for compatibility; ignored)
#   --relay <url>         relay (default wss://relay.morse.im; env MORSE_RELAY)
#   --site <url>          where morse.tgz lives (default https://morse.im; env MORSE_SITE)
#   --no-join             only install / upgrade: no new address is created
#   --no-service          do not set up the background daemon
#   --dry-run-service     print the launchd plist / systemd unit instead of installing it
#
# Windows: the PowerShell installer instead (ADR-080) —  irm https://morse.im/install.ps1 | iex  (this one works inside WSL2).
set -euo pipefail

SITE="${MORSE_SITE:-https://morse.im}"
DEFAULT_SITE="https://morse.im"
DEFAULT_RELAY="wss://relay.morse.im"
# the release signing key (ADR-039), filled in by scripts/build-site.mjs when the site is built.
# Always the CURRENT key (the one that signed this site's version.json): after a key rotation
# (ADR-041) the next build injects the new key, so this script never walks the rotation chain —
# it comes from the same site as the manifest, so a chain check here would add no trust.
RELEASE_KEY="__MORSE_RELEASE_PUBLIC_KEY__"
RELAY="${MORSE_RELAY:-wss://relay.morse.im}"
ARG=""           # the positional argument as given
NAME=""
AGENT=""
SERVICE=1
JOIN=1
DRY_RUN_SERVICE="${MORSE_DRY_RUN_SERVICE:-0}"
LABEL="talk.morse.daemon"
OLD_LABEL="dev.anytoany.daemon"   # earlier installs (and anytoany's own script): replaced, never two daemons
UNIT="morse.service"
OLD_UNIT="anytoany.service"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:-}"; shift 2 ;;
    --agent) AGENT="${2:-}"; shift 2 ;;
    --code) die "pairing codes are gone (ADR-091): every install gets its own address — run this without --code, then add each other as contacts: morse contact add morse.im/<address> --name <remark>" ;;
    --relay) RELAY="${2:-}"; shift 2 ;;
    --site) SITE="${2:-}"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    --no-join) JOIN=0; shift ;;
    --dry-run-service) DRY_RUN_SERVICE=1; shift ;;
    -h|--help) sed -n '2,32p' "$0" 2>/dev/null || echo "usage: curl -fsSL https://morse.im/install.sh | bash"; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$ARG" ] || die "unexpected argument: $1"; ARG="$1"; shift ;;
  esac
done
SITE="${SITE%/}"
RELAY="${RELAY%/}"
# compatibility (ADR-075): the old domain is retired — a command line or environment that
# still names it means the default site / relay
case "$SITE" in https://morse.talk) SITE="$DEFAULT_SITE" ;; esac
case "$RELAY" in wss://relay.morse.talk) RELAY="$DEFAULT_RELAY" ;; esac

# --- nothing to join (checked BEFORE anything is installed) ------------------------
# (ADR-091) old names, invite codes and pairing codes are gone: every install gets its own address
if [ -n "$ARG" ]; then
  echo "✗ \"$ARG\": old names and invite codes no longer work — every install gets its own address:" >&2
  echo "    1. here:  curl -fsSL $SITE/install.sh | bash" >&2
  echo "    2. then add the others by their 26-character address:  morse contact add morse.im/<address> --name <remark>" >&2
  exit 1
fi

# --- 0. platform ------------------------------------------------------------------
case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux) PLATFORM=linux ;;
  MINGW*|MSYS*|CYGWIN*) die "this is the macOS / Linux installer. On Windows, run this in PowerShell instead:  irm $SITE/install.ps1 | iex   (inside WSL2 this script works as it is)" ;;
  *) die "unsupported system: $(uname -s) (macOS and Linux only)" ;;
esac

# --- 1. Node.js >= 22 (we do not install it for you; ADR-084) ---------------------
# need_node [<found version> [old]] — "old" = a working Node that is older than 22
need_node() {
  echo "✗ Morse needs Node.js 22 or newer${1:+ (found $1)}." >&2
  if [ "${2:-}" = old ]; then
    echo "  Why: Morse's database module (better-sqlite3) no longer ships a ready-made build for" >&2
    echo "  Node.js older than 22, so installing on $1 would have to compile it and fails without a" >&2
    echo "  C++ toolchain; Node.js 20 reached end of life in April 2026." >&2
    echo "  Nothing was changed on this computer. A Morse that is already installed keeps running." >&2
  fi
  if [ "$PLATFORM" = macos ]; then
    echo "  Install Node.js 22 or newer, then run this command again:" >&2
    echo "    brew install node          # with Homebrew (https://brew.sh); already there: brew upgrade node" >&2
    echo "    or the installer from https://nodejs.org (LTS)" >&2
  else
    echo "  Install Node.js 22 or newer, then run this command again — for example with nvm:" >&2
    echo "    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash" >&2
    echo "    nvm install 22" >&2
    echo "  (or your distribution's nodejs package if it is >= 22, or https://nodejs.org)" >&2
  fi
  exit 1
}
command -v node >/dev/null 2>&1 || need_node
# ADR-045: THIS node installs the package (better-sqlite3 is compiled / downloaded for it) and
# runs the daemon — never another `node` or `npm` that happens to be on PATH later
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || need_node "$("$NODE_BIN" --version 2>/dev/null || echo unknown)" old
# the npm that belongs to this node (…/bin/node → …/lib/node_modules/npm), run BY this node
NPM_CLI=""
for d in "$(dirname "$NODE_BIN")" "$(dirname "$("$NODE_BIN" -p 'require("fs").realpathSync(process.execPath)' 2>/dev/null || echo "$NODE_BIN")")"; do
  if [ -f "$d/../lib/node_modules/npm/bin/npm-cli.js" ]; then NPM_CLI="$d/../lib/node_modules/npm/bin/npm-cli.js"; break; fi
done
if [ -n "$NPM_CLI" ]; then
  npm_() { "$NODE_BIN" "$NPM_CLI" "$@"; }
else
  command -v npm >/dev/null 2>&1 || need_node "node without npm"
  npm_() { PATH="$(dirname "$NODE_BIN"):$PATH" npm "$@"; }   # its `#!/usr/bin/env node` → this node
fi
command -v curl >/dev/null 2>&1 || die "curl is required"

# --- 2. the morse package---------------------------------------------------------
TMP="$(mktemp -d "${TMPDIR:-/tmp}/morse-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
say "Downloading Morse from $SITE/morse.tgz …"
curl -fsSL "$SITE/morse.tgz" -o "$TMP/morse.tgz" || die "could not download $SITE/morse.tgz"
# ADR-039: the package must be the one the signed manifest names (node is required anyway)
case "$RELEASE_KEY" in
  __*) ;;   # not built by build-site.mjs (a copy from the repo): nothing to check against
  *)
    if curl -fsSL "$SITE/version.json" -o "$TMP/version.json" 2>/dev/null && curl -fsSL "$SITE/version.json.sig" -o "$TMP/version.json.sig" 2>/dev/null; then
      "$NODE_BIN" -e '
        const [key, mf, sf, tf] = process.argv.slice(1);
        const c = require("crypto"), fs = require("fs");
        const pub = c.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key, "base64")]), format: "der", type: "spki" });
        const bytes = fs.readFileSync(mf);
        const sig = Buffer.from(fs.readFileSync(sf, "utf8").trim(), "base64");
        let ok = false;
        try { ok = c.verify(null, Buffer.concat([Buffer.from("morse-release-v1\n"), bytes]), pub, sig); } catch {}
        if (!ok) { console.error("the release manifest (version.json) is not signed by the Morse release key"); process.exit(1); }
        const m = JSON.parse(bytes.toString("utf8"));
        const sha = c.createHash("sha256").update(fs.readFileSync(tf)).digest("hex");
        if (sha !== m.sha256) { console.error("morse.tgz does not match the signed manifest (sha256 " + sha.slice(0, 16) + "…)"); process.exit(1); }
        console.log("signature OK: " + m.version + " release " + m.release);
      ' "$RELEASE_KEY" "$TMP/version.json" "$TMP/version.json.sig" "$TMP/morse.tgz" || die "refusing to install: the download from $SITE failed the signature check (try again in a minute — the site may be mid-update)"
    else
      echo "⚠ $SITE has no signed release manifest — installing without a signature check" >&2
    fi
    ;;
esac
say "Installing (npm install -g, node $NODE_BIN) …"
npm_ install -g --no-fund --no-audit "$TMP/morse.tgz" || {
  echo "✗ 'npm install -g' failed." >&2
  echo "  If it was a permission error (EACCES), point npm's global prefix at your home — no sudo:" >&2
  echo "    npm config set prefix ~/.npm-global && export PATH=\"\$HOME/.npm-global/bin:\$PATH\"" >&2
  echo "  then run this command again." >&2
  exit 1
}

# ADR-045: the package we just installed, by its real path under the prefix npm installed
# into — not `command -v morse`, which may be some wrapper script or an older install
PKG_NAME="anytoany"
NPM_PREFIX="$(npm_ prefix -g 2>/dev/null)"
[ -n "$NPM_PREFIX" ] || die "installed, but 'npm prefix -g' did not answer"
ENTRY="$NPM_PREFIX/lib/node_modules/$PKG_NAME/dist/cli.js"
[ -f "$ENTRY" ] || die "installed, but $ENTRY is missing"
ENTRY="$("$NODE_BIN" -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$ENTRY")"
morse_() { "$NODE_BIN" "$ENTRY" "$@"; }
# its native module must load in the node that will run it
"$NODE_BIN" -e 'const r = require("module").createRequire(process.argv[1]); new (r("better-sqlite3"))(":memory:").close()' "$ENTRY" 2>"$TMP/abi.log" || {
  cat "$TMP/abi.log" >&2
  die "installed, but its database module does not load in $NODE_BIN ($("$NODE_BIN" --version)) — reinstall with the node you want Morse to use first on PATH"
}
# what a new terminal runs as `morse` (only for the hints at the end)
ON_PATH=1
FOUND="$(command -v morse 2>/dev/null || true)"
if [ -z "$FOUND" ]; then
  ON_PATH=0
elif [ "$("$NODE_BIN" -e 'try{console.log(require("fs").realpathSync(process.argv[1]))}catch{}' "$FOUND")" != "$ENTRY" ]; then
  ON_PATH=2
fi

# --- 3. skill + hooks (+ the ~/.anytoany → ~/.morse move) --------------------------
# An upgrade: stop the old background daemon FIRST, so nothing writes while `morse
# setup` moves its data directory, and launchd / systemd do not restart it mid-move.
OLD_PLIST="$HOME/Library/LaunchAgents/${OLD_LABEL}.plist"
NEW_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
if [ "$SERVICE" = 1 ]; then
  if [ "$PLATFORM" = macos ]; then
    if [ "$DRY_RUN_SERVICE" = 1 ]; then
      [ -f "$OLD_PLIST" ] && echo "[dry-run] would unload the old daemon: launchctl bootout gui/$(id -u)/${OLD_LABEL}; rm $OLD_PLIST"
    else
      launchctl bootout "gui/$(id -u)/${OLD_LABEL}" 2>/dev/null || { [ -f "$OLD_PLIST" ] && launchctl unload "$OLD_PLIST" 2>/dev/null; } || true
      rm -f "$OLD_PLIST"
      launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    fi
  elif command -v systemctl >/dev/null 2>&1; then
    if [ "$DRY_RUN_SERVICE" = 1 ]; then
      [ -f "$UNIT_DIR/$OLD_UNIT" ] && echo "[dry-run] would remove the old daemon: systemctl --user disable --now $OLD_UNIT; rm $UNIT_DIR/$OLD_UNIT"
    elif systemctl --user show-environment >/dev/null 2>&1; then
      systemctl --user disable --now "$OLD_UNIT" 2>/dev/null || true
      rm -f "$UNIT_DIR/$OLD_UNIT"
      systemctl --user stop "$UNIT" 2>/dev/null || true
    fi
  fi
  [ "$DRY_RUN_SERVICE" = 1 ] || morse_ stop >/dev/null 2>&1 || true   # a hand-started daemon
fi
say "Setting up your agents (skill + inbox hooks) …"
morse_ setup
# where the data directory ended up: ~/.morse, or ~/.anytoany if it could not be moved
DATA_DIR="$HOME/.morse"
if [ -d "$HOME/.anytoany" ] && [ ! -L "$HOME/.anytoany" ]; then DATA_DIR="$HOME/.anytoany"; fi
DATA_DIR_SHOWN="~${DATA_DIR#"$HOME"}"
# a (re)install trusts the release key pinned in the build just installed: forget any key this
# computer followed through rotations before (ADR-041 — also the way out after a key compromise)
rm -f "$DATA_DIR/release-key.json"

# (--name / --agent are accepted and ignored: ADR-091 — there is no device name or address name to give at install)
# installed from another site (a mirror, a test site): auto-update from there too (ADR-039).
# morse.im is the default and is not recorded
if [ "$SITE" != "$DEFAULT_SITE" ]; then
  "$NODE_BIN" -e '
    const fs = require("fs"), f = process.argv[1], site = process.argv[2];
    let c = {}; try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    if (!c || typeof c !== "object" || Array.isArray(c)) c = {};
    c.update = Object.assign({}, c.update, { site });
    fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
  ' "$DATA_DIR/config.json" "$SITE" 2>/dev/null || echo "⚠ could not record update.site in $DATA_DIR_SHOWN/config.json" >&2
fi

# --- 4. your address ------------------------------------------------------------------
# Does this computer have an address? Read from config.json (the list of its addresses) — never asked of a morse
# command: `morse address` CREATES one on a computer that has none, which would happen behind --no-join's back
has_address() { "$NODE_BIN" -e 'try{const c=require(process.argv[1]);process.stdout.write(c.relay&&Array.isArray(c.relay.agents)&&c.relay.agents.length?"1":"")}catch{}' "$DATA_DIR/config.json" 2>/dev/null || true; }
# the address to share: the first line of `morse address` is "address: morse.im/<26 characters>   <name>"
current_address() { morse_ address 2>/dev/null | awk '/^address:/ {print $2; exit}' || true; }
if [ "$JOIN" = 1 ] && [ -z "$(has_address)" ]; then
  # (ADR-091) made here, from a key made here — nothing is registered with the relay
  say "Making your Morse address …"
  morse_ address >/dev/null || die "could not make your address (see above). Morse is installed — retry: morse address"
fi
ADDRESS=""
# only on a computer that has one: `morse address` would create an address otherwise
if [ -n "$(has_address)" ]; then ADDRESS="$(current_address)"; fi

# --- 5. background daemon ---------------------------------------------------------
# the daemon may spawn claude / codex / kimi: bake their directories into its PATH
DAEMON_PATH="$(
  { dirname "$NODE_BIN"; printf '%s\n' "$NPM_PREFIX/bin"
    for b in claude codex kimi; do p="$(command -v "$b" 2>/dev/null || true)"; [ -n "$p" ] && dirname "$p"; done
    printf '%s\n' /usr/local/bin /usr/bin /bin /usr/sbin /sbin
  } | awk 'NF && !seen[$0]++' | paste -sd: -
)"

# ExitTimeOut / KillMode / TimeoutStopSec (ADR-089): a stop first lets the daemon finish in its own orderly way —
# its plugins let a running agent turn end (up to 15 s). launchd otherwise sends SIGKILL 5 s after SIGTERM (its
# default, measured); systemd otherwise signals every process of the unit at once, the agent's turn included
# (KillMode=mixed: SIGTERM to the daemon only, SIGKILL to whatever is left once it has stopped).
plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${ENTRY}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${DAEMON_PATH}</string>
    <key>HOME</key><string>${HOME}</string>
  </dict>
  <key>WorkingDirectory</key><string>${HOME}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>StandardOutPath</key><string>${DATA_DIR}/daemon.log</string>
  <key>StandardErrorPath</key><string>${DATA_DIR}/daemon.log</string>
</dict>
</plist>
PLIST
}

unit() {
  cat <<UNIT
[Unit]
Description=Morse daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="${NODE_BIN}" "${ENTRY}" start
Environment="PATH=${DAEMON_PATH}"
WorkingDirectory=${HOME}
Restart=always
RestartSec=10
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
}

# ADR-045: after (re)loading the service, make sure the daemon really runs — a service that
# points at the wrong file starts, dies, and is restarted forever without anyone noticing
daemon_pid() { morse_ status 2>/dev/null | sed -n 's/^daemon: running (pid \([0-9][0-9]*\)).*/\1/p'; }
daemon_up() {
  local pid="" again
  for _ in $(seq 1 20); do pid="$(daemon_pid)"; [ -n "$pid" ] && break; sleep 1; done
  [ -n "$pid" ] || return 1
  sleep 3   # still the same process a moment later = not a crash loop
  again="$(daemon_pid)"
  [ "$again" = "$pid" ]
}
daemon_failed() {
  echo "✗ the background daemon did not start ($1)." >&2
  echo "  It runs: $NODE_BIN $ENTRY start" >&2
  if [ -f "$DATA_DIR/daemon.log" ]; then echo "  Last lines of $DATA_DIR_SHOWN/daemon.log:" >&2; tail -n 15 "$DATA_DIR/daemon.log" | sed 's/^/    /' >&2; fi
  SERVICE_FAILED=1
}
SERVICE_FAILED=0
SERVICE_NOTE=""
if [ "$SERVICE" = 1 ]; then
  if [ "$PLATFORM" = macos ]; then
    PLIST_PATH="$NEW_PLIST"
    if [ "$DRY_RUN_SERVICE" = 1 ]; then
      say "[dry-run] would write $PLIST_PATH:"
      plist
      echo "[dry-run] would run: morse stop; launchctl bootout gui/$(id -u)/${OLD_LABEL} (old label, if loaded); launchctl bootout gui/$(id -u)/${LABEL}; launchctl bootstrap gui/$(id -u) $PLIST_PATH"
      SERVICE_NOTE="(dry run — nothing installed; start it yourself: morse start)"
    else
      say "Starting the daemon at login (launchd: $LABEL) …"
      mkdir -p "$HOME/Library/LaunchAgents" "$DATA_DIR"
      plist >"$PLIST_PATH"
      plutil -lint "$PLIST_PATH" >/dev/null
      morse_ stop >/dev/null 2>&1 || true    # a hand-started daemon would hold the port
      launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null || true
      # bootstrap right after bootout often fails with "5: Input/output error" while
      # launchd is still tearing the old job down — retry for a few seconds.
      LOADED=0
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        if launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null; then LOADED=1; break; fi
        launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 && { LOADED=1; break; }
        sleep 1
      done
      [ "$LOADED" = 1 ] || launchctl load -w "$PLIST_PATH" 2>/dev/null || true
      if ! launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
        SERVICE_NOTE="⚠ could not load the background daemon — run: launchctl bootstrap gui/$(id -u) $PLIST_PATH"
      elif daemon_up; then
        SERVICE_NOTE="daemon: running in the background, starts at login (log: ${DATA_DIR_SHOWN}/daemon.log)"
      else
        daemon_failed "launchd: $LABEL"
        SERVICE_NOTE="✗ the daemon is not running — see above; after fixing it: morse stop --restart"
      fi
    fi
  else
    if [ "$DRY_RUN_SERVICE" = 1 ]; then
      say "[dry-run] would write $UNIT_DIR/$UNIT:"
      unit
      echo "[dry-run] would run: systemctl --user disable --now $OLD_UNIT (old unit, if any); systemctl --user daemon-reload && systemctl --user enable --now $UNIT"
      SERVICE_NOTE="(dry run — nothing installed; start it yourself: morse start)"
    elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
      say "Starting the daemon at login (systemd --user: $UNIT) …"
      mkdir -p "$UNIT_DIR"
      unit >"$UNIT_DIR/$UNIT"
      morse_ stop >/dev/null 2>&1 || true
      systemctl --user daemon-reload
      systemctl --user enable --now "$UNIT"
      systemctl --user restart "$UNIT"
      if daemon_up; then
        SERVICE_NOTE="daemon: running (systemctl --user status morse). To keep it running while logged out: loginctl enable-linger \$USER"
      else
        daemon_failed "systemd --user: $UNIT"
        SERVICE_NOTE="✗ the daemon is not running — see above and: journalctl --user -u $UNIT"
      fi
    else
      SERVICE_NOTE="no systemd --user here — start the daemon yourself: morse start   (e.g. nohup morse start >~/.morse/daemon.log 2>&1 &)"
    fi
  fi
else
  SERVICE_NOTE="start the daemon: morse start"
fi

# --- done -------------------------------------------------------------------------
echo
say "✓ Morse is installed."
if [ -n "$(has_address)" ]; then
  if [ -n "$ADDRESS" ]; then
    echo "  Your address: $ADDRESS — send it to your friends."
  else
    echo "  Your address: run  morse address  to see it — that is the one to send to your friends."
  fi
  echo "  Your address any time: morse address"
  echo "  Name your contacts (Morse has no nicknames): morse contact add morse.im/<address> --name <remark>"
  echo "  A separate, second address here (only if you want one): morse address add <name>"
  echo "  Another machine of yours: install Morse there too — it gets its own address — then add each other as contacts (morse contact add morse.im/<address> --name <remark>)."
  echo "  Try telling your agent: \"use Morse to send a line to morse.im/<their-address>\""
else
  echo "  No address yet: run  morse address  to get your own."
fi
echo "  Receive: morse read · Send: morse send morse.im/<address> \"…\" · Your addresses: morse address"
echo "  Note: a stranger's first message goes to your message requests, not your inbox — they are added only"
echo "        when you accept: morse contact · morse contact accept <address> · morse contact block <address>"
echo "  Note: the daemon keeps ~/.claude/agents/any-*.md in sync with your local agent sessions, so Claude Code can @-mention them."
echo "  $SERVICE_NOTE"
echo "  Updates: the daemon installs new signed releases by itself (morse update to do it now; morse status shows the last check)."
if [ "$ON_PATH" -eq 0 ]; then
  echo "  ⚠ add npm's global bin to PATH so 'morse' works in new terminals:"
  echo "      export PATH=\"$NPM_PREFIX/bin:\$PATH\""
elif [ "$ON_PATH" -eq 2 ]; then
  echo "  ⚠ 'morse' in your PATH is $FOUND — not the one just installed ($NPM_PREFIX/bin/morse); the daemon and hooks use the new one"
fi
[ "$SERVICE_FAILED" = 0 ] || exit 1
