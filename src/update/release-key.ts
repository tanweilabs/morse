/**
 * The Morse release signing key (ADR-039), pinned into every client.
 *
 * Auto-update installs a new morse.tgz only when the site's version.json carries an
 * Ed25519 signature that verifies against the client's trusted key: THIS public key, or
 * a newer one reached from it through the signed key-rotation chain (ADR-041). The
 * private key lives only in the release machine's macOS Keychain (service
 * "morse-release-signing", generation N >= 1: "morse-release-signing-gen<N>"); a
 * compromised morse.im site alone cannot push code to installed clients.
 *
 * Format: base64 of the raw 32-byte Ed25519 public key.
 *
 * >>> Set once by `npm run release:key`; changed only by `npm run release:rotate-key`
 * >>> (which rewrites RELEASE_PUBLIC_KEY and RELEASE_KEY_GENERATION below and appends to
 * >>> site/keys/rotations.json). scripts/build-site.mjs refuses to build a release while
 * >>> these do not match the Keychain key and the rotation chain.
 */
export const RELEASE_KEY_PLACEHOLDER = 'MORSE-RELEASE-PUBLIC-KEY-NOT-SET';

// pinned-release-key (build-site.mjs reads and checks the next line — keep it on one line)
export const RELEASE_PUBLIC_KEY: string = 'kkI8CejF5tT4QHAeEPQ2PVR2uYf91hDeXSChdh1FcoI=';

/**
 * Generation of RELEASE_PUBLIC_KEY in the rotation chain (ADR-041): 0 = the first key;
 * N = the key introduced by the N-th rotation (site/keys/rotations.json has N links).
 */
// pinned-release-key-generation (build-site.mjs reads and checks the next line — keep it on one line)
export const RELEASE_KEY_GENERATION: number = 0;

/** Signed bytes = this context string + the exact bytes of version.json (domain separation). */
export const RELEASE_SIGNATURE_CONTEXT = 'morse-release-v1\n';

/** Signed bytes of a rotation statement = this context string + the statement bytes (ADR-041). */
export const ROTATION_SIGNATURE_CONTEXT = 'morse-key-rotation-v1\n';

/** Where a site publishes the rotation chain (ADR-041). */
export const ROTATION_CHAIN_PATH = 'keys/rotations.json';

/** The release Mac's Keychain item that holds the private key of generation `gen` (ADR-041). */
export const KEYCHAIN_SERVICE = 'morse-release-signing';
export const keychainServiceFor = (gen: number): string => (gen === 0 ? KEYCHAIN_SERVICE : `${KEYCHAIN_SERVICE}-gen${gen}`);

/** The launchd label / systemd unit install.sh sets up (ADR-035) — what auto-update restarts.
 *  Compatibility: the label keeps the old domain's reverse-DNS form (`talk.morse`); it names the
 *  service on every installed computer, so it does not change with the domain (ADR-075). */
export const LAUNCHD_LABEL = 'talk.morse.daemon';
export const SYSTEMD_UNIT = 'morse.service';

/** Where the site is unless MORSE_SITE / update.site say otherwise (same default as install.sh). */
export const DEFAULT_SITE = 'https://morse.im';
