// A push subscription endpoint is a URL this server will later POST to, and it
// arrives from the browser -- which means from anyone who can authenticate.
// Stored unchecked it is a blind SSRF primitive: register
// http://10.0.0.5:8080/x and the API makes requests to internal hosts, from
// inside the cluster, on a schedule the attacker doesn't even need to control.
//
// The defence is an allowlist of the real push services rather than a
// block-list of private ranges. A block-list can be walked around with DNS
// rebinding (resolve public on validation, private on send); an attacker
// cannot make fcm.googleapis.com resolve anywhere they choose.
const ALLOWED_PUSH_HOSTS = [
  // Chrome, Edge, Brave, Opera, Samsung Internet
  "fcm.googleapis.com",
  "android.googleapis.com",
  // Firefox
  "updates.push.services.mozilla.com",
];

// Vendors that shard across subdomains. Matched as a suffix, so
// "web.push.apple.com" passes and "push.apple.com.attacker.test" does not.
const ALLOWED_PUSH_HOST_SUFFIXES = [
  ".push.apple.com",
  ".notify.windows.com",
  ".push.services.mozilla.com",
];

export function isAllowedPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }

  // Plain http would also let an attacker reach anything the pod can.
  if (url.protocol !== "https:") {
    return false;
  }

  // Credentials in the URL are never part of a real push endpoint and would be
  // sent onward on every notification.
  if (url.username || url.password) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();

  // No push service is ever addressed by a bare IP, and allowing one would
  // reopen the internal-network path the allowlist exists to close.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
    return false;
  }

  if (ALLOWED_PUSH_HOSTS.includes(hostname)) {
    return true;
  }

  return ALLOWED_PUSH_HOST_SUFFIXES.some((suffix) =>
    hostname.endsWith(suffix),
  );
}

// Shared with the migration that sweeps rows stored before this check existed.
export const ALLOWED_PUSH_HOST_LIST = ALLOWED_PUSH_HOSTS;
export const ALLOWED_PUSH_HOST_SUFFIX_LIST = ALLOWED_PUSH_HOST_SUFFIXES;
