import assert from "assert";
import { buildFlexQuoteUrl, isFlexElementId, parseFlexQuoteUrl } from "./flex-quote-link.mjs";

const elementId = "85141d01-8008-4d29-8fc2-1749159e35e0";
const expected = "https://m2.flexrentalsolutions.com/f5/ui/#fin-doc/85141d01-8008-4d29-8fc2-1749159e35e0/doc-view/ca6b072c-b122-11df-b8d5-00e08175e43e/header";
assert.equal(buildFlexQuoteUrl(elementId), expected, "builds the verified Music Matters FLEX quote deep link");
assert(isFlexElementId(elementId), "accepts a FLEX UUID");
assert.throws(() => buildFlexQuoteUrl("26-1595"), /valid FLEX quote element ID/, "never substitutes a document number where an element ID is required");
assert.throws(() => buildFlexQuoteUrl(elementId, { webBaseUrl: "http://example.com" }), /must use HTTPS/, "rejects insecure redirect bases");
assert.equal(parseFlexQuoteUrl(expected).elementId, elementId, "extracts the verified FLEX element ID from a pasted quote URL");
assert.throws(() => parseFlexQuoteUrl(expected.replace("m2.flexrentalsolutions.com", "evil.example.com")), /authorized/, "rejects a different FLEX tenant or hostile host");
assert.throws(() => parseFlexQuoteUrl(expected.replace("/f5/ui/", "/other/")), /authorized/, "rejects a same-tenant URL outside the configured FLEX application path");
console.log(JSON.stringify({ ok: true, expected }, null, 2));
