import assert from "assert";
import { buildFlexQuoteUrl, isFlexElementId } from "./flex-quote-link.mjs";

const elementId = "85141d01-8008-4d29-8fc2-1749159e35e0";
const expected = "https://m2.flexrentalsolutions.com/f5/ui/#fin-doc/85141d01-8008-4d29-8fc2-1749159e35e0/doc-view/ca6b072c-b122-11df-b8d5-00e08175e43e/header";
assert.equal(buildFlexQuoteUrl(elementId), expected, "builds the verified Music Matters FLEX quote deep link");
assert(isFlexElementId(elementId), "accepts a FLEX UUID");
assert.throws(() => buildFlexQuoteUrl("26-1595"), /valid FLEX quote element ID/, "never substitutes a document number where an element ID is required");
assert.throws(() => buildFlexQuoteUrl(elementId, { webBaseUrl: "http://example.com" }), /must use HTTPS/, "rejects insecure redirect bases");
console.log(JSON.stringify({ ok: true, expected }, null, 2));
