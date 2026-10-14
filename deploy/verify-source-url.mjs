// Release gate for the AGPL source offer. A public build must carry a link to the public
// source of exactly what it runs. This checks the shape of the link (https, no credentials,
// no query) and, with --online, that anyone can fetch it without signing in. A private
// repository does not satisfy it, and neither does an unreachable address.
const [, , raw, flag] = process.argv;

function fail(message) {
  console.error(`[source-url] ${message}`);
  process.exit(1);
}

if (!raw) fail("usage: verify-source-url.mjs <https-url> [--online]");
let url;
try {
  url = new URL(raw);
} catch {
  fail("not a valid URL");
}
if (url.protocol !== "https:") fail("must use https://");
if (url.username !== "" || url.password !== "") fail("must not contain credentials");
if (url.search !== "" || url.hash !== "") fail("must not have a query or fragment");
if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".local")) {
  fail("must be a public address");
}

if (flag === "--online") {
  let response = null;
  let problem = "";
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
  } catch (error) {
    problem = `could not be fetched: ${error.message}`;
  }
  // An anonymous request to a private repository is answered 404 (or redirected to sign-in).
  if (response && (response.status !== 200 || /\/(login|signin|sign_in)/.test(new URL(response.url).pathname))) {
    problem = `is not publicly readable (anonymous request got ${response.status})`;
  }
  if (problem) {
    console.error(`[source-url] ${problem}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`[source-url] ok: ${url.href}`);
