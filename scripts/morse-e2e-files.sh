#!/usr/bin/env bash
# Large files in chunks (ADR-038) on ONE machine, fully isolated:
#   - the Cloudflare relay under `wrangler dev` (local workerd + simulated KV / Durable
#     Objects, the real 1,000,000-byte envelope cap and 120/min per-device rate; its own
#     HOME and XDG_CONFIG_HOME in a temp dir — the real wrangler login is never read,
#     nothing is deployed);
#   - every computer is a throw-away HOME (HOME=MORSE_HOME=<tmp>) with its own ports.
# Part A, through the relay (--no-lan): alice → bob 1 MB, 10 MB, 50 MB of random bytes —
#   SHA-256 identical, 0600, one message each, time taken; then a 30 MB transfer during
#   which bob's daemon is killed and started again → it resumes (bob logs one "receiving"
#   line, alice sends far fewer than 2× the chunks) and completes.
# Part B, over the LAN (real mDNS, device names e2e-files-*): mei's mini → her air, 10 MB.
# Processes are stopped by the PIDs this script recorded (never by name); at the end no
# test process or listener may be left. Never touches the real HOME, ~/Library/LaunchAgents,
# launchd, or relay.morse.im / relay.morse.talk.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$PWD
CLI="node $REPO/dist/cli.js"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/morse-e2e-files.XXXXXX")
RELAY_PORT=${RELAY_PORT:-18961}
RELAY=ws://127.0.0.1:$RELAY_PORT
ADMIN=e2e-admin-$RANDOM$RANDOM
TAG=$RANDOM
WRANGLER=$REPO/relay-cf/node_modules/.bin/wrangler
HADM=$ROOT/admin HA=$ROOT/alice HB=$ROOT/bob HM=$ROOT/mei-mini HAIR=$ROOT/mei-air
mkdir -p "$HADM" "$HA" "$HB" "$HM" "$HAIR" "$ROOT/wrangler-home/xdg" "$ROOT/cf-state" "$ROOT/src"
PA=17961 PB=17971 PM=17981 PAIR=17991
PORTS=("$RELAY_PORT" $PA $((PA + 1)) $PB $((PB + 1)) $PM $((PM + 1)) $PAIR $((PAIR + 1)))
PIDS=()
RELAY_PID=
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  if [ -n "$RELAY_PID" ]; then
    kill -TERM "$RELAY_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do lsof -ti "tcp:$RELAY_PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.2; done
    # whatever still listens on OUR relay port is our workerd
    local pids; pids=$(lsof -ti "tcp:$RELAY_PORT" -sTCP:LISTEN 2>/dev/null || true); [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}
trap cleanup EXIT

