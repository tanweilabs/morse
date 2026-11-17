# Morse installer for Windows - https://morse.im
#
#   irm https://morse.im/install.ps1 | iex
#
# With options ("iex" cannot pass arguments - use a script block, or environment variables):
#   & ([scriptblock]::Create((irm https://morse.im/install.ps1))) -NoService
#   $env:MORSE_NO_SERVICE = '1'; irm https://morse.im/install.ps1 | iex
#
# What it does (safe to re-run; it updates in place). No administrator rights are needed.
#   1. checks Node.js >= 22 (it never installs Node for you)
#   2. downloads morse.tgz and checks it against the signed release manifest (version.json +
#      version.json.sig, Ed25519 - the same check install.sh does). Anything that does not
#      pass is NOT installed; there is no way to skip the check. Then a running Morse daemon
#      is stopped and the package installed with "npm install -g" (the "morse" command)
#   3. "morse setup" - the morse skill + inbox hooks for Claude Code / Codex
#   4. a computer that has no address yet gets its OWN address ("morse address": made here from
#      a key made here, nothing registered - ADR-091). A computer that has one is only upgraded
#   5. starts the daemon now and at every logon (a scheduled task of your user; the "Run"
#      registry value if Windows refuses the task). Logging off stops it - the relay keeps
#      your mail meanwhile
#
# Parameters (or the environment variable, for "irm | iex"):
#   -Agent <name>     MORSE_AGENT         (kept for compatibility; ignored - ADR-091)
#   -Name <device>    MORSE_NAME          (kept for compatibility; ignored)
#   -Relay <url>      MORSE_RELAY         relay (default wss://relay.morse.im)
#   -Site <url>       MORSE_SITE          where morse.tgz lives (default https://morse.im)
#   -NoJoin           MORSE_NO_JOIN=1     only install / upgrade: no new address is created
#   -NoService        MORSE_NO_SERVICE=1  do not start the daemon or register the logon start
#
# Windows 11 x64 (ADR-080). This release is pull-only on Windows: a message reaches an agent
# at its next prompt (the inbox hook) or when it runs "morse read". Not available yet, and
# "morse status" says so: LAN, pushing a message into a session, auto-update -
# to update, run this installer again.
#
# Rules this file keeps (test/install-ps1.test.ts checks them): ASCII only and no byte-order
# mark (Windows PowerShell 5.1 would misread anything else); never the word that ends the
# host process ("irm | iex" runs in YOUR terminal - a failure throws instead); no "&&" / "||"
# and nothing else newer than PowerShell 5.1; a native program's error output is never
# redirected (that turns it into a terminating error).
param(
  [string]$Target = $env:MORSE_JOIN,
  [string]$Code = $env:MORSE_CODE,
  [string]$Agent = $env:MORSE_AGENT,
  [string]$Name = $env:MORSE_NAME,
  [string]$Relay = $env:MORSE_RELAY,
  [string]$Site = $env:MORSE_SITE,
  [switch]$NoJoin,
  [switch]$NoService
)

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  # the release signing key (ADR-039), filled in by scripts/build-site.mjs when the site is built
  $ReleaseKey = '__MORSE_RELEASE_PUBLIC_KEY__'
  $DefaultSite = 'https://morse.im'
  $DefaultRelay = 'wss://relay.morse.im'
  $PackageName = 'anytoany'
  $MinNode = 22
  $InstallCommand = 'irm https://morse.im/install.ps1 | iex'

  function Say([string]$Text) { Write-Host $Text -ForegroundColor White }
  function Fail([string]$Text) { throw "Morse install: $Text" }
  function Write-Utf8([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false))) }

  # Run a program, its output on the console; returns its code. $ErrorActionPreference is
  # relaxed for the call: under 'Stop' some hosts turn a program's error output into a
  # terminating error.
  function Invoke-Shown([string]$Exe, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    & $Exe @Arguments | Out-Host
    return $LASTEXITCODE
  }
  # Run a program and keep what it prints (lines); its error output still goes to the console.
  function Invoke-Captured([string]$Exe, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $lines = @(& $Exe @Arguments)
    return New-Object PSObject -Property @{ Code = $LASTEXITCODE; Lines = $lines }
  }
  function Get-Download([string]$Url, [string]$OutFile) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile
      return $true
    } catch {
      return $false
    }
  }

  # --- options ----------------------------------------------------------------------
  if (-not $Site) { $Site = $DefaultSite }
  if (-not $Relay) { $Relay = $DefaultRelay }
  $Site = $Site.TrimEnd('/')
  $Relay = $Relay.TrimEnd('/')
  # compatibility (ADR-075): the old domain is retired
  if ($Site -eq 'https://morse.talk') { $Site = $DefaultSite }
  if ($Relay -eq 'wss://relay.morse.talk') { $Relay = $DefaultRelay }
  $skipJoin = $NoJoin.IsPresent -or ($env:MORSE_NO_JOIN -eq '1')
  $skipService = $NoService.IsPresent -or ($env:MORSE_NO_SERVICE -eq '1')

  # --- nothing to join (checked BEFORE anything is installed) ----------------------
  # (ADR-091) old names, invite codes and pairing codes are gone: every install gets its own address
  if ($Target -or $Code) {
    Fail "old names, invite codes and pairing codes no longer work - every install gets its own address. Run the installer without them ($InstallCommand), then add the others by their 26-character address: morse contact add morse.im/<address> --name <remark>"
  }

  # --- 0. platform ------------------------------------------------------------------
  if ($env:OS -ne 'Windows_NT') { Fail 'this is the Windows installer - on macOS / Linux run: curl -fsSL https://morse.im/install.sh | bash' }
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  if (($arch -ne 'AMD64') -and ($arch -ne 'ARM64')) { Fail "unsupported processor: $arch (64-bit Windows only)" }
  if ($arch -eq 'ARM64') { Write-Host 'Note: Windows on ARM is untested - it may work.' }
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch {
    # newer PowerShell: TLS 1.2+ is already the default
  }

  # --- 1. Node.js >= 22 (we do not install it for you) ------------------------------
  function Need-Node([string]$Found) {
    $have = ''
    if ($Found) { $have = " (found $Found)" }
    Write-Host "Morse needs Node.js $MinNode or newer$have. Install it, then run this command again:"
    Write-Host '    winget install OpenJS.NodeJS.LTS'
    Write-Host '    or the installer from https://nodejs.org (LTS)'
    Write-Host 'Then open a NEW PowerShell window (so it sees node) and run:'
    Write-Host "    $InstallCommand"
    Fail "Node.js $MinNode or newer is required$have"
  }
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $nodeCommand) { Need-Node '' }
  # THIS node installs the package (its native module is fetched for it) and runs the daemon.
  # Its real path: a version manager's "current" link would point elsewhere after a switch.
  $probe = Invoke-Captured $nodeCommand.Path @('-p', "require('fs').realpathSync(process.execPath)")
  if (($probe.Code -ne 0) -or (-not $probe.Lines)) { Need-Node 'a node that does not run' }
  $Node = ([string]$probe.Lines[0]).Trim()
  $probe = Invoke-Captured $Node @('-p', 'process.versions.node')
  $nodeVersion = ''
  if ($probe.Lines) { $nodeVersion = ([string]$probe.Lines[0]).Trim() }
  $nodeMajor = 0
  if ($nodeVersion -match '^(\d+)\.') { $nodeMajor = [int]$Matches[1] }
  if ($nodeMajor -lt $MinNode) { Need-Node "v$nodeVersion" }
  # the npm that belongs to this node, run BY this node - never npm.cmd / npm.ps1 (the script
  # policy may block the latter, and neither can be started without a shell)
  $NpmCli = ''
  foreach ($dir in @((Split-Path -Parent $Node), (Split-Path -Parent $nodeCommand.Path))) {
    $candidate = Join-Path $dir 'node_modules\npm\bin\npm-cli.js'
    if ((-not $NpmCli) -and (Test-Path -LiteralPath $candidate)) { $NpmCli = $candidate }
  }
  if (-not $NpmCli) { Fail "the Node.js at $Node has no npm next to it (node_modules\npm\bin\npm-cli.js) - install Node.js from https://nodejs.org or with winget, then run this again" }

  $homeDir = $env:USERPROFILE
  if ($env:MORSE_HOME) { $homeDir = $env:MORSE_HOME }
  $dataDir = Join-Path $homeDir '.morse'

  $tmp = Join-Path $env:TEMP ('morse-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $serviceFailed = $false
  try {
    # --- 2. the morse package, checked against the signed manifest -------------------
    $tgz = Join-Path $tmp 'morse.tgz'
    $manifest = Join-Path $tmp 'version.json'
    $signature = Join-Path $tmp 'version.json.sig'
    Say "Downloading Morse from $Site/morse.tgz ..."
    if (-not (Get-Download "$Site/morse.tgz" $tgz)) { Fail "could not download $Site/morse.tgz" }
    # ADR-039 / ADR-080: nothing is installed without the signature check - not from a copy of
    # this script that the site build did not stamp with the key, not from a site without a manifest
    if ($ReleaseKey.StartsWith('__')) { Fail "this copy of install.ps1 carries no release key (it was not built by the Morse site), so the download cannot be checked - nothing was installed. Use: $InstallCommand" }
    if ((-not (Get-Download "$Site/version.json" $manifest)) -or (-not (Get-Download "$Site/version.json.sig" $signature))) {
      Fail "$Site has no signed release manifest (version.json + version.json.sig) - nothing was installed"
    }
    # the same check as install.sh, by the same node (a file, not "node -e": no quoting to get wrong)
    $verifyJs = @'
const [key, mf, sf, tf] = process.argv.slice(2);
const c = require("crypto"), fs = require("fs");
const pub = c.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key, "base64")]), format: "der", type: "spki" });
const bytes = fs.readFileSync(mf);
const sig = Buffer.from(fs.readFileSync(sf, "utf8").trim(), "base64");
let ok = false;
try { ok = c.verify(null, Buffer.concat([Buffer.from("morse-release-v1\n"), bytes]), pub, sig); } catch {}
if (!ok) { console.error("the release manifest (version.json) is not signed by the Morse release key"); process.exit(1); }
const m = JSON.parse(bytes.toString("utf8"));
const sha = c.createHash("sha256").update(fs.readFileSync(tf)).digest("hex");
if (sha !== m.sha256) { console.error("morse.tgz does not match the signed manifest (sha256 " + sha.slice(0, 16) + "...)"); process.exit(1); }
console.log("signature OK: " + m.version + " release " + m.release);
'@
    $verifyFile = Join-Path $tmp 'verify.js'
    Write-Utf8 $verifyFile $verifyJs
    if ((Invoke-Shown $Node @($verifyFile, $ReleaseKey, $manifest, $signature, $tgz)) -ne 0) {
      Fail "refusing to install: the download from $Site failed the signature check (try again in a minute - the site may be mid-update)"
    }

    $prefixAnswer = Invoke-Captured $Node @($NpmCli, 'prefix', '-g')
    if (($prefixAnswer.Code -ne 0) -or (-not $prefixAnswer.Lines)) { Fail '"npm prefix -g" did not answer' }
    $prefix = ([string]$prefixAnswer.Lines[0]).Trim()
    $entry = Join-Path $prefix "node_modules\$PackageName\dist\cli.js"

    # an upgrade: stop the running daemon FIRST - Windows does not let npm replace the native
    # modules a running process has loaded
    if (Test-Path -LiteralPath $entry) {
      Say 'Stopping the running Morse daemon ...'
      Invoke-Captured $Node @($entry, 'stop') | Out-Null
      $pidFile = Join-Path $dataDir 'daemon.pid'
      for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-Path -LiteralPath $pidFile)) { break }
        $daemonPid = 0
        [void][int]::TryParse(([IO.File]::ReadAllText($pidFile)).Trim(), [ref]$daemonPid)
        if (($daemonPid -le 0) -or (-not (Get-Process -Id $daemonPid -ErrorAction SilentlyContinue))) { break }
        Start-Sleep -Milliseconds 500
      }
    }

    Say "Installing (npm install -g, node $Node) ..."
    if ((Invoke-Shown $Node @($NpmCli, 'install', '-g', '--no-fund', '--no-audit', $tgz)) -ne 0) {
      Write-Host 'If the error above is EPERM / EBUSY: a running Morse still has its files open. Close the terminals and'
      Write-Host 'agents that are running "morse", end leftover node.exe processes in Task Manager, then run this again.'
      Fail '"npm install -g" failed (see above)'
    }
    if (-not (Test-Path -LiteralPath $entry)) { Fail "installed, but $entry is missing" }

    # its native module must load in the node that will run it
    $abiFile = Join-Path $tmp 'abi.js'
    Write-Utf8 $abiFile 'const r = require("module").createRequire(process.argv[2]); new (r("better-sqlite3"))(":memory:").close();'
    if ((Invoke-Shown $Node @($abiFile, $entry)) -ne 0) {
      Fail "installed, but its database module does not load in $Node (v$nodeVersion) - Morse on Windows needs Node.js $MinNode or newer from nodejs.org or winget"
    }

    # PowerShell picks morse.ps1 before morse.cmd, and the default script policy blocks .ps1
    # files - with only morse.cmd left, "morse" works in PowerShell and in cmd alike
    foreach ($shim in @('morse.ps1', 'anyd.ps1')) {
      $shimPath = Join-Path $prefix $shim
      try {
        if (Test-Path -LiteralPath $shimPath) { Remove-Item -LiteralPath $shimPath -Force }
      } catch {
        Write-Host "Note: could not remove $shimPath - if PowerShell refuses to run `"morse`", use morse.cmd"
      }
    }

    # --- 3. skill + hooks -------------------------------------------------------------
    Say 'Setting up your agents (skill + inbox hooks) ...'
    if ((Invoke-Shown $Node @($entry, 'setup')) -ne 0) { Fail '"morse setup" failed (see above) - nothing else was done' }
    # a (re)install trusts the release key pinned in the build just installed (ADR-041)
    $followedKey = Join-Path $dataDir 'release-key.json'
    if (Test-Path -LiteralPath $followedKey) { Remove-Item -LiteralPath $followedKey -Force }
    # (-Name / -Agent are accepted and ignored: ADR-091 - there is no device name or address name to give at install)
    # installed from another site (a mirror, a test site): remember it (ADR-039)
    if ($Site -ne $DefaultSite) {
      $siteJs = @'
const fs = require("fs"), f = process.argv[2], site = process.argv[3];
let c = {}; try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
if (!c || typeof c !== "object" || Array.isArray(c)) c = {};
c.update = Object.assign({}, c.update, { site });
fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
'@
      $siteFile = Join-Path $tmp 'site.js'
      Write-Utf8 $siteFile $siteJs
      if ((Invoke-Shown $Node @($siteFile, (Join-Path $dataDir 'config.json'), $Site)) -ne 0) { Write-Host 'Note: could not record update.site in config.json' }
    }

    # --- 4. your address -------------------------------------------------------------
    # Does this computer have an address? Read from config.json (the list of its addresses) - never asked of a
    # morse command: "morse address" CREATES one on a computer that has none, behind -NoJoin's back.
    function Test-Address {
      $configFile = Join-Path $dataDir 'config.json'
      if (-not (Test-Path -LiteralPath $configFile)) { return $false }
      try {
        $config = [IO.File]::ReadAllText($configFile) | ConvertFrom-Json
        if ($config.relay -and $config.relay.agents -and @($config.relay.agents).Count -gt 0) { return $true }
      } catch {
        # an unreadable config.json: treated as no address yet; "morse address" reports what is wrong
      }
      return $false
    }
    if ((-not $skipJoin) -and (-not (Test-Address))) {
      # (ADR-091) made here, from a key made here - nothing is registered with the relay
      Say 'Making your Morse address ...'
      if ((Invoke-Shown $Node @($entry, 'address')) -ne 0) { Fail 'could not make your address (see above). Morse is installed - retry: morse address' }
    }
    $address = ''
    # only on a computer that has one: "morse address" would create an address otherwise
    if (Test-Address) {
      $answer = Invoke-Captured $Node @($entry, 'address')
      foreach ($line in $answer.Lines) {
        if ((-not $address) -and (([string]$line) -match '^address:\s+(\S+)')) { $address = $Matches[1] }
      }
    }

    # --- 5. the daemon: now, and at every logon ---------------------------------------
    $serviceNote = 'start the daemon: morse start --background'
    if (-not $skipService) {
      Say 'Starting the daemon (now, and every time you log on) ...'
      # a daemon still running from ANOTHER install (an earlier Node or npm prefix) was not at $entry
      # before the install, so the stop above did not reach it: the new package stops it now
      Invoke-Captured $Node @($entry, 'stop') | Out-Null
      $registered = ((Invoke-Shown $Node @($entry, 'autostart', 'enable')) -eq 0)
      if ((Invoke-Shown $Node @($entry, 'start', '--background')) -eq 0) {
        $serviceNote = 'daemon: running in the background (log: ' + (Join-Path $dataDir 'daemon.log') + '). It stops when you log off; the relay keeps your mail meanwhile.'
      } else {
        $serviceFailed = $true
        $serviceNote = 'PROBLEM: the daemon is not running - see above. After fixing it: morse start --background'
      }
      if (-not $registered) {
        $serviceFailed = $true
        $serviceNote = $serviceNote + ' PROBLEM: the logon start could not be registered (see above) - the daemon will not start by itself; retry: morse autostart enable'
      }
    }

    # --- done -------------------------------------------------------------------------
    Write-Host ''
    Say 'Morse is installed.'
    if (Test-Address) {
      if ($address) {
        Write-Host "  Your address: $address - send it to your friends."
      } else {
        Write-Host '  Your address: run  morse address  to see it - that is the one to send to your friends.'
      }
      Write-Host '  Name your contacts: morse contact add morse.im/<address> --name <remark>'
      Write-Host '  Try telling your agent: "use Morse to send a line to morse.im/<their-address>"'
    } else {
      Write-Host '  No address yet: run  morse address  to get your own.'
    }
    Write-Host '  Receive: morse read   Send: morse send morse.im/<address> "..."   Your addresses: morse address'
    Write-Host '  Text with quotes, %, & or line breaks: write it to a UTF-8 file and use  morse send <address> --text-file <file>'
    Write-Host "  Note: a stranger's first message goes to your message requests, not your inbox: morse contact"
    Write-Host '  Codex: a new hook runs only after you trust it - open /hooks in Codex (or Settings > Hooks) and trust the Morse entry.'
    Write-Host '  This release is pull-only on Windows: a message reaches an agent at its next prompt, or when it runs: morse read'
    Write-Host "  Not available on Windows yet (morse status lists them): LAN, pushing into a session, auto-update."
    Write-Host "  To update Morse, run this installer again: $InstallCommand"
    Write-Host "  $serviceNote"
    Write-Host '  Check this computer: morse status --check'
    # is "morse" on PATH for a new terminal?
    $onPath = $false
    foreach ($scope in @('User', 'Machine')) {
      foreach ($part in ([string][Environment]::GetEnvironmentVariable('Path', $scope)).Split(';')) {
        if ($part.Trim().TrimEnd('\') -ieq $prefix.TrimEnd('\')) { $onPath = $true }
      }
    }
    if (-not $onPath) {
      Write-Host "  PATH: $prefix is not on your PATH, so `"morse`" is not found yet. Add it with:"
      Write-Host "      [Environment]::SetEnvironmentVariable('Path', '$prefix;' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
      Write-Host '    then open a NEW terminal - and restart Codex / Claude so they see it.'
    } else {
      Write-Host '  Open a NEW terminal for the "morse" command (and restart Codex / Claude if they do not find it).'
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($serviceFailed) { Fail 'Morse is installed, but the daemon needs attention (see PROBLEM above)' }
}
