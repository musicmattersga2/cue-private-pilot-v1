import assert from "assert";
import {
  buildFlexQuoteUrl,
  inferFlexDocumentType,
  isFlexElementId,
  parseFlexQuoteUrl,
  selectFlexDocumentCandidate,
  selectPrimaryShowQuote,
} from "./flex-quote-link.mjs";

const elementId = "85141d01-8008-4d29-8fc2-1749159e35e0";
const expected = "https://m2.flexrentalsolutions.com/f5/ui/#fin-doc/85141d01-8008-4d29-8fc2-1749159e35e0/doc-view/ca6b072c-b122-11df-b8d5-00e08175e43e/header";
assert.equal(buildFlexQuoteUrl(elementId), expected, "builds the verified Music Matters FLEX quote deep link");
assert(isFlexElementId(elementId), "accepts a FLEX UUID");
assert.throws(() => buildFlexQuoteUrl("26-1595"), /valid FLEX quote element ID/, "never substitutes a document number where an element ID is required");
assert.throws(() => buildFlexQuoteUrl(elementId, { webBaseUrl: "http://example.com" }), /must use HTTPS/, "rejects insecure redirect bases");
assert.equal(parseFlexQuoteUrl(expected).elementId, elementId, "extracts the verified FLEX element ID from a pasted quote URL");
assert.throws(() => parseFlexQuoteUrl(expected.replace("m2.flexrentalsolutions.com", "evil.example.com")), /authorized/, "rejects a different FLEX tenant or hostile host");
assert.throws(() => parseFlexQuoteUrl(expected.replace("/f5/ui/", "/other/")), /authorized/, "rejects a same-tenant URL outside the configured FLEX application path");

const moonchildQuoteId = "826adc32-f11e-4d12-bd31-ecaa3f7bfe00";
const moonchildShortUrl = "https://m2.flexrentalsolutions.com/f5/ui/#fin-doc/826adc32-f11e-4d12-bd31-ecaa3f7bfe00";
assert.equal(parseFlexQuoteUrl(moonchildShortUrl).elementId, moonchildQuoteId, "accepts the canonical short FLEX financial-document URL copied from the browser");
assert.equal(parseFlexQuoteUrl(moonchildShortUrl).normalizedUrl, moonchildShortUrl, "preserves a verified short FLEX URL without inventing a document view");
assert.equal(
  buildFlexQuoteUrl(moonchildQuoteId),
  "https://m2.flexrentalsolutions.com/f5/ui/#fin-doc/826adc32-f11e-4d12-bd31-ecaa3f7bfe00/doc-view/ca6b072c-b122-11df-b8d5-00e08175e43e/header",
  "builds the canonical Moonchild quote link from its verified UUID"
);
assert.equal(inferFlexDocumentType("MMP Quote"), "quote", "classifies a parent MMP quote");
assert.equal(inferFlexDocumentType("Ps Live Nation Moonchild pull sheet"), "pull_sheet", "classifies a child pull sheet");

const duplicateNumberCandidates = [
  { elementId: "11111111-1111-4111-8111-111111111111", documentNumber: "26-0836", documentType: "quote", showName: "Livestream / Teleprompter - Dynamize - East Miami", client: "Dynamize Productions" },
  { elementId: "22222222-2222-4222-8222-222222222222", documentNumber: "26-0836", documentType: "pull_sheet", showName: "Live Nation Moonchild @ The Fox", client: "Live Nation" },
];
const moonchildPullSheet = selectFlexDocumentCandidate(duplicateNumberCandidates, { showName: "Live Nation Moonchild @ The Fox", client: "Live Nation" });
assert.equal(moonchildPullSheet.candidate?.documentType, "pull_sheet", "show identity disambiguates the Moonchild pull sheet from an unrelated quote with the same number");
assert.equal(selectFlexDocumentCandidate(duplicateNumberCandidates).candidate, null, "a duplicate FLEX number is never guessed without show identity");

const sameShowHierarchyCandidates = [
  { elementId: moonchildQuoteId, documentNumber: "26-1846", documentType: "quote", showName: "Live Nation Moonchild @ The Fox", client: "Live Nation" },
  { elementId: "22222222-2222-4222-8222-222222222222", documentNumber: "26-0836", documentType: "pull_sheet", showName: "Live Nation Moonchild @ The Fox", client: "Live Nation" },
];
assert.equal(
  selectFlexDocumentCandidate(sameShowHierarchyCandidates, { showName: "Live Nation Moonchild @ The Fox", client: "Live Nation", documentType: "quote" }).candidate?.documentNumber,
  "26-1846",
  "an explicit parent-quote lookup filters out same-show child pull sheets before ambiguity scoring"
);

const moonchildPrimary = selectPrimaryShowQuote([
  { status: "Verified", elementId: "22222222-2222-4222-8222-222222222222", documentNumber: "26-0836", documentType: "pull_sheet", showName: "Live Nation Moonchild @ The Fox" },
  { status: "Verified", elementId: moonchildQuoteId, documentNumber: "26-1846", documentType: "quote", showName: "Live Nation Moonchild @ The Fox", client: "Live Nation" },
], { showName: "Live Nation Moonchild @ The Fox", client: "Live Nation" });
assert.equal(moonchildPrimary?.documentNumber, "26-1846", "parent quote wins over its child pull sheet as the canonical show quote");
const opaqueMoonchildPrimary = selectPrimaryShowQuote([
  { status: "Verified", elementId: "22222222-2222-4222-8222-222222222222", parentElementId: moonchildQuoteId, documentNumber: "26-0836", documentType: "unknown", showName: "Live Nation Moonchild @ The Fox" },
  { status: "Verified", elementId: moonchildQuoteId, parentElementId: null, documentNumber: "26-1846", documentType: "unknown", showName: "Live Nation Moonchild @ The Fox" },
], { showName: "Live Nation Moonchild @ The Fox" });
assert.equal(opaqueMoonchildPrimary?.documentNumber, "26-1846", "tree parent identity breaks ties when FLEX returns opaque document type codes");
assert.equal(
  selectPrimaryShowQuote([
    { status: "Verified", elementId: "22222222-2222-4222-8222-222222222222", parentElementId: moonchildQuoteId, documentNumber: "26-0836", documentType: "unknown", showName: "Live Nation Moonchild @ The Fox" },
  ], { showName: "Live Nation Moonchild @ The Fox" }),
  null,
  "an opaque child pull sheet is never promoted to the canonical show quote"
);

const liteFlairPrimary = selectPrimaryShowQuote([
  { status: "Verified", elementId: "33333333-3333-4333-8333-333333333333", documentNumber: "26-1790", documentType: "quote", showName: "LiteFlair Shoot" },
], { showName: "Lite Flair Shoot" });
assert.equal(liteFlairPrimary?.documentNumber, "26-1790", "a unique normalized LiteFlair name carries its verified FLEX quote into Intake");
console.log(JSON.stringify({ ok: true, expected }, null, 2));