as() { local h=$1; shift; HOME=$h MORSE_HOME=$h ANYTOANY_HOME=$h $CLI "$@"; }
pass() { echo "  PASS: $*"; }
fail() { echo "  FAIL: $*"; echo "  (logs in $ROOT)"; exit 1; }
wait_for() { local t=$1; shift; for _ in $(seq 1 $((t * 5))); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 0.2; done; return 1; }
now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
start_daemon() { # start_daemon <home> <port> <log> [extra args] → pid in <home>/e2e-daemon.pid
  local h=$1 port=$2 log=$3; shift 3
  for p in "$port" "$((port + 1))"; do lsof -ti "tcp:$p" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $p is in use"; done
  HOME=$h MORSE_HOME=$h ANYTOANY_HOME=$h $CLI start --no-notify --port "$port" "$@" >>"$log" 2>&1 &
  PIDS+=($!)
  echo $! >"$h/e2e-daemon.pid" # this test daemon only (never `morse stop`: it may find a real one)
}
kill_daemon() { # kill_daemon <home> <port> [signal]
  kill "-${3:-TERM}" "$(cat "$1/e2e-daemon.pid")" 2>/dev/null || true
  for _ in $(seq 1 50); do lsof -ti "tcp:$2" -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 0.2; done
  fail "the test daemon on port $2 did not stop"
}
invite() { HOME=$HADM MORSE_HOME=$HADM MORSE_ADMIN_KEY=$ADMIN $CLI invite "$@" --relay "$RELAY"; }
code_of() { awk '/^code:/{print $2}'; }
config() { # fast outbox retries; strangers accept (this script is not about message requests)
  mkdir -p "$1/.morse"; python3 - "$1/.morse/config.json" <<'PY'
import json,sys; p=sys.argv[1]
try: c=json.load(open(p))
except FileNotFoundError: c={}
c['outbox']={'retryIntervalSec':3,'maxWaitDays':30}
c.setdefault('morse',{})['strangers']='accept'; c.setdefault('plugins',{}).setdefault('attendant',{})['enabled']=False  # ADR-066: no real agent answers in e2e
json.dump(c,open(p,'w'),indent=2)
PY
}
random_file() { python3 -c "import os,sys; open(sys.argv[1],'wb').write(os.urandom(int(sys.argv[2])))" "$1" "$2"; }
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
# the received copy of <name> under <home>'s inbox files
received() { ls "$1"/.morse/inbox-files/*/"$2" 2>/dev/null | head -1; }
check_file() { # check_file <home> <src> <name>
  local f; f=$(received "$1" "$3")
  [ -n "$f" ] || fail "$3 did not arrive"
  [ "$(sha "$2")" = "$(sha "$f")" ] || fail "$3: SHA-256 differs"
  [ "$(stat -f %Lp "$f")" = "600" ] || fail "$3: mode is not 0600"
  [ -x "$f" ] && fail "$3 is executable"
  echo "   $3: $(stat -f %z "$f") bytes, sha256 $(sha "$f" | cut -c1-16)… identical, 0600 → ${f#$1/}"
}

echo "== setup in $ROOT"
npm run build >/dev/null
test -x "$WRANGLER" || (cd relay-cf && npm install --no-audit --no-fund >/dev/null)
lsof -ti "tcp:$RELAY_PORT" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $RELAY_PORT is in use (set RELAY_PORT)"
(cd relay-cf && exec env HOME="$ROOT/wrangler-home" XDG_CONFIG_HOME="$ROOT/wrangler-home/xdg" WRANGLER_SEND_METRICS=false CLOUDFLARE_API_TOKEN= CLOUDFLARE_ACCOUNT_ID= \
  "$WRANGLER" dev --port "$RELAY_PORT" --inspector-port 0 --persist-to "$ROOT/cf-state" --log-level info --var "ADMIN_KEY:$ADMIN" >"$ROOT/relay.log" 2>&1) &
RELAY_PID=$!
wait_for 60 curl -sf "http://127.0.0.1:$RELAY_PORT/healthz" || fail "relay did not come up (see $ROOT/relay.log)"
pass "relay up (wrangler dev, own HOME / XDG_CONFIG_HOME, pid $RELAY_PID)"

echo "== A. through the relay (--no-lan)"
CA=$(invite create alice | code_of)
CB=$(invite create bob | code_of)
as "$HA" join "$CA" --relay "$RELAY" --name "e2e-files-alice-$TAG" --agent alice-mini | sed 's/^/   alice: /'
as "$HB" join "$CB" --relay "$RELAY" --name "e2e-files-bob-$TAG" --agent bob-mini | sed 's/^/   bob:   /'
config "$HA"; config "$HB"
start_daemon "$HA" $PA "$ROOT/alice.log" --no-lan
start_daemon "$HB" $PB "$ROOT/bob.log" --no-lan
for l in alice bob; do wait_for 20 grep -q "relay: connected" "$ROOT/$l.log" || fail "$l did not connect"; done
as "$HA" pair add morse.talk/bob --relay "$RELAY" >/dev/null
as "$HB" pair add morse.im/alice --relay "$RELAY" >/dev/null
pass "alice and bob paired (peer)"

for size in 1 10 50; do
  NAME=f${size}m.bin
  random_file "$ROOT/src/$NAME" $((size * 1024 * 1024))
  T0=$(now)
  OUT=$(as "$HA" send morse.im/bob "file $NAME" --file "$ROOT/src/$NAME" --port $PA)
  echo "$OUT" | sed 's/^/   /'
  echo "$OUT" | grep -q '^delivered' || fail "$NAME: send did not report delivered"
  T1=$(now)
  check_file "$HB" "$ROOT/src/$NAME" "$NAME"
  SECS=$(python3 -c "print(f'{$T1-$T0:.1f}')")
  echo "$size MB $SECS s" >>"$ROOT/timings.txt"
  pass "$size MB through the relay in $SECS s (send → recipient's receipt)"
done
grep "delivered via relay" "$ROOT/alice.log" | sed 's/^/   alice.log: /'
N=$(HOME=$HB MORSE_HOME=$HB $CLI inbox --all --json | python3 -c "import json,sys; print(sum(1 for m in json.load(sys.stdin) if m['parts'][0]['text'].startswith('file f')))")
[ "$N" = 3 ] || fail "bob has $N file messages, expected 3"
as "$HB" inbox --all | grep -A3 "file f10m" | sed 's/^/   bob inbox: /'
pass "bob: exactly one message per file, text and file together"

echo "== A2. bob's daemon is killed mid-transfer (30 MB) and started again → resumes"
random_file "$ROOT/src/resume.bin" $((30 * 1024 * 1024))
T0=$(now)
MID=$(as "$HA" send morse.im/bob "resume test" --file "$ROOT/src/resume.bin" --port $PA --no-wait | awk '/^queued/{print $2}')
receiving() { as "$HB" inbox | awk '/^receiving/{split($2,a,"/"); print a[1]}' | head -1; }
for _ in $(seq 1 300); do H=$(receiving); [ -n "$H" ] && [ "$H" -ge 15 ] && break; sleep 0.2; done
[ -n "$H" ] && [ "$H" -ge 15 ] || fail "no progress on bob's side"
as "$HB" inbox | grep '^receiving' | sed 's/^/   bob (before kill): /'
kill_daemon "$HB" $PB KILL
HELD=$(receiving)
echo "   bob killed (SIGKILL) holding $HELD chunks"
wait_for 30 grep -Eq "${MID:0:8} → morse.im/bob.*(offline|will try again|closed)" "$ROOT/alice.log" || fail "alice did not notice bob going away"
grep "${MID:0:8}" "$ROOT/alice.log" | tail -1 | sed 's/^/   alice.log: /'
as "$HB" inbox | grep '^receiving' | sed 's/^/   bob (daemon down): /'
sleep 3
start_daemon "$HB" $PB "$ROOT/bob2.log" --no-lan
wait_for 20 grep -q "relay: connected" "$ROOT/bob2.log" || fail "bob did not reconnect"
wait_for 180 sh -c "ls $HB/.morse/inbox-files/*/resume.bin" || fail "resume.bin did not arrive after the restart"
wait_for 30 grep -q "${MID:0:8} → morse.im/bob.* delivered via relay" "$ROOT/alice.log" || fail "alice has no receipt for the resumed transfer"
T1=$(now)
check_file "$HB" "$ROOT/src/resume.bin" resume.bin
grep "${MID:0:8}" "$ROOT/alice.log" | sed 's/^/   alice.log: /'
grep "${MID:0:8}" "$ROOT/bob.log" "$ROOT/bob2.log" | sed "s#$ROOT/##; s/^/   /"
grep -q "receiving ${MID:0:8}" "$ROOT/bob2.log" && fail "bob started the transfer over instead of resuming"
SENT=$(grep "${MID:0:8} → morse.im/bob.* delivered via relay" "$ROOT/alice.log" | sed -E 's/.*, ([0-9]+) chunk envelope.*/\1/' | tail -1)
[ "$SENT" -lt 120 ] || fail "alice sent $SENT chunk envelopes for 60 chunks (not resumed)"
echo "30 MB (bob killed + restarted) $(python3 -c "print(f'{$T1-$T0:.1f}')") s, $SENT envelopes for 60 chunks" >>"$ROOT/timings.txt"
as "$HB" inbox | grep -c '^receiving' >/dev/null && fail "bob still shows a transfer in progress"
pass "resumed after the recipient restart: $SENT chunk envelopes for 60 chunks, file identical"
kill_daemon "$HA" $PA; kill_daemon "$HB" $PB

echo "== B. over the LAN (real mDNS; names e2e-files-mini-$TAG / e2e-files-air-$TAG)"
CY=$(invite create mei --uses 2 | code_of)
as "$HM" join "$CY" --relay "$RELAY" --name "e2e-files-mini-$TAG" --agent mini | sed 's/^/   mini: /'
as "$HAIR" join "$CY" --relay "$RELAY" --name "e2e-files-air-$TAG" --agent air | sed 's/^/   air:  /'
config "$HM"; config "$HAIR"
start_daemon "$HM" $PM "$ROOT/mini.log"
start_daemon "$HAIR" $PAIR "$ROOT/air.log"
for l in mini air; do wait_for 20 grep -q "relay: connected" "$ROOT/$l.log" || fail "$l did not connect"; done
wait_for 30 sh -c "HOME=$HM MORSE_HOME=$HM $CLI peers --port $PM | grep -q 'e2e-files-air-$TAG'" || fail "mini did not discover air over mDNS"
# a first small message pairs the two (owner, same handle) over the LAN
as "$HM" send morse.im/mei/air "hello air" --port $PM >/dev/null
wait_for 25 sh -c "HOME=$HAIR MORSE_HOME=$HAIR $CLI inbox --json | grep -q 'hello air'" || fail "first message did not reach air"
random_file "$ROOT/src/lan10m.bin" $((10 * 1024 * 1024))
T0=$(now)
OUT=$(as "$HM" send morse.im/mei/air "lan file" --file "$ROOT/src/lan10m.bin" --port $PM)
T1=$(now)
echo "$OUT" | sed 's/^/   /'
echo "$OUT" | grep -q '^delivered.*via lan' || fail "the 10 MB file did not go via lan"
check_file "$HAIR" "$ROOT/src/lan10m.bin" lan10m.bin
grep "lan10m\|via lan —" "$ROOT/mini.log" | grep -v "^$" | tail -2 | sed 's/^/   mini.log: /'
echo "10 MB over the LAN $(python3 -c "print(f'{$T1-$T0:.1f}')") s" >>"$ROOT/timings.txt"
pass "10 MB over the LAN (mutual TLS, chunked), identical"

echo "== timings"; sed 's/^/   /' "$ROOT/timings.txt"
echo "== stop every test process (by recorded pid)"
cleanup
trap - EXIT
sleep 1
for p in "${PIDS[@]}" "$RELAY_PID"; do kill -0 "$p" 2>/dev/null && fail "test process $p is still running"; done
for p in "${PORTS[@]}"; do lsof -ti "tcp:$p" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $p still has a listener"; done
pass "no test process or listener left"
echo "== ALL CHECKS PASSED (logs in $ROOT)"
